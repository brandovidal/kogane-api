import { statementBalances, emptyStatementBalance } from './statement.balance'
import { Injectable, Logger } from '@nestjs/common'

import { AiOperation } from '@/commons/constants/ai.constant'
import { DebtDirection, toCents } from '@/commons/constants/debt.constant'
import { Currency, PaymentStatus } from '@/commons/constants/expense.constant'
import { NotificationKind, NotificationRefType } from '@/commons/constants/notification.constant'
import { StatementRowResult, StatementSource, StatementStatus } from '@/commons/constants/statement.constant'
import { PaymentMethodType } from '@/commons/constants/catalog.constant'
import { StatementPasswordException } from '@/commons/exceptions/statement/statement-password.exception'
import { StatementUnreadableException } from '@/commons/exceptions/statement/statement-unreadable.exception'
import { addMonths, PaymentPeriod } from '@/commons/helpers/payment-period.helper'
import { CardHolderDBRepository } from '@/db/models/card-holder/cardHolderDB.repository'
import { PaymentMethodDBRepository } from '@/db/models/payment-method/paymentMethodDB.repository'
import { PersonDbDto } from '@/db/models/person/personDB.dto'
import { PersonDBRepository } from '@/db/models/person/personDB.repository'
import { StatementDBRepository } from '@/db/models/statement/statementDB.repository'
import { ExpenseExtractionService } from '@/modules/expense-extraction/expense-extraction.service'
import { NotificationsService } from '@/modules/notifications/notifications.service'
import { StoredFilesService } from '@/modules/stored-files/stored-files.service'
import { MONTH_NAMES } from '@/modules/conversation/conversation.messages'

import { readPdfLines } from './statement-pdf.reader'
import {
  detectCardHint,
  lockCancelledStatementRows,
  maskForAi,
  ParsedStatement,
  parseStatementLines,
  templateAddsUp,
} from './statement.parser'
import { fromAi, STATEMENT_INSTRUCTIONS, statementAiJsonSchema, statementAiSchema } from './statement.prompt'
import { assignRowPeople, inferHolder, matchCard, rowHolderHints } from './statement.identity'
import { CardExpenseForMatch, reconcileStatement } from './statement.reconcile'

export interface StatementUpload {
  data: Buffer
  password?: string | null // when the saved document number does not open it
  paymentMethodId?: string | null // when the text does not say which card
  personId?: string | null // manual assignment takes precedence over the PDF hint
  savePassword?: boolean // the typed password becomes the document number of the statement's person (D94)
}

const day = (isoDay: string | null) => (isoDay ? new Date(`${isoDay}T00:00:00.000Z`) : null)
const isoOf = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null)
const periodOfDay = (isoDay: string): PaymentPeriod => ({
  paymentMonth: Number(isoDay.slice(5, 7)),
  paymentYear: Number(isoDay.slice(0, 4)),
})

const ITEMIZED_CARD_CHARGE =
  /\b(seguro( de)? desgravamen|desgravamen|interes(es)?|comision(es)?|membresia|itf|mora|moratorio|penalidad)\b/i

// "Resumen de movimientos y pagos del mes" the bank prints (saldo anterior, abonos, consumos con y sin cuotas,
// intereses…): previousBalance/previousPayments/totalDue/minimumDue already come from the balance the PDF stated;
// these three are computed from the rows already saved, so they never drift from what the statement detail shows
function paymentSummaryOf(
  rows: { description: string; amount: number; currency: string; installment: string | null }[],
  currency: string,
) {
  const ofCurrency = rows.filter((row) => row.currency === currency)
  const itemized = ofCurrency.filter((row) => ITEMIZED_CARD_CHARGE.test(row.description))
  const consumption = ofCurrency.filter((row) => !ITEMIZED_CARD_CHARGE.test(row.description))
  const sum = (list: { amount: number }[]) => toCents(list.reduce((total, row) => total + row.amount, 0))
  return {
    directConsumption: sum(consumption.filter((row) => row.installment == null)),
    installmentConsumption: sum(consumption.filter((row) => row.installment != null)),
    itemizedCharges: sum(itemized),
  }
}

const rowKey = (row: {
  date: string | null
  description: string
  amount: number
  currency: string
  installment?: string | null
}) =>
  `${row.currency}|${row.installment ?? ''}|${row.date ?? ''}|${toCents(row.amount)}|${row.description
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()}`

// Bank statements (P14 block 2, D95): the PDF is opened with a saved document number (D94), read by a template
// or the AI (only its text), saved row by row and reconciled with the card expenses of its payment month
@Injectable()
export class StatementsService {
  private readonly logger = new Logger(StatementsService.name)

  constructor(
    private readonly statementDBRepository: StatementDBRepository,
    private readonly paymentMethodDBRepository: PaymentMethodDBRepository,
    private readonly personDBRepository: PersonDBRepository,
    private readonly expenseExtractionService: ExpenseExtractionService,
    private readonly storedFilesService: StoredFilesService,
    private readonly notificationsService: NotificationsService,
    private readonly cardHolderDBRepository: CardHolderDBRepository,
  ) {}

  async upload({ data, password, paymentMethodId, personId, savePassword }: StatementUpload) {
    const [owner, people] = await Promise.all([
      this.personDBRepository.findDefault(),
      this.personDBRepository.findActive(),
    ])
    if (personId && !people.some((person) => person.id === personId)) {
      throw new StatementUnreadableException({ reason: 'selected person not found' })
    }
    const opened = await this.openPdf(data, password, personId ?? null, owner, people)
    const { lines } = opened
    const { parsed, source } = await this.read(lines, opened.password)
    // The chosen person, else the holder the PDF names, else whose document number opened it, else the owner
    const assignedPersonId =
      personId ?? inferHolder(people, lines, parsed.holderName)?.id ?? opened.personId ?? owner?.id
    if (!assignedPersonId) throw new StatementUnreadableException({ reason: 'no person to assign' })
    if (savePassword && password && opened.password === password) {
      await this.personDBRepository.update(assignedPersonId, { documentNumber: password })
    }

    const card = await this.cardOf(paymentMethodId ?? null, parsed, lines)
    const period = this.periodOf(parsed, card)
    const [currentExpenses, previousExpenses, holders] = await Promise.all([
      this.cardExpenses(card.id, period),
      this.cardExpenses(card.id, addMonths(period, -1)),
      this.cardHolderDBRepository.findByCard(card.id),
    ])
    // Statement rows may include a purchase recorded against the previous payment month.
    // Use both months to match, while statement detail still reports only current-month expenses as missing.
    const matchCandidates = [...currentExpenses, ...previousExpenses]
    const { rows } = reconcileStatement(parsed.rows, matchCandidates)
    // Whose each purchase is: its section (CMR), its TIT/ADIC mark (Sip) or the titular (D116)
    const inferredPeople = assignRowPeople(rows, rowHolderHints(lines, rows), {
      titularId: assignedPersonId,
      holders,
      people,
    })
    const expensePeople = new Map(matchCandidates.map((expense) => [expense.id, expense.personId ?? null]))
    const rowPeople = rows.map((row, index) =>
      row.expenseId ? (expensePeople.get(row.expenseId) ?? inferredPeople[index]) : inferredPeople[index],
    )

    const fileId = await this.keepFile(data)
    const statement = await this.statementDBRepository.create({
      balances: statementBalances(parsed),
      paymentMethodId: card.id,
      personId: assignedPersonId,
      ...period,
      periodEnd: day(parsed.periodEnd),
      dueDate: day(parsed.dueDate),
      totalDue: parsed.totalDue,
      minimumDue: parsed.minimumDue,
      previousBalance: parsed.previousBalance,
      previousPayments: parsed.previousPayments,
      monthlyPayment: parsed.monthlyPayment,
      currency: parsed.currency,
      source,
      fileId,
      status: rows.some((row) => row.result === StatementRowResult.NEW) ? StatementStatus.REVIEW : StatementStatus.DONE,
      rows: rows.map((row, index) => ({
        date: day(row.date),
        description: row.description,
        amount: row.amount,
        currency: row.currency,
        installment: row.installment,
        locked: row.locked ?? false,
        result: row.result,
        expenseId: row.expenseId,
        personId: rowPeople[index],
      })),
    })

    const view = await this.get(statement.id)
    await this.notify(view).catch((error: Error) => this.logger.warn(`[upload] notice not sent: ${error.message}`))
    return view
  }

  // The statement with its rows, the card expenses of the month that are not in it, and both totals
  async get(id: string) {
    const statement = await this.statementDBRepository.findById(id)
    const period = { paymentMonth: statement.paymentMonth, paymentYear: statement.paymentYear }
    const [expenses, card] = await Promise.all([
      this.cardExpenses(statement.paymentMethodId, period),
      this.paymentMethodDBRepository.findById(statement.paymentMethodId),
    ])
    const linked = new Set(statement.rows.map((row) => row.expenseId).filter(Boolean))
    const personOfExpense = new Map(expenses.map((expense) => [expense.id, expense.personId ?? null]))
    const savedBalances = statementBalances(statement)
    const currencies = new Set([
      ...savedBalances.map((balance) => balance.currency),
      ...expenses.map((expense) => expense.currency ?? Currency.PEN),
      ...statement.rows.map((row) => row.currency),
    ])
    const balances = [...currencies].sort().map((currency) => {
      const balance = savedBalances.find((item) => item.currency === currency) ?? emptyStatementBalance(currency)
      const koganeTotal = toCents(
        expenses
          .filter((expense) => (expense.currency ?? Currency.PEN) === currency)
          .reduce((sum, expense) => sum + expense.amount, 0),
      )
      return {
        ...balance,
        koganeTotal,
        difference: balance.totalDue == null ? null : toCents(balance.totalDue - koganeTotal),
        ...paymentSummaryOf(statement.rows, currency),
      }
    })
    const primary = balances.find((balance) => balance.currency === (statement.currency ?? Currency.PEN)) ?? balances[0]
    const koganeTotal = primary.koganeTotal
    return {
      ...statement,
      balances,
      // Whose each purchase is: its expense's person once matched or created, else the one chosen, else the statement's
      rows: statement.rows.map((row) => ({
        ...row,
        personId: (row.expenseId && personOfExpense.get(row.expenseId)) || row.personId || statement.personId,
      })),
      cardName: card?.name ?? '',
      missing: expenses.filter((expense) => !linked.has(expense.id)),
      koganeTotal,
      difference: primary.difference,
    }
  }

  async list() {
    const [statements, cards] = await Promise.all([
      this.statementDBRepository.findMany(),
      this.paymentMethodDBRepository.findAll(),
    ])
    const names = new Map(cards.map((card) => [card.id, card.name]))
    return statements.map(({ rows, ...statement }) => ({
      ...statement,
      cardName: names.get(statement.paymentMethodId) ?? '',
      counts: {
        matched: rows.filter((row) => row.result === StatementRowResult.MATCHED).length,
        new: rows.filter((row) => row.result === StatementRowResult.NEW).length,
        created: rows.filter((row) => row.result === StatementRowResult.CREATED).length,
        ignored: rows.filter((row) => row.result === StatementRowResult.IGNORED).length,
      },
    }))
  }

  // ➕ Crear: the new rows (all or the given ones) become pending card expenses of the statement month
  async createNew(id: string, rowIds?: string[]) {
    const statement = await this.statementDBRepository.findById(id)
    const owner = await this.personDBRepository.findDefault()
    const statementPersonId = statement.personId ?? owner?.id
    if (!statementPersonId) throw new StatementUnreadableException({ reason: 'no person to assign' })
    // "Crear todos" takes the new rows; a row chosen by hand is created anyway (matched with an expense of the same
    // name from another month or card, or ignored), but never twice
    const rows = statement.rows.filter((row) =>
      rowIds?.length
        ? rowIds.includes(row.id) && row.result !== StatementRowResult.CREATED && !row.locked
        : row.result === StatementRowResult.NEW && !row.locked,
    )
    await this.statementDBRepository.createExpenses(
      id,
      rows.map((row) => {
        const personId = row.personId ?? statementPersonId // the person of that purchase (D113, D116)
        const common = {
          description: row.label || row.description,
          amount: row.amount,
          currency: row.currency,
          amountInPen: row.currency === Currency.PEN ? row.amount : null,
          paymentMethodId: statement.paymentMethodId,
          installment: row.installment,
          paymentMonth: statement.paymentMonth,
          paymentYear: statement.paymentYear,
        }
        // On a card the owner pays, another person's purchase is also what they owe (Cobros, D114, D116)
        const collect = personId !== owner?.id && statementPersonId === owner?.id
        return {
          id: row.id,
          data: {
            ...common,
            paymentStatus: PaymentStatus.NOT_STARTED,
            personId,
            processDate: row.date,
            notes: row.label ? `Del estado de cuenta: ${row.description}` : 'Del estado de cuenta',
          },
          ...(collect
            ? {
                debt: { ...common, direction: DebtDirection.OWED_TO_ME, personId, notes: 'Cobro del estado de cuenta' },
              }
            : {}),
        }
      }),
    )
    return this.get(id)
  }

  async assignRows(id: string, { rowIds, personId }: { rowIds: string[]; personId: string | null }) {
    if (personId && !(await this.personDBRepository.findActive()).some((person) => person.id === personId)) {
      throw new StatementUnreadableException({ reason: 'selected person not found' })
    }
    await this.statementDBRepository.findById(id)
    await this.statementDBRepository.assignRows(id, rowIds, personId)
    return this.get(id)
  }

  async assignPerson(id: string, personId: string) {
    const people = await this.personDBRepository.findActive()
    if (!people.some((person) => person.id === personId)) {
      throw new StatementUnreadableException({ reason: 'selected person not found' })
    }
    await this.statementDBRepository.assignPerson(id, personId)
    return this.get(id)
  }

  async update(
    id: string,
    {
      personId,
      paymentMethodId,
      minimumDue,
      minimumAllocations,
      currency,
    }: {
      personId?: string
      paymentMethodId?: string
      currency?: string
      minimumDue?: number | null
      minimumAllocations?: Record<string, number> | null
    },
  ) {
    if (personId) {
      const people = await this.personDBRepository.findActive()
      if (!people.some((person) => person.id === personId)) {
        throw new StatementUnreadableException({ reason: 'selected person not found' })
      }
      await this.statementDBRepository.assignPerson(id, personId)
    }
    if (paymentMethodId) {
      await this.changeCard(id, paymentMethodId)
    }
    if (minimumDue !== undefined) {
      await this.statementDBRepository.updateMinimumDue(id, minimumDue, currency)
    }
    if (minimumAllocations !== undefined) {
      await this.statementDBRepository.updateMinimumAllocations(id, minimumAllocations, currency)
    }
    return this.get(id)
  }

  async updateRow(
    id: string,
    rowId: string,
    {
      result,
      label,
      personId,
    }: {
      result?: StatementRowResult.IGNORED | StatementRowResult.NEW
      label?: string | null
      personId?: string | null
    },
  ) {
    if (result === StatementRowResult.NEW) {
      const statement = await this.statementDBRepository.findById(id)
      if (statement.rows.find((row) => row.id === rowId)?.locked) {
        throw new StatementUnreadableException({ reason: 'cancelled statement row cannot be restored' })
      }
    }
    if (personId && !(await this.personDBRepository.findActive()).some((person) => person.id === personId)) {
      throw new StatementUnreadableException({ reason: 'selected person not found' })
    }
    await this.statementDBRepository.updateRow(id, rowId, {
      result,
      label: label === undefined ? undefined : label || null,
      personId,
    })
    return this.get(id)
  }

  delete(id: string) {
    return this.statementDBRepository.delete(id)
  }

  private async read(lines: string[], documentNumber: string | null) {
    const parsed = parseStatementLines(lines)
    if (templateAddsUp(parsed)) return { parsed, source: StatementSource.TEMPLATE }

    const output = await this.expenseExtractionService.generateStructured({
      instructions: STATEMENT_INSTRUCTIONS,
      text: maskForAi(lines, documentNumber),
      jsonSchema: statementAiJsonSchema,
      parse: (json) => {
        const result = statementAiSchema.safeParse(json)
        return result.success ? { success: true, data: result.data } : { success: false, error: result.error.message }
      },
      operation: AiOperation.STATEMENT,
    })
    if (output?.movements.length) {
      // The card the AI read off the statement wins over the template's naive full-text scan (which can be fooled by
      // a purchase description, e.g. "Falabella.com" on a card that is not CMR)
      const aiParsed = fromAi(output, detectCardHint(output.cardName ?? '') ?? parsed.cardHint)
      const fromAiRows = aiParsed.rows
      const seen = new Set(fromAiRows.map(rowKey))
      const itemizedCharges = parsed.rows.filter(
        (row) => ITEMIZED_CARD_CHARGE.test(row.description) && !seen.has(rowKey(row)),
      )
      // The AI owns the currency interpretation when the template could not reconcile the PDF.
      // Never overwrite a USD total with the last amount of a dual-column template line.
      const multiCurrency =
        new Set([
          ...aiParsed.rows.map((row) => row.currency),
          ...(parsed.balances ?? []).map((balance) => balance.currency),
        ]).size > 1
      const balanceCurrencies = new Set(aiParsed.balances?.map((balance) => balance.currency))
      const requiredCurrencies = new Set([
        ...aiParsed.rows.map((row) => row.currency),
        ...((parsed.balances?.length ?? 0) > 1 ? parsed.balances!.map((balance) => balance.currency) : []),
      ])
      if (
        (multiCurrency && !output.balances?.length) ||
        [...requiredCurrencies].some((currency) => !balanceCurrencies.has(currency)) ||
        balanceCurrencies.size !== aiParsed.balances?.length
      ) {
        throw new StatementUnreadableException({ reason: 'currency balances not identified' })
      }
      const supplements = parsed.currencyAmbiguous || multiCurrency ? [] : itemizedCharges
      const parsedAnulations = parsed.currencyAmbiguous || multiCurrency ? [] : parsed.rows.filter((row) => row.locked)
      // Preserve repeated purchases in the PDF, including equal amounts in different currencies.
      const extras = [...supplements, ...parsedAnulations].filter((row) => {
        const key = rowKey(row)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      const uniqueRows = [...fromAiRows, ...extras]
      return { parsed: { ...aiParsed, rows: lockCancelledStatementRows(uniqueRows) }, source: StatementSource.AI }
    }
    if (parsed.rows.length && !parsed.currencyAmbiguous) return { parsed, source: StatementSource.TEMPLATE }
    throw new StatementUnreadableException({
      reason: parsed.currencyAmbiguous ? 'currency balances not identified' : 'no movements',
    })
  }

  private async cardOf(paymentMethodId: string | null, parsed: ParsedStatement, lines: string[]) {
    const cards = (await this.paymentMethodDBRepository.findAll()).filter(
      (method) => method.type === PaymentMethodType.CREDIT_CARD && (method.isActive || method.id === paymentMethodId),
    )
    const card = matchCard(cards, {
      chosenId: paymentMethodId,
      hint: parsed.cardHint,
      cardName: parsed.cardName,
      lines,
    })
    if (!card) throw new StatementUnreadableException({ reason: 'card not found: choose it' })
    return card
  }

  // Corrects a wrongly identified card (the auto-detect can miss it): re-reconciles the rows that are not a card
  // expense yet against the new card's expenses. A row already turned into a card expense (➕ Crear) keeps its own,
  // since that expense is tied to whichever card it was created with
  private async changeCard(id: string, paymentMethodId: string): Promise<void> {
    const statement = await this.statementDBRepository.findById(id)
    if (paymentMethodId === statement.paymentMethodId) return
    const cards = await this.paymentMethodDBRepository.findAll()
    const card = cards.find((method) => method.id === paymentMethodId && method.type === PaymentMethodType.CREDIT_CARD)
    if (!card) throw new StatementUnreadableException({ reason: 'card not found: choose it' })

    const period = { paymentMonth: statement.paymentMonth, paymentYear: statement.paymentYear }
    const matchCandidates = [
      ...(await this.cardExpenses(card.id, period)),
      ...(await this.cardExpenses(card.id, addMonths(period, -1))),
    ]
    const editable = statement.rows.filter((row) => row.result !== StatementRowResult.CREATED)
    const { rows: reconciled } = reconcileStatement(
      editable.map((row) => ({
        date: isoOf(row.date),
        description: row.description,
        amount: row.amount,
        currency: row.currency,
        installment: row.installment,
        locked: row.locked,
      })),
      matchCandidates,
    )
    await this.statementDBRepository.changeCard(
      id,
      card.id,
      editable.map((row, index) => ({
        id: row.id,
        result: reconciled[index].result,
        expenseId: reconciled[index].expenseId,
      })),
    )
  }

  // The typed password, then the document number of the chosen person, of the owner and of everyone else who has one
  // (D94). A copy of the bytes is read each time, so trying again is safe
  private async openPdf(
    data: Buffer,
    typed: string | null | undefined,
    personId: string | null,
    owner: PersonDbDto | null,
    people: PersonDbDto[],
  ): Promise<{ lines: string[]; password: string | null; personId: string | null }> {
    const byId = (id: string | null | undefined) => people.find((person) => person.id === id) ?? null
    const candidates: { password: string; personId: string | null }[] = []
    const add = (password: string | null | undefined, candidatePersonId: string | null) => {
      if (password && !candidates.some((candidate) => candidate.password === password)) {
        candidates.push({ password, personId: candidatePersonId })
      }
    }
    add(typed, null)
    add(byId(personId)?.documentNumber, personId)
    add(owner?.documentNumber, owner?.id ?? null)
    people.forEach((person) => add(person.documentNumber, person.id))

    if (!candidates.length) return { lines: await readPdfLines(data, null), password: null, personId: null }
    for (const candidate of candidates) {
      try {
        return { lines: await readPdfLines(data, candidate.password), ...candidate }
      } catch (error) {
        if (!(error instanceof StatementPasswordException)) throw error
      }
    }
    // Nothing opened it: a typed password was wrong, otherwise the right one is not saved anywhere
    throw new StatementPasswordException({ reason: typed ? 'incorrect' : 'missing' })
  }

  // The statement of month M closes on the closing day of M: its period end says M; without it, the due date (paid
  // in M when the due day comes after the closing day, otherwise in M+1)
  private periodOf(parsed: ParsedStatement, card: { billingCloseDay: number | null; paymentDueDay: number | null }) {
    if (parsed.periodEnd) return periodOfDay(parsed.periodEnd)
    if (parsed.dueDate) {
      const due = periodOfDay(parsed.dueDate)
      const sameMonth = (card.paymentDueDay ?? 0) > (card.billingCloseDay ?? 31)
      return sameMonth ? due : addMonths(due, -1)
    }
    throw new StatementUnreadableException({ reason: 'no closing or due date' })
  }

  private async cardExpenses(paymentMethodId: string, period: PaymentPeriod): Promise<CardExpenseForMatch[]> {
    const expenses = await this.statementDBRepository.findCardExpenses(paymentMethodId, period)
    return expenses.map((expense) => ({ ...expense, processDate: isoOf(expense.processDate) }))
  }

  private async keepFile(data: Buffer): Promise<string | null> {
    try {
      const file = await this.storedFilesService.storeTemporary('web', data, 'application/pdf')
      await this.storedFilesService.keep(file.id)
      return file.id
    } catch (error) {
      this.logger.warn(`[keepFile] statement PDF not stored: ${(error as Error).message}`)
      return null
    }
  }

  private async notify(view: Awaited<ReturnType<StatementsService['get']>>) {
    const count = (result: StatementRowResult) => view.rows.filter((row) => row.result === result).length
    // What each other person of the card has on it (P30, D116): their purchases, to collect once saved
    const names = new Map((await this.personDBRepository.findActive()).map((person) => [person.id, person.name]))
    const byPerson = new Map<string, { personId: string; currency: string; amount: number }>()
    view.rows
      .filter((row) => row.result !== StatementRowResult.IGNORED && row.personId && row.personId !== view.personId)
      .forEach((row) => {
        const key = `${row.personId}:${row.currency}`
        const previous = byPerson.get(key)
        byPerson.set(key, {
          personId: row.personId!,
          currency: row.currency,
          amount: toCents((previous?.amount ?? 0) + row.amount),
        })
      })
    const money = (amount: number, currency: string) =>
      `${currency === Currency.USD ? 'US$' : 'S/'} ${amount.toFixed(2)}`
    const collect = byPerson.size
      ? ` A cobrar: ${[...byPerson.values()].map((item) => `${names.get(item.personId) ?? '—'} ${money(item.amount, item.currency)}`).join(', ')}.`
      : ''
    const month = `${MONTH_NAMES[view.paymentMonth - 1]} ${view.paymentYear}`
    const total = view.balances
      .filter((balance) => balance.difference != null)
      .map((balance) =>
        Math.abs(balance.difference!) < 0.01
          ? ` El total en ${balance.currency} cuadra ✅`
          : ` Diferencia con lo registrado: ${money(balance.difference!, balance.currency)}.`,
      )
      .join('')
    return this.notificationsService.notify({
      kind: NotificationKind.STATEMENT,
      title: `📄 Estado de cuenta ${view.cardName} · ${month}`,
      body: `${count(StatementRowResult.MATCHED)} ya registrados, ${count(StatementRowResult.NEW)} nuevos y ${view.missing.length} solo en Kogane.${total}${collect} Revísalo en Estados de cuenta.`,
      amount: view.balances.length === 1 && view.currency === Currency.PEN ? view.totalDue : null,
      refType: NotificationRefType.STATEMENT,
      refId: view.id,
      eventDate: view.dueDate,
      dedupeKey: `statement:${view.id}`,
    })
  }
}
