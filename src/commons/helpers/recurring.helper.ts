import { SubscriptionPeriod } from '@/commons/constants/expense.constant'

// Months between two rows of a template (D107): an annual one (a domain) only comes back after 12
const MONTHS_BETWEEN: Record<string, number> = {
  [SubscriptionPeriod.BIWEEKLY]: 1, // one row per month holds both payments
  [SubscriptionPeriod.MONTHLY]: 1,
  [SubscriptionPeriod.QUARTERLY]: 3,
  [SubscriptionPeriod.SEMIANNUAL]: 6,
  [SubscriptionPeriod.ANNUAL]: 12,
}

// Whether a template is due in the month that starts on monthStart, given the first day of the last month it generated
export function isDue(period: string, lastGeneratedAt: Date | null, monthStart: Date): boolean {
  if (!lastGeneratedAt) return true
  const months =
    (monthStart.getUTCFullYear() - lastGeneratedAt.getUTCFullYear()) * 12 +
    (monthStart.getUTCMonth() - lastGeneratedAt.getUTCMonth())
  return months >= (MONTHS_BETWEEN[period] ?? 1)
}

// "Pasar desde Costos fijos… / Plataformas…" of Recurrentes: the template that repeats a row every month. The day is
// the one of its due date (or payment date), else the 1st; the month it came from counts as already generated so the
// job does not duplicate it
export function templateFromRow(
  row: Record<string, unknown>,
  from: 'fixed_cost' | 'subscription',
): Record<string, unknown> {
  const due = (row.dueDate ?? row.paymentDate ?? null) as Date | null
  const dayOfMonth = due ? new Date(due).getUTCDate() : 1
  const month = Number(row.paymentMonth)
  const year = Number(row.paymentYear)
  return {
    description: row.description,
    amount: row.amount,
    currency: row.currency ?? 'PEN',
    targetType: from,
    kind: from === 'subscription' ? (row.kind ?? 'platform') : 'platform',
    period: from === 'subscription' ? (row.period ?? SubscriptionPeriod.MONTHLY) : SubscriptionPeriod.MONTHLY,
    supplyNumber: from === 'subscription' ? (row.supplyNumber ?? null) : null,
    expenseType: row.expenseType ?? 'essential',
    personId: row.personId,
    categoryId: row.categoryId ?? null,
    paymentMethodId: row.paymentMethodId ?? null,
    dayOfMonth,
    isActive: true,
    lastGeneratedAt: month && year ? new Date(Date.UTC(year, month - 1, 1)) : null,
  }
}
