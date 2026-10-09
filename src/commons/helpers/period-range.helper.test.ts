import { dateRange, parseYearMonth, paymentRangeWhere } from './period-range.helper'

describe('period-range.helper', () => {
  it('should read YYYY-MM and refuse anything else', () => {
    expect(parseYearMonth('2026-07')).toEqual({ year: 2026, month: 7 })
    expect(parseYearMonth('2026-13')).toBeNull()
    expect(parseYearMonth('julio')).toBeNull()
    expect(parseYearMonth(undefined)).toBeNull()
  })

  it('should keep the payment months between both ends, crossing years', () => {
    expect(paymentRangeWhere({ year: 2025, month: 11 }, { year: 2026, month: 1 })).toEqual({
      AND: [
        { OR: [{ paymentYear: { gt: 2025 } }, { paymentYear: 2025, paymentMonth: { gte: 11 } }] },
        { OR: [{ paymentYear: { lt: 2026 } }, { paymentYear: 2026, paymentMonth: { lte: 1 } }] },
      ],
    })
    expect(paymentRangeWhere(null, null)).toEqual({})
  })

  it('should turn the range into dates: first day of from, up to the first day after to', () => {
    expect(dateRange({ year: 2026, month: 8 }, { year: 2026, month: 10 })).toEqual({
      gte: new Date('2026-08-01T00:00:00.000Z'),
      lt: new Date('2026-11-01T00:00:00.000Z'),
    })
    expect(dateRange(null, { year: 2026, month: 12 })).toEqual({ lt: new Date('2027-01-01T00:00:00.000Z') })
    expect(dateRange(null, null)).toBeUndefined()
  })
})
