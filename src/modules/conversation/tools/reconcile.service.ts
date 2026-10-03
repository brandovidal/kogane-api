import { statementBalances } from '@/modules/statements/statement.balance'
import { Injectable } from '@nestjs/common'

import { CatalogKind } from '@/commons/constants/expense-extraction.constant'
import { StatementRowResult } from '@/commons/constants/statement.constant'
import { toCents } from '@/commons/constants/debt.constant'
import { StatementDBRepository } from '@/db/models/statement/statementDB.repository'
import { matchCatalogEntry } from '@/modules/expense-extraction/expense-extraction.catalog'
import { ExpenseExtractionService } from '@/modules/expense-extraction/expense-extraction.service'

import { BotReply } from '../dto/conversation.types'
import { formatReconcile, RECONCILE_TEXTS } from './reconcile.messages'

export interface ReconcileAnswer {
  reply: BotReply
  asksCard: boolean // the card was not said (or not found): the next message is it
}

// /cuadre <card> (P18, D128): the latest statement read of that card against what is registered for its month. Read-only:
// the reconciliation itself (matching, creating rows) stays in the web
@Injectable()
export class ReconcileService {
  constructor(
    private readonly statementDBRepository: StatementDBRepository,
    private readonly expenseExtractionService: ExpenseExtractionService,
  ) {}

  async reply(args: string): Promise<ReconcileAnswer> {
    const [statements, catalog] = await Promise.all([
      this.statementDBRepository.findMany(),
      this.expenseExtractionService.loadCatalog(),
    ])
    const cardsWithStatement = new Set(statements.map((statement) => statement.paymentMethodId))
    const cards = catalog.entries.filter(
      (entry) => entry.kind === CatalogKind.PAYMENT_METHOD && cardsWithStatement.has(entry.id),
    )
    if (!cards.length) return { reply: { text: RECONCILE_TEXTS.noCards }, asksCard: false }

    const card = args
      ? matchCatalogEntry({ ...catalog, entries: cards }, CatalogKind.PAYMENT_METHOD, args)
      : cards.length === 1
        ? cards[0]
        : null
    if (!card) {
      const text = args ? RECONCILE_TEXTS.unknownCard(args) : RECONCILE_TEXTS.askCard(cards.map((entry) => entry.name))
      return { reply: { text }, asksCard: true }
    }

    // findMany is newest first: the first one of that card is its latest statement
    const latest = statements.find((statement) => statement.paymentMethodId === card.id)!
    const [statement, expenses] = await Promise.all([
      this.statementDBRepository.findById(latest.id),
      this.statementDBRepository.findCardExpenses(card.id, {
        paymentMonth: latest.paymentMonth,
        paymentYear: latest.paymentYear,
      }),
    ])
    const linked = new Set(statement.rows.map((row) => row.expenseId).filter(Boolean))
    const balances = statementBalances(statement)
    const currencies = new Set([
      ...balances.map((balance) => balance.currency),
      ...expenses.map((expense) => expense.currency),
    ])
    const summaries = [...currencies].map((currency) =>
      formatReconcile({
        card: `${card.name} · ${currency}`,
        month: statement.paymentMonth,
        year: statement.paymentYear,
        currency,
        totalDue: balances.find((balance) => balance.currency === currency)?.totalDue ?? null,
        registered: toCents(
          expenses.filter((expense) => expense.currency === currency).reduce((sum, expense) => sum + expense.amount, 0),
        ),
        newRows: statement.rows.filter((row) => row.currency === currency && row.result === StatementRowResult.NEW)
          .length,
        missing: expenses
          .filter((expense) => expense.currency === currency && !linked.has(expense.id))
          .map(({ description, amount }) => ({ description, amount })),
      }),
    )
    if (statement.currencyReviewRequired)
      summaries.push('Vuelve a cargar el PDF en Importación para revisar sus monedas.')
    return { reply: { text: summaries.join('\n\n') }, asksCard: false }
  }
}
