import { toCents } from '@/commons/constants/debt.constant'
import { Currency } from '@/commons/constants/expense.constant'

// Your part of a charge in soles (D73): what others owe of a shared expense is theirs; other currencies count as 0 until
// they have their PEN amount (the same rule as the budget)
export const ownPen = (row: { currency: string; amount: number; amountInPen: number | null; othersShare: number }) =>
  row.currency === Currency.PEN ? toCents((row.amountInPen ?? row.amount) - row.othersShare) : 0

// YYYY-MM-DD → that day at 00:00 UTC (dates are stored that way)
export const dayStart = (isoDay: string) => new Date(`${isoDay}T00:00:00.000Z`)
