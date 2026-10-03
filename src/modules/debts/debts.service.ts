import { randomUUID } from 'node:crypto'

import { Injectable } from '@nestjs/common'

import { APP_TIME_ZONE } from '@/commons/constants/app.constant'
import {
  DebtDirection,
  DebtPaymentKind,
  DebtTiming,
  OPEN_DEBT_STATUSES,
  toCents,
} from '@/commons/constants/debt.constant'
import { Currency } from '@/commons/constants/expense.constant'
import { DateHelper } from '@/commons/helpers/date.helper'
import { allocatePayment, balanceOf, debtTiming } from '@/commons/helpers/debt.helper'
import { addMonths, PaymentPeriod } from '@/commons/helpers/payment-period.helper'
import { DebtPaymentExceedsBalanceException } from '@/commons/exceptions/debt/debt-payment-exceeds-balance.exception'
import { DebtDBRepository } from '@/db/models/debt/debtDB.repository'
import { DebtWithPersonDbDto } from '@/db/models/debt/debtDB.dto'
import { StatementDBRepository } from '@/db/models/statement/statementDB.repository'

import {
  CardCheckQueryDto,
  CreateDebtDto,
  DebtBulkDto,
  DebtListQueryDto,
  DebtPaymentDto,
  DebtSummaryQueryDto,
  UpdateDebtDto,
} from './dto/request/debts.dto'
import { DebtBulkAction } from './validations/debts.validation'

// A statement line that reads like interest or a fee (the AI leaves them out; a template may keep them)
const INTEREST_LINE = /\b(interes|intereses|comision|mora|penalidad|cargo por)\b/

const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

// The kind of payment each bulk action registers (D114)
const KIND_OF_ACTION: Partial<Record<DebtBulkAction, DebtPaymentKind>> = {
  [DebtBulkAction.PAY]: DebtPaymentKind.PAYMENT,
  [DebtBulkAction.PREPAID]: DebtPaymentKind.PREPAID,
  [DebtBulkAction.CASHBACK]: DebtPaymentKind.CASHBACK,
  [DebtBulkAction.PARTIAL]: DebtPaymentKind.PARTIAL,
}

// Batch ids travel in Telegram callback_data next to a debt id (64 bytes): keep them short
const BATCH_ID_LENGTH = 20

export type DebtView = DebtWithPersonDbDto & { balance: number; timing: DebtTiming }

export interface PersonDebtSummary {
  personId: string
  name: string
  owedToMe: number // balance, PEN
  iOwe: number
  net: number // positive: the person owes the user
  late: number // balance of late installments owed to the user
  dueThisMonth: number
}

export interface PaymentProposal {
  batchId: string
  personId: string
  direction: DebtDirection
  items: { debt: DebtView; amount: number }[]
  excess: number
}

// Loans and debts (P17, D60): the web API and the bot share this service
@Injectable()
export class DebtsService {
  constructor(
    private readonly debtDBRepository: DebtDBRepository,
    private readonly statementDBRepository: StatementDBRepository,
  ) {}

  async list({ status, ...filters }: DebtListQueryDto): Promise<DebtView[]> {
    const debts = await this.debtDBRepository.findMany({ ...filters, statuses: status ? [status] : undefined })
    return debts.map((debt) => this.toView(debt))
  }

  async findOpen(personId?: string, direction?: DebtDirection): Promise<DebtView[]> {
    const debts = await this.debtDBRepository.findOpen({ personId, direction })
    return debts.map((debt) => this.toView(debt))
  }

  async get(id: string) {
    const debt = await this.debtDBRepository.findById(id)
    return { ...this.toView(debt), payments: debt.payments }
  }

  // Me debe · le debo · neto per person, in soles (other currencies stay out until they have an exchange rate);
  // with a month, only that one (or every month until it)
  async summary({ month, year, until }: DebtSummaryQueryDto = {}): Promise<PersonDebtSummary[]> {
    const open = (await this.debtDBRepository.findMany({ statuses: OPEN_DEBT_STATUSES, month, year, until }))
      .map((debt) => this.toView(debt))
      .filter((debt) => debt.currency === Currency.PEN)
    const byPerson = new Map<string, PersonDebtSummary>()

    for (const debt of open) {
      const row = byPerson.get(debt.personId) ?? {
        personId: debt.personId,
        name: debt.person.name,
        owedToMe: 0,
        iOwe: 0,
        net: 0,
        late: 0,
        dueThisMonth: 0,
      }
      if (debt.direction === DebtDirection.I_OWE) {
        row.iOwe = toCents(row.iOwe + debt.balance)
      } else {
        row.owedToMe = toCents(row.owedToMe + debt.balance)
        if (debt.timing === DebtTiming.LATE) row.late = toCents(row.late + debt.balance)
        if (debt.timing === DebtTiming.DUE) row.dueThisMonth = toCents(row.dueThisMonth + debt.balance)
      }
      row.net = toCents(row.owedToMe - row.iOwe)
      byPerson.set(debt.personId, row)
    }

    return [...byPerson.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
  }

  async create({ installments = 1, ...body }: CreateDebtDto) {
    const period = { paymentMonth: body.paymentMonth, paymentYear: body.paymentYear }
    return this.debtDBRepository.createMany(
      Array.from({ length: installments }, (_, index) => ({
        ...body,
        amountInPen: body.currency && body.currency !== Currency.PEN ? null : body.amount,
        installment: installments > 1 ? `${index + 1}/${installments}` : null,
        ...addMonths(period, index),
      })),
    )
  }

  update(id: string, body: UpdateDebtDto) {
    return this.debtDBRepository.update(id, body)
  }

  delete(id: string) {
    return this.debtDBRepository.delete(id)
  }

  async addPayment(id: string, { amount, kind, paidAt, paymentMethodId, notes }: DebtPaymentDto) {
    const debt = await this.debtDBRepository.findById(id)
    const balance = balanceOf(debt)
    if (toCents(amount) > balance) throw new DebtPaymentExceedsBalanceException({ id, amount, balance })

    return this.debtDBRepository.addPayment({
      debtId: id,
      amount: toCents(amount),
      paidAt: paidAt ?? new Date(),
      paymentMethodId: paymentMethodId ?? null,
      kind: kind ?? (toCents(amount) < balance ? DebtPaymentKind.PARTIAL : DebtPaymentKind.PAYMENT),
      notes: notes ?? null,
    })
  }

  // Selección múltiple (D115): one action over several debts
  async bulk({ ids, action, amount, paidAt, paymentMethodId, month, year, force }: DebtBulkDto) {
    const debts = await this.debtDBRepository.findByIds(ids)
    const result = { action, affected: 0, paid: 0, excess: 0, skipped: [] as string[] }
    const open = debts.filter((debt) => balanceOf(debt) > 0)
    const payment = { paidAt: paidAt ?? new Date(), paymentMethodId: paymentMethodId ?? null }

    switch (action) {
      case DebtBulkAction.PAY:
      case DebtBulkAction.PREPAID:
      case DebtBulkAction.CASHBACK: {
        result.skipped = debts.filter((debt) => balanceOf(debt) <= 0).map((debt) => debt.id)
        const allocations = open.map((debt) => ({ debtId: debt.id, amount: balanceOf(debt) }))
        await this.debtDBRepository.payMany(allocations, { ...payment, kind: KIND_OF_ACTION[action]! })
        result.affected = allocations.length
        result.paid = toCents(allocations.reduce((sum, item) => sum + item.amount, 0))
        break
      }
      case DebtBulkAction.PARTIAL: {
        const { allocations, excess } = allocatePayment(open, amount!)
        await this.debtDBRepository.payMany(allocations, { ...payment, kind: DebtPaymentKind.PARTIAL })
        result.affected = allocations.length
        result.paid = toCents(allocations.reduce((sum, item) => sum + item.amount, 0))
        result.excess = excess
        break
      }
      case DebtBulkAction.CLONE: {
        const created = await this.debtDBRepository.createMany(
          debts.map((debt) => ({
            direction: debt.direction,
            description: debt.description,
            amount: debt.amount,
            currency: debt.currency,
            exchangeRate: debt.exchangeRate,
            amountInPen: debt.amountInPen,
            installment: debt.installment,
            personId: debt.personId,
            paymentMethodId: debt.paymentMethodId,
            notes: debt.notes,
            paymentMonth: month!,
            paymentYear: year!,
          })),
        )
        result.affected = created.length
        break
      }
      case DebtBulkAction.RESET:
        result.affected = (await this.debtDBRepository.resetMany(debts.map((debt) => debt.id))).length
        break
      case DebtBulkAction.CARD:
        result.affected = await this.debtDBRepository.setCard(
          debts.map((debt) => debt.id),
          paymentMethodId ?? null,
        )
        break
      case DebtBulkAction.DELETE: {
        const paid = force ? new Set<string>() : await this.debtDBRepository.withPayments(ids)
        result.skipped = [...paid]
        result.affected = await this.debtDBRepository.deleteMany(ids.filter((id) => !paid.has(id)))
        break
      }
    }
    return result
  }

  // Contraste con la tarjeta (D114): what others owe of a card and month vs the statement of that month
  async cardCheck({ paymentMethodId, month, year, currency = Currency.PEN }: CardCheckQueryDto) {
    const period: PaymentPeriod = { paymentMonth: month, paymentYear: year }
    const currentMonth = DateHelper.startOfDayIn(APP_TIME_ZONE, new Date(Date.UTC(year, month - 1, 15, 12)))
    const nextMonth = DateHelper.startOfDayIn(APP_TIME_ZONE, new Date(Date.UTC(year, month, 15, 12)))
    const [allDebts, statement, next, allExpenses, allCardPayments] = await Promise.all([
      this.debtDBRepository.findMany({ direction: DebtDirection.OWED_TO_ME, paymentMethodId, month, year }),
      this.statementDBRepository.findLatestForCard(paymentMethodId, period),
      this.statementDBRepository.findLatestForCard(paymentMethodId, addMonths(period, 1)),
      this.statementDBRepository.findCardExpenses(paymentMethodId, period),
      this.debtDBRepository.findCardPayments(paymentMethodId, currentMonth, nextMonth),
    ])

    const debts = allDebts.filter((item) => (item.currency ?? Currency.PEN) === currency)
    const expenses = allExpenses.filter((item) => (item.currency ?? Currency.PEN) === currency)
    const cardPayments = allCardPayments.filter((item) => (item.debt.currency ?? Currency.PEN) === currency)
    const balance =
      statement?.balances?.find((item) => item.currency === currency) ??
      (statement?.currency === currency ? statement : null)
    const availableCurrencies = [
      ...new Set([
        currency,
        ...(statement?.balances?.map((item) => item.currency) ?? []),
        ...allExpenses.map((item) => item.currency ?? Currency.PEN),
        ...allDebts.map((item) => item.currency ?? Currency.PEN),
      ]),
    ]
      .filter((item) => item === Currency.PEN || item === Currency.USD)
      .sort()

    const byPerson = new Map<string, { personId: string; name: string; owed: number; paid: number; balance: number }>()
    for (const debt of debts) {
      const row = byPerson.get(debt.personId) ?? {
        personId: debt.personId,
        name: debt.person.name,
        owed: 0,
        paid: 0,
        balance: 0,
      }
      row.owed = toCents(row.owed + debt.amount)
      row.paid = toCents(row.paid + debt.paidAmount)
      row.balance = toCents(row.balance + balanceOf(debt))
      byPerson.set(debt.personId, row)
    }
    const people = [...byPerson.values()].sort((a, b) => b.balance - a.balance)
    const paymentsByPerson = new Map<string, { personId: string; name: string; amount: number }>()
    for (const payment of cardPayments) {
      const row = paymentsByPerson.get(payment.debt.personId) ?? {
        personId: payment.debt.personId,
        name: payment.debt.person.name,
        amount: 0,
      }
      row.amount = toCents(row.amount + payment.amount)
      paymentsByPerson.set(payment.debt.personId, row)
    }
    const expensesByPerson = new Map<
      string,
      {
        personId: string
        name: string
        amount: number
        expenses: { id: string; description: string; amount: number }[]
      }
    >()
    for (const expense of expenses) {
      const row = expensesByPerson.get(expense.personId) ?? {
        personId: expense.personId,
        name: expense.person.name,
        amount: 0,
        expenses: [],
      }
      row.amount = toCents(row.amount + expense.amount)
      row.expenses.push({ id: expense.id, description: expense.description, amount: expense.amount })
      expensesByPerson.set(expense.personId, row)
    }
    const koganeTotal = toCents(expenses.reduce((sum, expense) => sum + expense.amount, 0))
    const statementTotal = balance?.totalDue ?? null
    const expensePersonIds = new Map(expenses.map((expense) => [expense.id, expense.personId]))
    const statementRows =
      statement?.rows
        .filter((row) => (row.currency ?? Currency.PEN) === currency)
        .map((row) => ({
          id: row.id,
          date: row.date,
          description: row.description,
          label: row.label,
          amount: row.amount,
          installment: row.installment,
          result: row.result,
          personId: (row.expenseId && expensePersonIds.get(row.expenseId)) || row.personId || statement.personId,
          expenseId: row.expenseId,
          debtId: row.debtId,
        })) ?? []

    return {
      paymentMethodId,
      month,
      year,
      currency,
      availableCurrencies,
      currencyReviewRequired: statement?.currencyReviewRequired ?? false,
      statementId: statement?.id ?? null,
      statementPersonId: statement?.personId ?? null,
      statementTotal,
      statementPeriodEnd: statement?.periodEnd ?? null,
      statementDueDate: statement?.dueDate ?? null,
      minimumDue: balance?.minimumDue ?? null,
      minimumAllocations: balance?.minimumAllocations ? this.parseMinimumAllocations(balance.minimumAllocations) : null,
      koganeTotal,
      unexplained: statementTotal == null ? null : toCents(statementTotal - koganeTotal),
      othersOwed: toCents(people.reduce((sum, row) => sum + row.owed, 0)),
      othersPaid: toCents(people.reduce((sum, row) => sum + row.paid, 0)),
      people,
      periodPayments: [...paymentsByPerson.values()].sort((a, b) => a.name.localeCompare(b.name, 'es')),
      expensesByPerson: [...expensesByPerson.values()].sort((a, b) => a.name.localeCompare(b.name, 'es')),
      statementRows,
      possibleInterest: [statement, next]
        .flatMap((candidate) => candidate?.rows ?? [])
        .filter((row) => (row.currency ?? Currency.PEN) === currency && INTEREST_LINE.test(fold(row.description)))
        .map((row) => ({ description: row.description, amount: row.amount })),
    }
  }

  private parseMinimumAllocations(value: string): Record<string, number> | null {
    try {
      const parsed: unknown = JSON.parse(value)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0,
        ),
      )
    } catch {
      return null
    }
  }

  deletePayment(id: string, paymentId: string) {
    return this.debtDBRepository.deletePayment(id, paymentId)
  }

  // Bot: "dany me pagó 150" covers the oldest installments first; nothing is saved until ✅ Confirmar.
  // null when that person has nothing open in that direction (then the message is read as a new expense).
  async proposePayment(personId: string, direction: DebtDirection, amount: number): Promise<PaymentProposal | null> {
    const open = await this.findOpen(personId, direction)
    if (!open.length) return null

    const { allocations, excess } = allocatePayment(open, amount)
    const batchId = randomUUID().replace(/-/g, '').slice(0, BATCH_ID_LENGTH)
    await this.debtDBRepository.replaceProposal(batchId, allocations, new Date(), null)

    return this.toProposal(batchId, personId, direction, open, allocations, excess)
  }

  // ✏️ Elegir cuota: the whole amount of the proposal goes to one installment (up to its balance)
  async pickInstallment(batchId: string, debtId: string): Promise<PaymentProposal | null> {
    const current = await this.debtDBRepository.findProposal(batchId)
    if (!current.length) return null

    const { personId, direction } = current[0].debt
    const total = toCents(current.reduce((sum, payment) => sum + payment.amount, 0))
    const open = await this.findOpen(personId, direction as DebtDirection)
    const debt = open.find((candidate) => candidate.id === debtId)
    if (!debt) return null

    const amount = Math.min(total, debt.balance)
    const allocations = [{ debtId, amount }]
    await this.debtDBRepository.replaceProposal(batchId, allocations, current[0].paidAt, null)

    return this.toProposal(batchId, personId, direction as DebtDirection, open, allocations, toCents(total - amount))
  }

  async findProposal(batchId: string): Promise<PaymentProposal | null> {
    const payments = await this.debtDBRepository.findProposal(batchId)
    if (!payments.length) return null

    const { personId, direction } = payments[0].debt
    return {
      batchId,
      personId,
      direction: direction as DebtDirection,
      items: payments.map((payment) => ({ debt: this.toView(payment.debt), amount: payment.amount })),
      excess: 0,
    }
  }

  // Returns the installments after the payment (with their new balance), or null when the proposal expired
  async confirmPayment(batchId: string): Promise<DebtView[] | null> {
    const proposal = await this.debtDBRepository.findProposal(batchId)
    if (!proposal.length) return null

    const updated = await this.debtDBRepository.confirmProposal(batchId)
    const people = new Map(proposal.map((payment) => [payment.debt.id, payment.debt.person]))
    return updated.map((debt) => this.toView({ ...debt, person: people.get(debt.id)! }))
  }

  cancelPayment(batchId: string) {
    return this.debtDBRepository.discardProposal(batchId)
  }

  private toProposal(
    batchId: string,
    personId: string,
    direction: DebtDirection,
    open: DebtView[],
    allocations: { debtId: string; amount: number }[],
    excess: number,
  ): PaymentProposal {
    const byId = new Map(open.map((debt) => [debt.id, debt]))
    return {
      batchId,
      personId,
      direction,
      items: allocations.map(({ debtId, amount }) => ({ debt: byId.get(debtId)!, amount })),
      excess,
    }
  }

  private toView(debt: DebtWithPersonDbDto): DebtView {
    const today = DateHelper.todayIn(APP_TIME_ZONE)
    return { ...debt, balance: balanceOf(debt), timing: debtTiming(debt, today) }
  }
}
