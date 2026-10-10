import { Test, TestingModule } from '@nestjs/testing'
import { vi } from 'vitest'

import { DebtDirection, DebtPaymentKind, DebtStatus, DebtTiming } from '@/commons/constants/debt.constant'
import { DebtPaymentExceedsBalanceException } from '@/commons/exceptions/debt/debt-payment-exceeds-balance.exception'
import { DebtDBRepository } from '@/db/models/debt/debtDB.repository'
import { DebtWithPersonDbDto } from '@/db/models/debt/debtDB.dto'
import { StatementDBRepository } from '@/db/models/statement/statementDB.repository'

import { AttachmentsService } from '@/modules/attachments/attachments.service'
import { DebtsService } from './debts.service'
import { DebtBulkAction } from './validations/debts.validation'

const danery = { id: 'person-danery', name: 'Danery' }
const bruce = { id: 'person-bruce', name: 'Bruce' }

const buildDebt = (overrides: Partial<DebtWithPersonDbDto> = {}): DebtWithPersonDbDto => ({
  id: 'debt-1',
  direction: DebtDirection.OWED_TO_ME,
  description: 'Iphone 16',
  amount: 400,
  currency: 'PEN',
  exchangeRate: null,
  amountInPen: 400,
  installment: '1/3',
  paymentMonth: 9,
  paymentYear: 2026,
  carriedFromMonth: null,
  carriedFromYear: null,
  dueDate: null,
  status: DebtStatus.PENDING,
  paidAmount: 0,
  paidDate: null,
  personId: danery.id,
  person: danery,
  notes: null,
  draftId: null,
  createdAt: new Date('2026-09-01T12:00:00Z'),
  updatedAt: new Date('2026-09-01T12:00:00Z'),
  ...overrides,
})

const mockRepository = {
  findMany: vi.fn(),
  findOpen: vi.fn(),
  findById: vi.fn(),
  createMany: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  addPayment: vi.fn(),
  deletePayment: vi.fn(),
  replaceProposal: vi.fn(),
  findProposal: vi.fn(),
  confirmProposal: vi.fn(),
  discardProposal: vi.fn(),
  findByIds: vi.fn(),
  findCardPayments: vi.fn(),
  payMany: vi.fn(),
  resetMany: vi.fn(),
  setCard: vi.fn(),
  deleteMany: vi.fn(),
  withPayments: vi.fn(),
  findCarryable: vi.fn(),
  carryOver: vi.fn(),
}
const mockStatements = { findLatestForCard: vi.fn(), findCardExpenses: vi.fn() }
const mockAttachments = { removeOf: vi.fn() }

describe('DebtsService', () => {
  let service: DebtsService

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-23T17:00:00Z'))

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DebtsService,
        { provide: DebtDBRepository, useValue: mockRepository },
        { provide: StatementDBRepository, useValue: mockStatements },
        { provide: AttachmentsService, useValue: mockAttachments },
      ],
    }).compile()
    service = module.get(DebtsService)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetAllMocks()
  })

  it('should add the balance and the timing to every installment', async () => {
    mockRepository.findMany.mockResolvedValue([
      buildDebt({ paymentMonth: 8, paidAmount: 150, status: DebtStatus.PARTIAL }),
      buildDebt({ id: 'debt-2', paymentMonth: 10 }),
    ])

    const [late, upcoming] = await service.list({ status: DebtStatus.PARTIAL })

    expect(mockRepository.findMany).toHaveBeenCalledWith({ statuses: [DebtStatus.PARTIAL] })
    expect(late).toMatchObject({ balance: 250, timing: DebtTiming.LATE })
    expect(upcoming).toMatchObject({ balance: 400, timing: DebtTiming.UPCOMING })
  })

  it('should total per person: owed to me, I owe, net, late and due this month (soles only)', async () => {
    mockRepository.findMany.mockResolvedValue([
      buildDebt({ paymentMonth: 8 }),
      buildDebt({ id: 'd2', paymentMonth: 9, paidAmount: 100 }),
      buildDebt({ id: 'd3', direction: DebtDirection.I_OWE, amount: 50 }),
      buildDebt({ id: 'd4', personId: bruce.id, person: bruce, amount: 1000, paymentMonth: 12 }),
      buildDebt({ id: 'd5', currency: 'USD', amount: 30 }),
    ])

    await expect(service.summary()).resolves.toEqual([
      { personId: bruce.id, name: 'Bruce', owedToMe: 1000, iOwe: 0, net: 1000, late: 0, dueThisMonth: 0 },
      { personId: danery.id, name: 'Danery', owedToMe: 700, iOwe: 50, net: 650, late: 400, dueThisMonth: 300 },
    ])
  })

  it('should create one row per installment and month', async () => {
    mockRepository.createMany.mockImplementation(async (rows) => rows)

    const rows = await service.create({
      direction: DebtDirection.OWED_TO_ME,
      description: 'Iphone 16',
      amount: 400,
      personId: danery.id,
      paymentMonth: 12,
      paymentYear: 2026,
      installments: 3,
    })

    expect(
      rows.map(({ installment, paymentMonth, paymentYear, amountInPen }) => [
        installment,
        paymentMonth,
        paymentYear,
        amountInPen,
      ]),
    ).toEqual([
      ['1/3', 12, 2026, 400],
      ['2/3', 1, 2027, 400],
      ['3/3', 2, 2027, 400],
    ])
  })

  describe('payments from the web', () => {
    it('should register a payment up to the balance', async () => {
      mockRepository.findById.mockResolvedValue({ ...buildDebt({ paidAmount: 150 }), payments: [] })

      await service.addPayment('debt-1', { amount: 250 })

      expect(mockRepository.addPayment).toHaveBeenCalledWith({
        debtId: 'debt-1',
        amount: 250,
        paidAt: new Date('2026-09-23T17:00:00Z'),
        paymentMethodId: null,
        kind: DebtPaymentKind.PAYMENT,
        notes: null,
      })
    })

    it('should call a payment below the balance an abono unless the kind is given (D114)', async () => {
      mockRepository.findById.mockResolvedValue({ ...buildDebt({ paidAmount: 150 }), payments: [] })

      await service.addPayment('debt-1', { amount: 100 })
      await service.addPayment('debt-1', { amount: 100, kind: DebtPaymentKind.CASHBACK })

      expect(mockRepository.addPayment.mock.calls.map(([payment]) => payment.kind)).toEqual([
        DebtPaymentKind.PARTIAL,
        DebtPaymentKind.CASHBACK,
      ])
    })

    it('should refuse a payment greater than the balance', async () => {
      mockRepository.findById.mockResolvedValue({ ...buildDebt({ paidAmount: 150 }), payments: [] })

      await expect(service.addPayment('debt-1', { amount: 250.01 })).rejects.toThrow(DebtPaymentExceedsBalanceException)
      expect(mockRepository.addPayment).not.toHaveBeenCalled()
    })
  })

  describe('payments from the bot', () => {
    const open = [buildDebt({ id: 'aug', paymentMonth: 8 }), buildDebt({ id: 'sep', paymentMonth: 9 })]

    it('should propose covering the oldest installments, without confirming anything', async () => {
      mockRepository.findOpen.mockResolvedValue(open)

      const proposal = await service.proposePayment(danery.id, DebtDirection.OWED_TO_ME, 500)

      expect(mockRepository.findOpen).toHaveBeenCalledWith({ personId: danery.id, direction: DebtDirection.OWED_TO_ME })
      const [batchId, allocations] = mockRepository.replaceProposal.mock.calls[0]
      expect(batchId).toMatch(/^[0-9a-f]{20}$/)
      expect(allocations).toEqual([
        { debtId: 'aug', amount: 400 },
        { debtId: 'sep', amount: 100 },
      ])
      expect(proposal).toMatchObject({ batchId, excess: 0, items: [{ amount: 400 }, { amount: 100 }] })
      expect(mockRepository.confirmProposal).not.toHaveBeenCalled()
    })

    it('should return null when the person has nothing open (the text is a new expense then)', async () => {
      mockRepository.findOpen.mockResolvedValue([])

      await expect(service.proposePayment(danery.id, DebtDirection.I_OWE, 50)).resolves.toBeNull()
      expect(mockRepository.replaceProposal).not.toHaveBeenCalled()
    })

    it('should move the whole amount to the installment picked, up to its balance', async () => {
      const paidAt = new Date('2026-09-23T16:00:00Z')
      mockRepository.findProposal.mockResolvedValue([
        { amount: 400, paidAt, debt: open[0] },
        { amount: 100, paidAt, debt: open[1] },
      ])
      mockRepository.findOpen.mockResolvedValue(open)

      const proposal = await service.pickInstallment('batch-1', 'sep')

      expect(mockRepository.replaceProposal).toHaveBeenCalledWith(
        'batch-1',
        [{ debtId: 'sep', amount: 400 }],
        paidAt,
        null,
      )
      expect(proposal).toMatchObject({ items: [{ debt: { id: 'sep' }, amount: 400 }], excess: 100 })
    })

    it('should confirm the proposal and give back the installments with their balance', async () => {
      mockRepository.findProposal.mockResolvedValue([{ amount: 400, debt: open[0] }])
      mockRepository.confirmProposal.mockResolvedValue([
        { ...open[0], person: undefined, paidAmount: 400, status: DebtStatus.PAID },
      ])

      const updated = await service.confirmPayment('batch-1')

      expect(updated).toEqual([expect.objectContaining({ id: 'aug', balance: 0, person: danery })])
    })

    it('should do nothing with an expired proposal', async () => {
      mockRepository.findProposal.mockResolvedValue([])

      await expect(service.confirmPayment('old')).resolves.toBeNull()
      await expect(service.pickInstallment('old', 'sep')).resolves.toBeNull()
      expect(mockRepository.confirmProposal).not.toHaveBeenCalled()
    })
  })

  describe('selección múltiple (D115)', () => {
    const open = buildDebt({ id: 'a', amount: 400, paidAmount: 100, paymentMonth: 8 })
    const newer = buildDebt({ id: 'b', amount: 200, paidAmount: 0, paymentMonth: 9 })
    const done = buildDebt({ id: 'c', amount: 50, paidAmount: 50, status: DebtStatus.PAID })

    beforeEach(() => mockRepository.findByIds.mockResolvedValue([open, newer, done]))

    it('should pay the balance of each open one with the kind of the action and skip the ones already paid', async () => {
      const result = await service.bulk({ ids: ['a', 'b', 'c'], action: DebtBulkAction.CASHBACK })

      expect(mockRepository.payMany).toHaveBeenCalledWith(
        [
          { debtId: 'a', amount: 300 },
          { debtId: 'b', amount: 200 },
        ],
        expect.objectContaining({ kind: DebtPaymentKind.CASHBACK }),
      )
      expect(result).toEqual(expect.objectContaining({ affected: 2, paid: 500, skipped: ['c'] }))
    })

    it('should spread an abono over the oldest first and give back what is left', async () => {
      const result = await service.bulk({ ids: ['a', 'b', 'c'], action: DebtBulkAction.PARTIAL, amount: 350 })

      expect(mockRepository.payMany).toHaveBeenCalledWith(
        [
          { debtId: 'a', amount: 300 },
          { debtId: 'b', amount: 50 },
        ],
        expect.objectContaining({ kind: DebtPaymentKind.PARTIAL }),
      )
      expect(result.excess).toBe(0)
    })

    it('should clone to another month without payments, keeping person and card', async () => {
      mockRepository.createMany.mockImplementation(async (rows) => rows)
      await service.bulk({ ids: ['a'], action: DebtBulkAction.CLONE, month: 12, year: 2026 })

      expect(mockRepository.createMany.mock.calls[0][0][0]).toEqual(
        expect.objectContaining({ paymentMonth: 12, paymentYear: 2026, personId: open.personId }),
      )
      expect(mockRepository.createMany.mock.calls[0][0][0]).not.toHaveProperty('paidAmount')
    })

    it('should not delete debts with payments unless forced', async () => {
      mockRepository.withPayments.mockResolvedValue(new Set(['a']))
      mockRepository.deleteMany.mockResolvedValue(2)

      const result = await service.bulk({ ids: ['a', 'b', 'c'], action: DebtBulkAction.DELETE })

      expect(mockRepository.deleteMany).toHaveBeenCalledWith(['b', 'c'])
      expect(result.skipped).toEqual(['a'])
    })
  })

  it('should contrast what others owe of a card and month with its statement and flag interest lines (D114)', async () => {
    mockRepository.findMany.mockResolvedValue([
      buildDebt({ id: 'a', amount: 300, paidAmount: 100 }),
      buildDebt({ id: 'b', personId: bruce.id, person: bruce, amount: 50 }),
    ])
    mockRepository.findCardPayments.mockResolvedValue([])
    mockStatements.findLatestForCard
      .mockResolvedValueOnce({ id: 'st-9', totalDue: 1020, rows: [{ description: 'TAMBO', amount: 20 }] })
      .mockResolvedValueOnce({
        id: 'st-10',
        totalDue: 900,
        rows: [{ description: 'INTERESES COMPENSATORIOS', amount: 14.3 }],
      })
    mockStatements.findCardExpenses.mockResolvedValue([
      { id: 'e1', description: 'Televisor', amount: 700, personId: danery.id, person: { name: 'Danery' } },
      { id: 'e2', description: 'Zapatillas', amount: 300, personId: bruce.id, person: { name: 'Bruce' } },
    ])

    const check = await service.cardCheck({ paymentMethodId: 'cmr', month: 9, year: 2026 })

    expect(mockRepository.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ direction: DebtDirection.OWED_TO_ME, paymentMethodId: 'cmr', month: 9, year: 2026 }),
    )
    expect(check).toEqual(
      expect.objectContaining({
        statementId: 'st-9',
        statementTotal: 1020,
        koganeTotal: 1000,
        unexplained: 20,
        othersOwed: 350,
        othersPaid: 100,
        possibleInterest: [{ description: 'INTERESES COMPENSATORIOS', amount: 14.3 }],
      }),
    )
    expect(check.people.map((row) => [row.name, row.balance])).toEqual([
      ['Danery', 200],
      ['Bruce', 50],
    ])
  })

  describe('carryOver', () => {
    it('should carry the open installments of earlier months to the target month, in soles', async () => {
      mockRepository.findCarryable.mockResolvedValue([
        buildDebt({ id: 'd1', paymentMonth: 8, paidAmount: 100 }),
        buildDebt({ id: 'd2', paymentMonth: 7, currency: 'USD', amount: 10, amountInPen: 37.5 }),
        buildDebt({ id: 'd3', paymentMonth: 6, paidAmount: 400 }),
      ])

      const result = await service.carryOver({ month: 10, year: 2026, direction: DebtDirection.OWED_TO_ME })

      expect(mockRepository.findCarryable).toHaveBeenCalledWith(
        { month: 10, year: 2026 },
        { direction: DebtDirection.OWED_TO_ME, personId: undefined },
      )
      expect(result).toEqual({ dryRun: false, affected: 2, balance: 337.5, ids: ['d1', 'd2'] })
      expect(mockRepository.carryOver.mock.calls[0][0].map((row: { id: string }) => row.id)).toEqual(['d1', 'd2'])
      expect(mockRepository.carryOver.mock.calls[0][1]).toEqual({ month: 10, year: 2026 })
    })

    it('should only count on a dry run', async () => {
      mockRepository.findCarryable.mockResolvedValue([buildDebt({ id: 'd1', paymentMonth: 8 })])
      const result = await service.carryOver({ month: 10, year: 2026, dryRun: true })
      expect(result).toMatchObject({ dryRun: true, affected: 1 })
      expect(mockRepository.carryOver).not.toHaveBeenCalled()
    })
  })

  it('should release the Comprobante of a deleted payment', async () => {
    mockRepository.deletePayment.mockResolvedValue(buildDebt())
    await service.deletePayment('d1', 'pay1')
    expect(mockRepository.deletePayment).toHaveBeenCalledWith('d1', 'pay1')
    expect(mockAttachments.removeOf).toHaveBeenCalledWith(['debt_payment'], 'pay1')
  })
})
