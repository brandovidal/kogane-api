import { toCents } from '@/commons/constants/debt.constant'
import { STATEMENT_MATCH_DAYS, StatementRowResult } from '@/commons/constants/statement.constant'
import { sameMerchant } from '@/modules/conversation/duplicate.helper'

import { ParsedStatementRow } from './statement.parser'

// The card expenses of the statement month, as reconciliation needs them
export interface CardExpenseForMatch {
  id: string
  description: string
  amount: number
  currency?: string // imports predating currency tracking represent PEN
  processDate: string | null // YYYY-MM-DD
  installment: string | null
  personId?: string // whose expense it is (the Persona of the card boards)
}

export interface ReconciledRow extends ParsedStatementRow {
  result: StatementRowResult.MATCHED | StatementRowResult.NEW | StatementRowResult.IGNORED
  expenseId: string | null
}

export interface Reconciliation {
  rows: ReconciledRow[]
  missing: CardExpenseForMatch[] // registered in Kogane but not in the statement
}

const daysApart = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / (24 * 60 * 60_000)

// Same amount, and the same installment or a date within 3 days; the merchant name breaks ties (D95)
function score(row: ParsedStatementRow, expense: CardExpenseForMatch): number | null {
  if (row.currency !== (expense.currency ?? 'PEN')) return null
  if (toCents(row.amount) !== toCents(expense.amount)) return null
  const sameInstallment = row.installment != null && row.installment === expense.installment
  const closeDate =
    row.date && expense.processDate ? daysApart(row.date, expense.processDate) <= STATEMENT_MATCH_DAYS : false
  const noDates = !row.date || !expense.processDate
  const merchant = sameMerchant(row.description, expense.description)
  if (!sameInstallment && !closeDate && !(noDates && merchant)) return null
  return (merchant ? 2 : 0) + (sameInstallment ? 1 : 0) + (closeDate ? 1 : 0)
}

export function reconcileStatement(rows: ParsedStatementRow[], expenses: CardExpenseForMatch[]): Reconciliation {
  const free = new Set(expenses.map((expense) => expense.id))
  const reconciled = rows.map((row): ReconciledRow => {
    if (row.locked) return { ...row, result: StatementRowResult.IGNORED, expenseId: null }
    const best = expenses
      .filter((expense) => free.has(expense.id))
      .map((expense) => ({ expense, score: score(row, expense) }))
      .filter((candidate): candidate is { expense: CardExpenseForMatch; score: number } => candidate.score != null)
      .sort((a, b) => b.score - a.score)[0]
    if (!best) return { ...row, result: StatementRowResult.NEW, expenseId: null }
    free.delete(best.expense.id)
    return { ...row, result: StatementRowResult.MATCHED, expenseId: best.expense.id }
  })
  return { rows: reconciled, missing: expenses.filter((expense) => free.has(expense.id)) }
}
