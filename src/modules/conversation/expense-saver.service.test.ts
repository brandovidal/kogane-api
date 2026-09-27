import { Logger } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { vi } from 'vitest'

import { PaymentMethodType } from '@/commons/constants/catalog.constant'
import { DebtDirection } from '@/commons/constants/debt.constant'
import { ExpenseDestination, PaymentStatus, SubscriptionPeriod } from '@/commons/constants/expense.constant'
import { ExpenseField } from '@/commons/constants/expense-extraction.constant'
import { ExpenseNotSaveableException } from '@/commons/exceptions/conversation/expense-not-saveable.exception'
import {
  BudgetSettingDBRepository,
  DEFAULT_BUDGET_SETTINGS,
} from '@/db/models/budget-setting/budgetSettingDB.repository'
import { ExpenseDBRepository } from '@/db/models/expense/expenseDB.repository'
import { TripDBRepository } from '@/db/models/trip/tripDB.repository'
import { PaymentMethodDBRepository } from '@/db/models/payment-method/paymentMethodDB.repository'
import { StoredFilesService } from '@/modules/stored-files/stored-files.service'

import { ExpenseSaverService } from './expense-saver.service'
import { buildExpenseDraft, FILE_ID } from './mocks/conversation.mock'

const mockExpenseDBRepository = { saveFromExpenseDraft: vi.fn() }
const mockPaymentMethodDBRepository = { findById: vi.fn() }
const mockStoredFilesService = { keep: vi.fn() }
const mockBudgetSettingDBRepository = { get: vi.fn() }
const mockTripDBRepository = { findActive: vi.fn() }

describe('ExpenseSaverService', () => {
  let service: ExpenseSaverService

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExpenseSaverService,
        { provide: ExpenseDBRepository, useValue: mockExpenseDBRepository },
        { provide: PaymentMethodDBRepository, useValue: mockPaymentMethodDBRepository },
        { provide: StoredFilesService, useValue: mockStoredFilesService },
        { provide: BudgetSettingDBRepository, useValue: mockBudgetSettingDBRepository },
        { provide: TripDBRepository, useValue: mockTripDBRepository },
      ],
    }).compile()

    service = module.get<ExpenseSaverService>(ExpenseSaverService)
    mockExpenseDBRepository.saveFromExpenseDraft.mockResolvedValue({ id: 'expense-1' })
    mockBudgetSettingDBRepository.get.mockResolvedValue(DEFAULT_BUDGET_SETTINGS)
    mockTripDBRepository.findActive.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  const savedInput = () => mockExpenseDBRepository.saveFromExpenseDraft.mock.calls[0][1]

  it('should save a day-to-day expense in exp_daily_expenses with its payment method and date', async () => {
    await service.save(buildExpenseDraft({ destination: ExpenseDestination.DAILY }))

    expect(mockExpenseDBRepository.saveFromExpenseDraft).toHaveBeenCalledWith(FILE_ID, expect.anything(), undefined)
    expect(savedInput()).toEqual({
      destination: ExpenseDestination.DAILY,
      data: expect.objectContaining({
        description: 'Almuerzo',
        amount: 25,
        amountInPen: 25,
        personId: 'person-danery',
        paymentMethodId: 'method-yape',
        categoryId: 'category-food',
        spentAt: new Date('2026-09-22T00:00:00.000Z'),
      }),
    })
  })

  it('should refuse a day-to-day expense without payment method', async () => {
    await expect(
      service.save(buildExpenseDraft({ destination: ExpenseDestination.DAILY, paymentMethodId: null })),
    ).rejects.toThrow(ExpenseNotSaveableException)
  })

  it('should save a fixed cost in the month of the expense', async () => {
    await expect(service.save(buildExpenseDraft())).resolves.toEqual({
      id: 'expense-1',
      installments: null,
      trip: null,
      // what the budget of its category gets (P19): a fixed cost counts in its payment month
      budget: {
        personId: 'person-danery',
        categoryId: 'category-food',
        period: { paymentMonth: 9, paymentYear: 2026 },
        amount: 25,
      },
    })

    expect(mockExpenseDBRepository.saveFromExpenseDraft).toHaveBeenCalledWith(FILE_ID, expect.anything(), undefined)
    expect(savedInput()).toEqual({
      destination: ExpenseDestination.FIXED_COST,
      data: expect.objectContaining({
        description: 'Almuerzo',
        amount: 25,
        amountInPen: 25,
        personId: 'person-danery',
        categoryId: 'category-food',
        paymentMethodId: 'method-yape',
        paymentStatus: PaymentStatus.NOT_STARTED,
        paymentMonth: 9,
        paymentYear: 2026,
      }),
    })
  })

  it('should use the closing day of the card (a payment method) for credit card expenses', async () => {
    mockPaymentMethodDBRepository.findById.mockResolvedValue({ id: 'method-ohpay', billingCloseDay: 10 })

    await service.save(
      buildExpenseDraft({
        destination: ExpenseDestination.CREDIT_CARD,
        paymentMethodId: 'method-ohpay',
        spentAt: new Date('2026-09-15T00:00:00.000Z'),
      }),
    )

    expect(mockPaymentMethodDBRepository.findById).toHaveBeenCalledWith('method-ohpay')
    expect(savedInput().data).toMatchObject({
      paymentMethodId: 'method-ohpay',
      paymentStatus: PaymentStatus.NOT_STARTED,
      paymentMonth: 10,
      paymentYear: 2026,
      processDate: new Date('2026-09-15T00:00:00.000Z'),
    })
  })

  it('should bill a card without closing day (created from the bot) in the month of the purchase', async () => {
    mockPaymentMethodDBRepository.findById.mockResolvedValue({ id: 'method-new', billingCloseDay: null })

    await service.save(
      buildExpenseDraft({
        destination: ExpenseDestination.CREDIT_CARD,
        paymentMethodId: 'method-new',
        spentAt: new Date('2026-09-28T00:00:00.000Z'),
      }),
    )

    expect(savedInput().data).toMatchObject({ paymentMonth: 9, paymentYear: 2026 })
  })

  it('should save subscriptions with their period and debts without expense fields', async () => {
    await service.save(
      buildExpenseDraft({ destination: ExpenseDestination.SUBSCRIPTION, period: SubscriptionPeriod.MONTHLY }),
    )
    // Without a kind it is a platform (the bot); a web draft of Recurrentes brings its own (D107)
    expect(savedInput().data).toMatchObject({ period: SubscriptionPeriod.MONTHLY, paymentMonth: 9, kind: 'platform' })

    vi.clearAllMocks()
    mockExpenseDBRepository.saveFromExpenseDraft.mockResolvedValue({ id: 'expense-3' })
    mockBudgetSettingDBRepository.get.mockResolvedValue(DEFAULT_BUDGET_SETTINGS)
    await service.save(
      buildExpenseDraft({
        destination: ExpenseDestination.SUBSCRIPTION,
        period: SubscriptionPeriod.MONTHLY,
        kind: 'service',
        supplyNumber: '987654321',
      }),
    )
    expect(savedInput().data).toMatchObject({ kind: 'service', supplyNumber: '987654321' })

    vi.clearAllMocks()
    mockExpenseDBRepository.saveFromExpenseDraft.mockResolvedValue({ id: 'expense-2' })

    await service.save(buildExpenseDraft({ destination: ExpenseDestination.RECEIVABLE, amount: 100, currency: 'USD' }))
    expect(savedInput()).toEqual({
      destination: ExpenseDestination.RECEIVABLE,
      data: {
        direction: DebtDirection.OWED_TO_ME,
        description: 'Almuerzo',
        amount: 100,
        currency: 'USD',
        exchangeRate: null,
        amountInPen: null,
        personId: 'person-danery',
        notes: null,
        installment: null,
        paymentMonth: 9,
        paymentYear: 2026,
      },
      nextInstallments: [],
    })
  })

  // P17 (D60): one row per installment in exp_debts
  describe('debts', () => {
    const debtDraft = (overrides = {}) =>
      buildExpenseDraft({ destination: ExpenseDestination.RECEIVABLE, amount: 400, ...overrides })

    it('should create every installment of "1/3", one per month, across the year end', async () => {
      await service.save(debtDraft({ installment: '1/3', spentAt: new Date('2026-11-15T00:00:00.000Z') }))

      const { data, nextInstallments } = savedInput()
      expect(data).toMatchObject({ installment: '1/3', paymentMonth: 11, paymentYear: 2026, amount: 400 })
      expect(
        nextInstallments.map(({ installment, paymentMonth, paymentYear }: Record<string, unknown>) => [
          installment,
          paymentMonth,
          paymentYear,
        ]),
      ).toEqual([
        ['2/3', 12, 2026],
        ['3/3', 1, 2027],
      ])
    })

    it('should create only the installment named when it is not the first one', async () => {
      await service.save(debtDraft({ installment: '3/6' }))

      expect(savedInput()).toMatchObject({ data: { installment: '3/6' }, nextInstallments: [] })
    })

    it('should save "le debo" as a debt of the user', async () => {
      await service.save(debtDraft({ destination: ExpenseDestination.PAYABLE }))

      expect(savedInput()).toMatchObject({
        destination: ExpenseDestination.PAYABLE,
        data: { direction: DebtDirection.I_OWE },
      })
    })

    it('should start in the billing month of the card used to buy it', async () => {
      mockPaymentMethodDBRepository.findById.mockResolvedValue({
        id: 'card-io',
        type: PaymentMethodType.CREDIT_CARD,
        billingCloseDay: 10,
      })

      await service.save(debtDraft({ paymentMethodId: 'card-io', spentAt: new Date('2026-09-22T00:00:00.000Z') }))

      expect(savedInput().data).toMatchObject({ paymentMonth: 10, paymentYear: 2026 })
    })
  })

  it.each([
    ['missing fields', { missingFields: [ExpenseField.CATEGORY] }],
    ['no destination', { destination: null }],
    ['a discarded item', { destination: ExpenseDestination.DISCARD }],
    ['a fixed cost without category', { categoryId: null }],
  ])('should refuse %s', async (_case, overrides) => {
    await expect(service.save(buildExpenseDraft(overrides))).rejects.toThrow(ExpenseNotSaveableException)
    expect(mockExpenseDBRepository.saveFromExpenseDraft).not.toHaveBeenCalled()
  })

  it('should refuse a credit card expense whose payment method no longer exists', async () => {
    mockPaymentMethodDBRepository.findById.mockResolvedValue(null)

    await expect(
      service.save(buildExpenseDraft({ destination: ExpenseDestination.CREDIT_CARD, paymentMethodId: 'gone' })),
    ).rejects.toThrow(ExpenseNotSaveableException)
  })

  // D58: the screenshot of a saved expense moves from drafts/ to expenses/
  describe('stored files', () => {
    it('should keep the file of the saved expense', async () => {
      await service.save(buildExpenseDraft({ fileId: 'stored-1' }))

      expect(mockStoredFilesService.keep).toHaveBeenCalledWith('stored-1')
    })

    it('should keep the expense saved when the file cannot be moved', async () => {
      mockStoredFilesService.keep.mockRejectedValue(new Error('R2 down'))
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})

      await expect(service.save(buildExpenseDraft({ fileId: 'stored-1' }))).resolves.toMatchObject({ id: 'expense-1' })
    })

    it('should not touch storage for an expense without a file', async () => {
      await service.save(buildExpenseDraft())

      expect(mockStoredFilesService.keep).not.toHaveBeenCalled()
    })

    it('should not keep the file when the save fails', async () => {
      await expect(
        service.save(buildExpenseDraft({ fileId: 'stored-1', missingFields: [ExpenseField.AMOUNT] })),
      ).rejects.toThrow(ExpenseNotSaveableException)

      expect(mockStoredFilesService.keep).not.toHaveBeenCalled()
    })
  })

  describe('credit card installments (D66)', () => {
    beforeEach(() => {
      mockPaymentMethodDBRepository.findById.mockResolvedValue({ id: 'method-ohpay', billingCloseDay: 10 })
    })

    it('should create the n installments of "1/n", one per billing month, and say which were created', async () => {
      const saved = await service.save(
        buildExpenseDraft({
          destination: ExpenseDestination.CREDIT_CARD,
          paymentMethodId: 'method-ohpay',
          installment: '1/10',
          amount: 164.9,
          spentAt: new Date('2026-09-14T00:00:00.000Z'),
        }),
      )

      // 14/09 after the closing day 10: October is the first billing month
      expect(savedInput().data).toMatchObject({
        installment: '1/10',
        amount: 164.9,
        paymentMonth: 10,
        paymentYear: 2026,
      })
      const next = savedInput().nextInstallments
      expect(next).toHaveLength(9)
      expect(next[0]).toMatchObject({ installment: '2/10', paymentMonth: 11, paymentYear: 2026, amount: 164.9 })
      expect(next[8]).toMatchObject({ installment: '10/10', paymentMonth: 7, paymentYear: 2027 })
      expect(saved.installments).toEqual({
        total: 10,
        from: { paymentMonth: 10, paymentYear: 2026 },
        to: { paymentMonth: 7, paymentYear: 2027 },
      })
    })

    it('should create only that row for a later installment ("3/6")', async () => {
      const saved = await service.save(
        buildExpenseDraft({
          destination: ExpenseDestination.CREDIT_CARD,
          paymentMethodId: 'method-ohpay',
          installment: '3/6',
        }),
      )

      expect(savedInput().nextInstallments).toEqual([])
      expect(saved.installments).toBeNull()
    })
  })

  describe('shared expenses (D73)', () => {
    it('should keep the total the user paid, what the other one owes, and her debt in the same month', async () => {
      const saved = await service.save(
        buildExpenseDraft({
          destination: ExpenseDestination.DAILY,
          description: 'Cena',
          amount: 120,
          personId: 'person-brando',
          sharedWith: { shares: [{ personId: 'person-danery', ratio: 0.5 }] },
        }),
      )

      expect(savedInput().data).toMatchObject({
        description: 'Cena',
        amount: 120,
        othersShare: 60,
        personId: 'person-brando',
      })
      expect(savedInput().sharedDebts).toEqual([
        {
          direction: DebtDirection.OWED_TO_ME,
          description: 'Cena (compartido)',
          amount: 60,
          currency: 'PEN',
          personId: 'person-danery',
          installment: null,
          paymentMethodId: 'method-yape',
          originDraftId: FILE_ID,
          paymentMonth: 9,
          paymentYear: 2026,
        },
      ])
      // the budget counts only the user's part
      expect(saved.budget?.amount).toBe(60)
    })

    it('should charge the sister her part of a platform the user pays (D72, D73)', async () => {
      await service.save(
        buildExpenseDraft({
          destination: ExpenseDestination.SUBSCRIPTION,
          period: SubscriptionPeriod.MONTHLY,
          description: 'Netflix',
          amount: 64,
          personId: 'person-brando',
          sharedWith: { shares: [{ personId: 'person-brenda', amount: 20 }] },
        }),
      )

      expect(savedInput().data).toMatchObject({ amount: 64, othersShare: 20, personId: 'person-brando' })
      expect(savedInput().sharedDebts).toEqual([
        expect.objectContaining({ description: 'Netflix (compartido)', amount: 20, personId: 'person-brenda' }),
      ])
    })

    it('should share every installment of a card purchase and link them all to the draft', async () => {
      mockPaymentMethodDBRepository.findById.mockResolvedValue({ id: 'method-ohpay', billingCloseDay: 10 })

      await service.save(
        buildExpenseDraft({
          destination: ExpenseDestination.CREDIT_CARD,
          paymentMethodId: 'method-ohpay',
          installment: '1/2',
          amount: 100,
          spentAt: new Date('2026-09-05T00:00:00.000Z'),
          sharedWith: { shares: [{ personId: 'person-danery', ratio: 0.5 }] },
        }),
      )

      expect(savedInput().data).toMatchObject({ amount: 100, othersShare: 50, paymentMonth: 9 })
      expect(savedInput().nextInstallments).toEqual([
        expect.objectContaining({ installment: '2/2', othersShare: 50, paymentMonth: 10, originDraftId: FILE_ID }),
      ])
      expect(
        savedInput().sharedDebts.map((debt: { installment: string; paymentMonth: number }) => [
          debt.installment,
          debt.paymentMonth,
        ]),
      ).toEqual([
        ['1/2', 9],
        ['2/2', 10],
      ])
    })

    it('should not split a debt', async () => {
      await service.save(
        buildExpenseDraft({
          destination: ExpenseDestination.RECEIVABLE,
          amount: 100,
          sharedWith: { shares: [{ personId: 'person-danery', ratio: 0.5 }] },
        }),
      )

      expect(savedInput().data.amount).toBe(100)
      expect(savedInput().sharedDebts).toBeUndefined()
    })

    it('should replace the rows of the saved expense an edit copy comes from (D76)', async () => {
      await service.save(buildExpenseDraft({ replacesDraftId: 'draft-original' }))

      expect(mockExpenseDBRepository.saveFromExpenseDraft).toHaveBeenCalledWith(
        FILE_ID,
        expect.anything(),
        'draft-original',
      )
    })
  })

  describe('trips (/viaje, P18)', () => {
    beforeEach(() => mockTripDBRepository.findActive.mockResolvedValue({ id: 'trip-1', name: 'Lima' }))

    it('should tag a day-to-day expense with the open trip and say which one', async () => {
      const saved = await service.save(buildExpenseDraft({ destination: ExpenseDestination.DAILY }))

      expect(savedInput().data.tripId).toBe('trip-1')
      expect(saved.trip).toBe('Lima')
    })

    it('should tag a card expense and each of its installments', async () => {
      mockPaymentMethodDBRepository.findById.mockResolvedValue({
        id: 'pm',
        type: PaymentMethodType.CREDIT_CARD,
        billingCloseDay: 25,
      })

      await service.save(buildExpenseDraft({ destination: ExpenseDestination.CREDIT_CARD, installment: '1/3' }))

      expect(savedInput().data.tripId).toBe('trip-1')
      expect(savedInput().nextInstallments.map((row: { tripId: string }) => row.tripId)).toEqual(['trip-1', 'trip-1'])
    })

    it('should not tag what a trip does not cover: fixed costs, subscriptions and debts', async () => {
      const fixed = await service.save(buildExpenseDraft({ destination: ExpenseDestination.FIXED_COST }))

      expect(savedInput().data.tripId).toBeUndefined()
      expect(fixed.trip).toBeNull()
    })

    it('should tag nothing when no trip is open', async () => {
      mockTripDBRepository.findActive.mockResolvedValue(null)

      const saved = await service.save(buildExpenseDraft({ destination: ExpenseDestination.DAILY }))

      expect(savedInput().data.tripId).toBeUndefined()
      expect(saved.trip).toBeNull()
    })
  })

  describe('budget impact (P19)', () => {
    it('should count a day-to-day expense in the month of its date', async () => {
      const saved = await service.save(
        buildExpenseDraft({ destination: ExpenseDestination.DAILY, spentAt: new Date('2026-08-31T00:00:00.000Z') }),
      )

      expect(saved.budget).toEqual({
        personId: 'person-danery',
        categoryId: 'category-food',
        period: { paymentMonth: 8, paymentYear: 2026 },
        amount: 25,
      })
    })

    it('should leave subscriptions (card charges, D46), debts and other currencies out of the budget', async () => {
      const subscription = await service.save(
        buildExpenseDraft({ destination: ExpenseDestination.SUBSCRIPTION, period: SubscriptionPeriod.MONTHLY }),
      )
      const debt = await service.save(buildExpenseDraft({ destination: ExpenseDestination.RECEIVABLE }))
      const dollars = await service.save(buildExpenseDraft({ destination: ExpenseDestination.DAILY, currency: 'USD' }))

      expect([subscription.budget, debt.budget, dollars.budget]).toEqual([null, null, null])
    })

    it('should count a platform when Plataformas suman is on and no credit card paid it (D96, D107)', async () => {
      mockBudgetSettingDBRepository.get.mockResolvedValue({ recurringCount: true, platformsCount: true })
      const draft = { destination: ExpenseDestination.SUBSCRIPTION, period: SubscriptionPeriod.MONTHLY, amount: 30 }

      mockPaymentMethodDBRepository.findById.mockResolvedValueOnce({ type: PaymentMethodType.DEBIT_CARD })
      const byDebit = await service.save(buildExpenseDraft(draft))
      mockPaymentMethodDBRepository.findById.mockResolvedValueOnce({ type: PaymentMethodType.CREDIT_CARD })
      const byCard = await service.save(buildExpenseDraft(draft))

      expect(byDebit.budget).toEqual(expect.objectContaining({ amount: 30 }))
      expect(byCard.budget).toBeNull()
    })
  })
})
