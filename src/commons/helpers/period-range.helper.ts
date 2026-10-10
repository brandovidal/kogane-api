import { z } from 'zod'

// A range of months for the lists of the web (PeriodFilter: Rango, "Últimos 3 meses"): `from` and `to` as YYYY-MM,
// both included; either can be missing (open on that side)
export interface YearMonth {
  year: number
  month: number
}

export const yearMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .describe('A month as YYYY-MM')

export function parseYearMonth(value: string | undefined | null): YearMonth | null {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})$/.exec(value)
  if (!match) return null
  const month = Number(match[2])
  return month >= 1 && month <= 12 ? { year: Number(match[1]), month } : null
}

// Rows with a payment month (paymentMonth/paymentYear) inside the range
export function paymentRangeWhere(from: YearMonth | null, to: YearMonth | null): Record<string, unknown> {
  const parts: Record<string, unknown>[] = []
  if (from)
    parts.push({
      OR: [{ paymentYear: { gt: from.year } }, { paymentYear: from.year, paymentMonth: { gte: from.month } }],
    })
  if (to)
    parts.push({ OR: [{ paymentYear: { lt: to.year } }, { paymentYear: to.year, paymentMonth: { lte: to.month } }] })
  return parts.length ? { AND: parts } : {}
}

// Dates (UTC days) inside the range: from the first day of `from` to the last day of `to`
export function dateRange(from: YearMonth | null, to: YearMonth | null): { gte?: Date; lt?: Date } | undefined {
  if (!from && !to) return undefined
  return {
    ...(from ? { gte: new Date(Date.UTC(from.year, from.month - 1, 1)) } : {}),
    ...(to ? { lt: new Date(Date.UTC(to.year, to.month, 1)) } : {}),
  }
}
