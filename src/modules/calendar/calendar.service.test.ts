import { Test } from '@nestjs/testing'
import { vi } from 'vitest'

import { CalendarEventKind, CalendarEventStatus, PaymentOutcome } from '@/commons/constants/calendar.constant'
import { DebtDirection, DebtStatus } from '@/commons/constants/debt.constant'
import { PaymentKind } from '@/commons/constants/calendar.constant'
import { PaymentStatus } from '@/commons/constants/expense.constant'
import { NotificationRefType } from '@/commons/constants/notification.constant'
import { PaymentInvalidException } from '@/commons/exceptions/payment/payment-invalid.exception'
import { CatalogItemNotFoundException } from '@/commons/exceptions/catalog/catalog-item-not-found.exception'
import { DebtNotFoundException } from '@/commons/exceptions/debt/debt-not-found.exception'
import { AccountDBRepository } from '@/db/models/account/accountDB.repository'
import { PaymentDBRepository } from '@/db/models/payment/paymentDB.repository'
import { CalendarDBRepository } from '@/db/models/calendar/calendarDB.repository'
import { StatementDBRepository } from '@/db/models/statement/statementDB.repository'
import { DebtsService } from '@/modules/debts/debts.service'

import { CalendarService, cardStatementRef, parseCardStatementRef } from './calendar.service'

const TODAY = '2026-09-24'
const day = (isoDay: string) => new Date(`${isoDay}T00:00:00.000Z`)

const mockCalendarDB = {
  findActiveCards: vi.fn(),
  findCardRows: vi.fn(),
  findCardInstallments: vi.fn(),
  findFixedCostsDue: vi.fn(),
  findSubscriptionsDue: vi.fn(),
  findDebtsDue: vi.fn(),
  findActiveRecurring: vi.fn(),
  payCardStatement: vi.fn(),
  payFixedCost: vi.fn(),
  paySubscription: vi.fn(),
  findCardStatement: vi.fn(),
  findPayable: vi.fn(),
  setFixedCostAmount: vi.fn(),
  setSubscriptionAmount: vi.fn(),
}
const mockPayments = { create: vi.fn(), sumsByRefs: vi.fn(), sumsByStatementPeriods: vi.fn() }
const mockAccounts = { findById: vi.fn() }
const mockDebts = { get: vi.fn(), addPayment: vi.fn() }
const mockStatementDB = { findForPeriods: vi.fn() }

const IO = { id: 'io', name: 'IO', code: 'IO', color: '#000', billingCloseDay: 25, paymentDueDay: 12 }

const cardRow = (overrides: Record<string, unknown>) => ({
  id: 'r1',
  description: 'Compra',
  amount: 100,
  amountInPen: 100,
  currency: 'PEN',
  paymentStatus: PaymentStatus.PENDING,
  paymentMethodId: 'io',
  paymentMonth: 9,
  paymentYear: 2026,
  installment: null,
  draftId: null,
  originDraftId: null,
  ...overrides,
})

describe('CalendarService', () => {
  let service: CalendarService

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        CalendarService,
        { provide: CalendarDBRepository, useValue: mockCalendarDB },
        { provide: DebtsService, useValue: mockDebts },
        { provide: StatementDBRepository, useValue: mockStatementDB },
        { provide: PaymentDBRepository, useValue: mockPayments },
        { provide: AccountDBRepository, useValue: mockAccounts },
      ],
    }).compile()
    service = module.get(CalendarService)

    mockCalendarDB.findActiveCards.mockResolvedValue([IO])
    mockCalendarDB.findCardRows.mockResolvedValue([])
    mockCalendarDB.findCardInstallments.mockResolvedValue([])
    mockCalendarDB.findFixedCostsDue.mockResolvedValue([])
    mockCalendarDB.findSubscriptionsDue.mockResolvedValue([])
    mockCalendarDB.findDebtsDue.mockResolvedValue([])
    mockCalendarDB.findActiveRecurring.mockResolvedValue([])
    mockStatementDB.findForPeriods.mockResolvedValue([])
    mockPayments.sumsByStatementPeriods.mockResolvedValue(new Map())
    mockPayments.sumsByRefs.mockResolvedValue(new Map())
    mockPayments.create.mockResolvedValue({ id: 'pay1' })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('events', () => {
    it('should show the closing day and the payment of the card with what is still unpaid', async () => {
      mockCalendarDB.findCardRows.mockResolvedValue([
        cardRow({ id: 'a', amount: 100, amountInPen: 100 }),
        cardRow({ id: 'b', amount: 50, amountInPen: 50, paymentStatus: PaymentStatus.PAID }),
      ])

      const events = await service.events('2026-09-24', '2026-10-15', TODAY)

      expect(events).toEqual([
        expect.objectContaining({
          date: '2026-09-25',
          kind: CalendarEventKind.CARD_CLOSE,
          name: 'IO',
          amount: 150,
          status: CalendarEventStatus.PENDING,
        }),
        expect.objectContaining({
          date: '2026-10-12',
          kind: CalendarEventKind.CARD_DUE,
          amount: 100,
          status: CalendarEventStatus.PENDING,
          refType: NotificationRefType.CARD_STATEMENT,
          refId: 'io@2026-09',
        }),
      ])
    })

    it('should mark a statement paid when nothing is left and skip the payment of an empty statement', async () => {
      mockCalendarDB.findCardRows.mockResolvedValue([cardRow({ paymentStatus: PaymentStatus.PAID })])

      const events = await service.events('2026-10-12', '2026-10-12', TODAY)

      expect(events).toEqual([
        expect.objectContaining({ kind: CalendarEventKind.CARD_DUE, status: 'paid', amount: 100 }),
      ])
      mockCalendarDB.findCardRows.mockResolvedValue([])
      expect(await service.events('2026-10-12', '2026-10-12', TODAY)).toEqual([])
    })

    it('should take the due date and the total to pay of a statement read from the bank (P14, D95)', async () => {
      mockCalendarDB.findCardRows.mockResolvedValue([cardRow({ amount: 100, amountInPen: 100 })])
      mockStatementDB.findForPeriods.mockResolvedValue([
        { paymentMethodId: 'io', paymentMonth: 9, paymentYear: 2026, dueDate: day('2026-10-13'), totalDue: 312.4 },
      ])

      const events = await service.events('2026-10-01', '2026-10-31', TODAY)

      expect(events.find((event) => event.kind === CalendarEventKind.CARD_DUE)).toMatchObject({
        date: '2026-10-13',
        amount: 312.4,
        status: CalendarEventStatus.PENDING,
      })
    })

    it('should list fixed costs, subscriptions and debts by due date, late when their day passed', async () => {
      mockCalendarDB.findActiveCards.mockResolvedValue([])
      mockCalendarDB.findFixedCostsDue.mockResolvedValue([
        {
          id: 'f1',
          description: 'Luz',
          amount: 120,
          currency: 'PEN',
          paymentStatus: PaymentStatus.NOT_STARTED,
          dueDate: day('2026-09-20'),
        },
      ])
      mockCalendarDB.findSubscriptionsDue.mockResolvedValue([
        {
          id: 's1',
          description: 'Netflix',
          amount: 44.9,
          currency: 'PEN',
          paymentStatus: PaymentStatus.PAID,
          dueDate: day('2026-09-26'),
        },
      ])
      mockCalendarDB.findDebtsDue.mockResolvedValue([
        {
          id: 'd1',
          description: 'Préstamo',
          amount: 200,
          paidAmount: 50,
          currency: 'PEN',
          status: DebtStatus.PARTIAL,
          direction: DebtDirection.I_OWE,
          dueDate: day('2026-09-28'),
          installment: '2/5',
          person: { id: 'p1', name: 'Danery' },
        },
      ])

      const events = await service.events('2026-09-01', '2026-09-30', TODAY)

      expect(events.map((event) => [event.date, event.kind, event.status, event.amount])).toEqual([
        ['2026-09-20', CalendarEventKind.FIXED_COST, CalendarEventStatus.LATE, 120],
        ['2026-09-26', CalendarEventKind.SUBSCRIPTION, CalendarEventStatus.PAID, 44.9],
        ['2026-09-28', CalendarEventKind.DEBT_I_OWE, CalendarEventStatus.PENDING, 150],
      ])
      expect(events[2]).toMatchObject({ personName: 'Danery', installment: '2/5', refType: 'debt', refId: 'd1' })
    })

    it('should show a recurring expense only in months it was not generated for yet', async () => {
      mockCalendarDB.findActiveCards.mockResolvedValue([])
      mockCalendarDB.findActiveRecurring.mockResolvedValue([
        {
          id: 'rec',
          description: 'Alquiler',
          amount: 1200,
          currency: 'PEN',
          dayOfMonth: 31,
          lastGeneratedAt: day('2026-09-01'),
        },
      ])

      const events = await service.events('2026-09-01', '2026-11-30', TODAY)

      expect(events.map((event) => [event.date, event.kind])).toEqual([
        ['2026-10-31', CalendarEventKind.RECURRING],
        ['2026-11-30', CalendarEventKind.RECURRING],
      ])
    })
  })

  describe('installments', () => {
    it('should add the installments of each card per month and estimate the ones not saved yet', async () => {
      mockCalendarDB.findCardInstallments.mockResolvedValue([
        // Saved up to 2/4 (the chat saved only the first ones): 3/4 and 4/4 are estimated
        cardRow({ id: 'a1', installment: '1/4', paymentMonth: 8, amount: 50, amountInPen: 50, draftId: 'draft-a' }),
        cardRow({
          id: 'a2',
          installment: '2/4',
          paymentMonth: 9,
          amount: 50,
          amountInPen: 50,
          originDraftId: 'draft-a',
        }),
        // Every installment saved (D66): none estimated
        cardRow({ id: 'b1', installment: '1/2', paymentMonth: 9, amount: 30, amountInPen: 30, draftId: 'draft-b' }),
        cardRow({
          id: 'b2',
          installment: '2/2',
          paymentMonth: 10,
          amount: 30,
          amountInPen: 30,
          originDraftId: 'draft-b',
        }),
      ])

      const result = await service.installments(3, TODAY)

      expect(result.months).toEqual([
        { month: 9, year: 2026, total: 80 },
        { month: 10, year: 2026, total: 80 },
        { month: 11, year: 2026, total: 50 },
      ])
      expect(result.cards).toEqual([
        expect.objectContaining({
          paymentMethodId: 'io',
          total: 210,
          months: [
            { month: 9, year: 2026, amount: 80, count: 2, estimated: 0 },
            { month: 10, year: 2026, amount: 80, count: 2, estimated: 1 },
            { month: 11, year: 2026, amount: 50, count: 1, estimated: 1 },
          ],
        }),
      ])
      expect(result.items.filter((item) => item.estimated).map((item) => item.installment)).toEqual(['3/4', '4/4'])
    })
  })

  it('should read back the reference of a card statement', () => {
    const ref = cardStatementRef('io', { paymentMonth: 9, paymentYear: 2026 })

    expect(ref).toBe('io@2026-09')
    expect(parseCardStatementRef(ref)).toEqual({
      paymentMethodId: 'io',
      period: { paymentMonth: 9, paymentYear: 2026 },
    })
    expect(parseCardStatementRef('io')).toBeNull()
  })

  describe('pay', () => {
    it('should pay the unpaid rows of a card statement', async () => {
      mockCalendarDB.payCardStatement.mockResolvedValueOnce(3).mockResolvedValueOnce(0)

      expect(await service.pay(NotificationRefType.CARD_STATEMENT, 'io@2026-09')).toBe(PaymentOutcome.PAID)
      expect(mockCalendarDB.payCardStatement).toHaveBeenCalledWith('io', { paymentMonth: 9, paymentYear: 2026 })
      expect(await service.pay(NotificationRefType.CARD_STATEMENT, 'io@2026-09')).toBe(PaymentOutcome.NOTHING_TO_PAY)
      expect(await service.pay(NotificationRefType.CARD_STATEMENT, 'io')).toBe(PaymentOutcome.NOT_FOUND)
    })

    it('should pay a fixed cost or a subscription once, and say when it is gone', async () => {
      mockCalendarDB.payFixedCost.mockResolvedValueOnce(true).mockResolvedValueOnce(null)
      mockCalendarDB.paySubscription.mockResolvedValue(false)

      expect(await service.pay(NotificationRefType.FIXED_COST, 'f1')).toBe(PaymentOutcome.PAID)
      expect(mockCalendarDB.payFixedCost).toHaveBeenCalledWith('f1', expect.any(Date))
      expect(await service.pay(NotificationRefType.FIXED_COST, 'gone')).toBe(PaymentOutcome.NOT_FOUND)
      expect(await service.pay(NotificationRefType.SUBSCRIPTION, 's1')).toBe(PaymentOutcome.ALREADY_PAID)
    })

    it('should pay the whole balance of a debt installment, and say when it is gone', async () => {
      mockDebts.get.mockResolvedValueOnce({ balance: 150 }).mockResolvedValueOnce({ balance: 0 })

      expect(await service.pay(NotificationRefType.DEBT, 'd1')).toBe(PaymentOutcome.PAID)
      expect(mockDebts.addPayment).toHaveBeenCalledWith('d1', { amount: 150, paidAt: expect.any(Date) })
      expect(await service.pay(NotificationRefType.DEBT, 'd1')).toBe(PaymentOutcome.ALREADY_PAID)

      mockDebts.get.mockRejectedValueOnce(new DebtNotFoundException())
      expect(await service.pay(NotificationRefType.DEBT, 'gone')).toBe(PaymentOutcome.NOT_FOUND)
      expect(await service.pay(NotificationRefType.CATEGORY, 'food')).toBe(PaymentOutcome.NOT_FOUND)
    })
  })

  describe('payWithDetails', () => {
    const REF = 'io@2026-09:PEN'
    const rows = (...amounts: number[]) => ({
      name: 'IO',
      rows: amounts.map((amount) => ({ amount, currency: 'PEN', paymentStatus: PaymentStatus.PENDING })),
    })

    it('should leave a card statement open when it is paid in parts, and close it with the last one', async () => {
      mockCalendarDB.findCardStatement.mockResolvedValue(rows(300, 200))

      const first = await service.payWithDetails(NotificationRefType.CARD_STATEMENT, REF, {
        amount: 100,
        method: 'transfer',
        paidAt: '2026-09-10',
      })
      expect(first).toEqual({ outcome: PaymentOutcome.PARTIAL, paymentId: 'pay1' })
      expect(mockPayments.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 100, kind: PaymentKind.PARTIAL, method: 'transfer', title: 'IO' }),
      )
      expect(mockCalendarDB.payCardStatement).not.toHaveBeenCalled()

      mockPayments.sumsByRefs.mockResolvedValue(new Map([[REF, 100]]))
      const last = await service.payWithDetails(NotificationRefType.CARD_STATEMENT, REF, {})
      expect(last.outcome).toBe(PaymentOutcome.PAID)
      expect(mockPayments.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ amount: 400, kind: PaymentKind.TOTAL }),
      )
      expect(mockCalendarDB.payCardStatement).toHaveBeenCalledWith('io', { paymentMonth: 9, paymentYear: 2026 }, 'PEN')
    })

    it('should take the minimum of the bank statement and use its total when it is above the rows', async () => {
      mockCalendarDB.findCardStatement.mockResolvedValue(rows(300))
      mockStatementDB.findForPeriods.mockResolvedValue([
        { paymentMethodId: 'io', balances: [{ currency: 'PEN', totalDue: 350, minimumDue: 80 }] },
      ])

      const minimum = await service.payWithDetails(NotificationRefType.CARD_STATEMENT, REF, {
        kind: PaymentKind.MINIMUM,
      })
      expect(minimum.outcome).toBe(PaymentOutcome.PARTIAL)
      expect(mockPayments.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 80, kind: PaymentKind.MINIMUM }),
      )

      await expect(
        service.payWithDetails(NotificationRefType.CARD_STATEMENT, REF, { amount: 351 }),
      ).rejects.toBeInstanceOf(PaymentInvalidException)
    })

    it('should say there is nothing to pay on a statement already paid', async () => {
      mockCalendarDB.findCardStatement.mockResolvedValue({
        name: 'IO',
        rows: [{ amount: 50, currency: 'PEN', paymentStatus: PaymentStatus.PAID }],
      })
      mockCalendarDB.findCardStatement.mockResolvedValueOnce(null)

      expect((await service.payWithDetails(NotificationRefType.CARD_STATEMENT, REF, {})).outcome).toBe(
        PaymentOutcome.NOT_FOUND,
      )
      expect((await service.payWithDetails(NotificationRefType.CARD_STATEMENT, REF, {})).outcome).toBe(
        PaymentOutcome.NOTHING_TO_PAY,
      )
    })

    it('should replace the amount of a fixed cost when the real one differs', async () => {
      mockCalendarDB.findPayable.mockResolvedValue({
        description: 'Luz',
        amount: 100,
        currency: 'PEN',
        paymentStatus: PaymentStatus.PENDING,
      })

      const result = await service.payWithDetails(NotificationRefType.FIXED_COST, 'f1', {
        amount: 120.5,
        note: 'recibo',
      })
      expect(result).toEqual({ outcome: PaymentOutcome.PAID, paymentId: 'pay1' })
      expect(mockCalendarDB.setFixedCostAmount).toHaveBeenCalledWith('f1', 120.5)
      expect(mockCalendarDB.payFixedCost).toHaveBeenCalledWith('f1', expect.any(Date))
      expect(mockPayments.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 120.5, note: 'recibo' }))
    })

    it('should not touch a subscription that is already paid or gone', async () => {
      mockCalendarDB.findPayable.mockResolvedValueOnce(null).mockResolvedValueOnce({
        description: 'Netflix',
        amount: 10,
        currency: 'PEN',
        paymentStatus: PaymentStatus.PAID,
      })

      expect((await service.payWithDetails(NotificationRefType.SUBSCRIPTION, 's1', {})).outcome).toBe(
        PaymentOutcome.NOT_FOUND,
      )
      expect((await service.payWithDetails(NotificationRefType.SUBSCRIPTION, 's1', {})).outcome).toBe(
        PaymentOutcome.ALREADY_PAID,
      )
      expect(mockPayments.create).not.toHaveBeenCalled()
    })

    it('should pay part of a debt installment and reject more than its balance', async () => {
      mockDebts.get.mockResolvedValue({ balance: 150, description: 'Cena', currency: 'PEN' })

      const partial = await service.payWithDetails(NotificationRefType.DEBT, 'd1', { amount: 50, note: 'yape' })
      expect(partial.outcome).toBe(PaymentOutcome.PARTIAL)
      expect(mockDebts.addPayment).toHaveBeenCalledWith('d1', { amount: 50, paidAt: expect.any(Date), notes: 'yape' })
      await expect(service.payWithDetails(NotificationRefType.DEBT, 'd1', { amount: 151 })).rejects.toBeInstanceOf(
        PaymentInvalidException,
      )
    })

    it('should reject an account that does not exist or is inactive before paying anything', async () => {
      mockAccounts.findById.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'a1', isActive: false })

      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          service.payWithDetails(NotificationRefType.FIXED_COST, 'f1', { accountId: 'a1' }),
        ).rejects.toBeInstanceOf(CatalogItemNotFoundException)
      }
      expect(mockPayments.create).not.toHaveBeenCalled()
    })
  })
})
