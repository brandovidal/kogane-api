import { vi } from 'vitest'

import { PaymentMethodType } from '@/commons/constants/catalog.constant'
import { ExpenseDBRepository } from '@/db/models/expense/expenseDB.repository'
import { PaymentMethodDBRepository } from '@/db/models/payment-method/paymentMethodDB.repository'
import { PersonDBRepository } from '@/db/models/person/personDB.repository'
import { ExpenseExtractionService } from '@/modules/expense-extraction/expense-extraction.service'

import { SpendingQueriesService } from './spending-queries.service'

const mockExpenses = { findChargesBetween: vi.fn(), findCardCycleTotals: vi.fn() }
const mockMethods = { findActive: vi.fn() }
const mockPeople = { findDefault: vi.fn() }
const mockExtraction = {
  loadCatalog: vi.fn().mockResolvedValue({
    entries: [
      { id: 'pm1', name: 'Yape', kind: 'payment_method' },
      { id: 'cat1', name: 'Comida', kind: 'category' },
    ],
  }),
}

const charge = (overrides: Record<string, unknown> = {}) => ({
  id: 'c1',
  source: 'daily',
  description: 'Almuerzo',
  amount: 25,
  othersShare: 0,
  currency: 'PEN',
  amountInPen: 25,
  paymentMethodId: 'pm1',
  categoryId: 'cat1',
  personId: 'me',
  date: new Date('2026-09-26T00:00:00.000Z'),
  createdAt: new Date(),
  ...overrides,
})

describe('SpendingQueriesService', () => {
  const service = new SpendingQueriesService(
    mockExpenses as unknown as ExpenseDBRepository,
    mockMethods as unknown as PaymentMethodDBRepository,
    mockPeople as unknown as PersonDBRepository,
    mockExtraction as unknown as ExpenseExtractionService,
  )

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-26T15:00:00.000Z')) // 10:00 in Lima
    mockPeople.findDefault.mockResolvedValue({ id: 'me' })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("should list today's expenses of the default person, with your part of the shared ones", async () => {
    mockExpenses.findChargesBetween.mockResolvedValue([
      charge(),
      charge({ description: 'Cena compartida', amount: 60, amountInPen: 60, othersShare: 30 }),
      charge({ description: 'De Dany', personId: 'dany' }),
    ])

    const { text } = await service.today()

    const [from, to] = mockExpenses.findChargesBetween.mock.calls[0]
    expect([from.toISOString(), to.toISOString()]).toEqual(['2026-09-26T00:00:00.000Z', '2026-09-27T00:00:00.000Z'])
    expect(text).toContain('Almuerzo')
    expect(text).not.toContain('De Dany')
    expect(text).toContain('Total: <b>S/ 55.00</b>')
  })

  it('should ask for the 7 days that end today', async () => {
    mockExpenses.findChargesBetween.mockResolvedValue([])

    await service.week()

    const [from, to] = mockExpenses.findChargesBetween.mock.calls[0]
    expect([from.toISOString(), to.toISOString()]).toEqual(['2026-09-20T00:00:00.000Z', '2026-09-27T00:00:00.000Z'])
  })

  it("should give each card the statement it is in: this month's until its closing day, the next one after it", async () => {
    mockMethods.findActive.mockResolvedValue([
      { id: 'oh', name: 'Oh Pay', type: PaymentMethodType.CREDIT_CARD, billingCloseDay: 28, paymentDueDay: 3 },
      { id: 'io', name: 'IO', type: PaymentMethodType.CREDIT_CARD, billingCloseDay: 25, paymentDueDay: 12 },
      { id: 'yape', name: 'Yape', type: PaymentMethodType.WALLET, billingCloseDay: null, paymentDueDay: null },
    ])
    mockExpenses.findCardCycleTotals.mockImplementation(async ({ paymentMonth }: { paymentMonth: number }) =>
      paymentMonth === 9
        ? [{ paymentMethodId: 'oh', total: 800, installments: 200, count: 4 }]
        : [{ paymentMethodId: 'io', total: 150, installments: 0, count: 1 }],
    )

    const { text } = await service.cards()

    // today is the 26th: Oh Pay closes on the 28th (September), IO closed on the 25th (October)
    expect(text).toContain('<b>Oh Pay</b>: S/ 800.00')
    expect(text).toContain('cierra 28/09 · paga 03/10')
    expect(text).toContain('<b>IO</b>: S/ 150.00')
    expect(text).toContain('cierra 25/10 · paga 12/11')
    expect(text).not.toContain('Yape')
  })
  it('should read a whole month for /exportar and /grafico: from its first day up to the first of the next', async () => {
    mockExpenses.findChargesBetween.mockResolvedValue([charge()])

    const rows = await service.monthRows(12, 2026)

    expect(mockExpenses.findChargesBetween).toHaveBeenCalledWith(
      new Date('2026-12-01T00:00:00.000Z'),
      new Date('2027-01-01T00:00:00.000Z'),
    )
    expect(rows).toEqual([expect.objectContaining({ description: 'Almuerzo', own: 25, category: 'Comida' })])
  })
})
