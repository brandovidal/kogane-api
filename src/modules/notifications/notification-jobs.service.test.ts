import { Test } from '@nestjs/testing'
import { vi } from 'vitest'

import { BudgetStatus } from '@/commons/constants/budget.constant'
import { CalendarEventKind, CalendarEventStatus } from '@/commons/constants/calendar.constant'
import { NotificationJob, NotificationKind, NotificationRefType } from '@/commons/constants/notification.constant'
import { CalendarDBRepository } from '@/db/models/calendar/calendarDB.repository'
import { ExpenseDBRepository } from '@/db/models/expense/expenseDB.repository'
import { PersonDBRepository } from '@/db/models/person/personDB.repository'
import { BudgetService } from '@/modules/budget/budget.service'
import { CalendarEvent, CalendarService } from '@/modules/calendar/calendar.service'
import { DebtsService } from '@/modules/debts/debts.service'
import { RecurringExpensesService } from '@/modules/expenses/recurring-expenses.service'
import { StoredFilesService } from '@/modules/stored-files/stored-files.service'

import { NotificationJobsService } from './notification-jobs.service'
import { NotificationsService } from './notifications.service'

// Thursday 2026-09-24, 09:00 in Lima
const NOW = new Date('2026-09-24T14:00:00Z')

const mockNotifications = { notify: vi.fn(), refreshUpcoming: vi.fn() }
const mockCalendar = { events: vi.fn() }
const mockCalendarDB = { findSubscriptions: vi.fn() }
const mockExpenseDB = { findChargesBetween: vi.fn(), findChargesCreatedSince: vi.fn() }
const mockPersonDB = { findDefault: vi.fn() }
const mockBudget = { byCategory: vi.fn(), month: vi.fn() }
const mockDebts = { summary: vi.fn(), list: vi.fn(), listByIds: vi.fn() }
const mockRecurring = { generate: vi.fn() }
const mockStoredFiles = { deleteExpired: vi.fn() }

const event = (overrides: Partial<CalendarEvent>): CalendarEvent => ({
  date: '2026-09-25',
  kind: CalendarEventKind.FIXED_COST,
  name: 'Luz',
  personName: null,
  installment: null,
  amount: 120,
  currency: 'PEN',
  status: CalendarEventStatus.PENDING,
  refType: NotificationRefType.FIXED_COST,
  refId: 'f1',
  color: null,
  ...overrides,
})

const charge = (overrides: Record<string, unknown>) => ({
  id: 'c1',
  source: 'daily',
  description: 'Almuerzo',
  amount: 30,
  othersShare: 10,
  currency: 'PEN',
  amountInPen: 30,
  paymentMethodId: 'yape',
  personId: 'me',
  date: new Date('2026-09-24T00:00:00Z'),
  createdAt: NOW,
  ...overrides,
})

describe('NotificationJobsService', () => {
  let service: NotificationJobsService

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        NotificationJobsService,
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: CalendarService, useValue: mockCalendar },
        { provide: CalendarDBRepository, useValue: mockCalendarDB },
        { provide: ExpenseDBRepository, useValue: mockExpenseDB },
        { provide: PersonDBRepository, useValue: mockPersonDB },
        { provide: BudgetService, useValue: mockBudget },
        { provide: DebtsService, useValue: mockDebts },
        { provide: RecurringExpensesService, useValue: mockRecurring },
        { provide: StoredFilesService, useValue: mockStoredFiles },
      ],
    }).compile()
    service = module.get(NotificationJobsService)
    mockNotifications.notify.mockImplementation(async (input) => ({ id: input.dedupeKey }))
    mockCalendar.events.mockResolvedValue([])
    mockExpenseDB.findChargesBetween.mockResolvedValue([])
    mockExpenseDB.findChargesCreatedSince.mockResolvedValue([])
    mockCalendarDB.findSubscriptions.mockResolvedValue([])
    mockBudget.byCategory.mockResolvedValue([])
    mockPersonDB.findDefault.mockResolvedValue({ id: 'me' })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('should remind what closes or is due tomorrow and is not paid, never a recurring expense', async () => {
    mockCalendar.events.mockResolvedValue([
      event({}),
      event({
        kind: CalendarEventKind.CARD_CLOSE,
        name: 'IO',
        refType: NotificationRefType.CARD_STATEMENT,
        refId: 'io@2026-09',
      }),
      event({ refId: 'f2', status: CalendarEventStatus.PAID }),
      event({ kind: CalendarEventKind.RECURRING, refType: null, refId: 'rec' }),
    ])

    const result = await service.run(NotificationJob.DUE_REMINDERS, NOW)

    expect(mockCalendar.events).toHaveBeenCalledWith('2026-09-25', '2026-09-25', '2026-09-24')
    expect(result).toEqual({ job: NotificationJob.DUE_REMINDERS, notifications: 2, details: { events: 2 } })
    expect(mockNotifications.notify.mock.calls.map(([input]) => [input.kind, input.dedupeKey])).toEqual([
      [NotificationKind.DUE, 'due:fixed_cost:f1:2026-09-25'],
      [NotificationKind.CARD_CLOSE, 'due:card_close:io@2026-09:2026-09-25'],
    ])
  })

  it('should not count a notice that already existed', async () => {
    mockCalendar.events.mockResolvedValue([event({})])
    mockNotifications.notify.mockResolvedValue(null)

    expect((await service.run(NotificationJob.DUE_REMINDERS, NOW)).notifications).toBe(0)
  })

  it('should close the day with your part of today, what is due today, the budget and the cargos raros', async () => {
    mockExpenseDB.findChargesBetween.mockResolvedValue([charge({})])
    mockCalendar.events.mockResolvedValue([event({ date: '2026-09-24' })])
    mockBudget.byCategory.mockResolvedValue([
      { categoryId: 'food', name: 'Comida', spent: 850, limit: 1000, percent: 85, status: BudgetStatus.WARNING },
    ])
    mockExpenseDB.findChargesCreatedSince.mockResolvedValue([
      charge({ id: 'a', source: 'card', description: 'Rappi', paymentMethodId: 'io' }),
      charge({ id: 'b', source: 'card', description: 'RAPPI', paymentMethodId: 'io' }),
    ])

    const result = await service.run(NotificationJob.DAILY_CLOSE, NOW)

    const [daily, budget, duplicate] = mockNotifications.notify.mock.calls.map(([input]) => input)
    expect(daily).toMatchObject({ kind: NotificationKind.DAILY_CLOSE, amount: 20, dedupeKey: 'daily:2026-09-24' })
    expect(daily.body).toContain('⏰ Vence hoy sin pagar: Luz S/ 120.00')
    expect(budget).toMatchObject({ kind: NotificationKind.BUDGET, dedupeKey: 'budget:food:2026-09:warning' })
    expect(duplicate).toMatchObject({ kind: NotificationKind.ANOMALY, dedupeKey: 'anomaly:dup:a:b' })
    expect(result.details).toEqual({ expenses: 1, budgetAlerts: 1, anomalies: 1 })
  })

  it('should create the recurring expenses of the month and tell it once', async () => {
    mockRecurring.generate.mockResolvedValue({
      month: 9,
      year: 2026,
      created: [{ description: 'Alquiler', amount: 1200, currency: 'PEN', date: '2026-09-05' }],
      skipped: [],
    })

    const result = await service.run(NotificationJob.RECURRING, NOW)

    expect(mockRecurring.generate).toHaveBeenCalledWith(9, 2026)
    expect(mockNotifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: NotificationKind.RECURRING, dedupeKey: 'recurring:2026-09', amount: 1200 }),
    )
    expect(mockNotifications.refreshUpcoming).toHaveBeenCalled()
    expect(result.notifications).toBe(1)
  })

  it('should not notify a month without new recurring expenses', async () => {
    mockRecurring.generate.mockResolvedValue({ month: 9, year: 2026, created: [], skipped: [] })

    expect((await service.run(NotificationJob.RECURRING, NOW)).notifications).toBe(0)
    expect(mockNotifications.notify).not.toHaveBeenCalled()
  })

  it('should sum up the week with your expenses only, the budget, the debts and the next payments', async () => {
    mockExpenseDB.findChargesBetween.mockResolvedValue([
      charge({}),
      charge({ id: 'c2', personId: 'dany', othersShare: 0 }),
    ])
    mockBudget.month.mockResolvedValue({ budget: { limit: 2000 }, spentPen: 500, surplus: 1500 })
    mockDebts.summary.mockResolvedValue([{ owedToMe: 100, late: 40, iOwe: 30 }])
    mockCalendar.events.mockResolvedValue([event({ date: '2026-09-28' })])

    await service.run(NotificationJob.WEEKLY, NOW)

    const [weekly] = mockNotifications.notify.mock.calls[0]
    expect(mockCalendar.events).toHaveBeenCalledWith('2026-09-25', '2026-10-01', '2026-09-24')
    expect(weekly).toMatchObject({ kind: NotificationKind.WEEKLY, amount: 20, dedupeKey: 'weekly:2026-09-24' })
    expect(weekly.body).toBe(
      [
        'Del vie 18/09 al jue 24/09 gastaste S/ 20.00 (tu parte).',
        'Presupuesto de setiembre: te quedan S/ 1500.00 (25 % usado).',
        'Excedente del mes: S/ 1500.00.',
        'Deudas: te deben S/ 100.00 (S/ 40.00 atrasado) · debes S/ 30.00.',
        'Próximos 7 días: 1 pago por S/ 120.00.',
      ].join('\n'),
    )
  })

  it('should rebuild the upcoming list and clean the expired files', async () => {
    mockNotifications.refreshUpcoming.mockResolvedValue([event({})])
    mockStoredFiles.deleteExpired.mockResolvedValue(2)

    expect(await service.run(NotificationJob.UPCOMING_REFRESH, NOW)).toEqual({
      job: NotificationJob.UPCOMING_REFRESH,
      notifications: 0,
      details: { events: 1 },
    })
    expect((await service.run(NotificationJob.FILES_CLEANUP, NOW)).details).toEqual({ deleted: 2 })
  })

  describe('cobros (P30)', () => {
    const debt = (overrides: Record<string, unknown>) => ({
      personId: 'dany',
      person: { id: 'dany', name: 'Danery' },
      description: 'Zapatillas',
      installment: '2/3',
      paymentMonth: 10,
      paymentYear: 2026,
      balance: 100,
      currency: 'PEN',
      ...overrides,
    })

    it('should send on day 1 one notice per person with what they owe this month', async () => {
      mockDebts.list.mockResolvedValue([
        debt({}),
        debt({ description: 'Cine', installment: null, balance: 30 }),
        debt({ personId: 'dora', person: { id: 'dora', name: 'Dora' }, balance: 203.14 }),
        debt({ description: 'Pagada', balance: 0 }),
      ])

      const result = await service.run(NotificationJob.COLLECT_MONTH, new Date('2026-10-01T14:00:00Z'))

      expect(mockDebts.list).toHaveBeenCalledWith({ direction: 'owed_to_me', month: 10, year: 2026 })
      expect(result).toEqual(expect.objectContaining({ notifications: 2, details: { people: 2 } }))
      const [dany] = mockNotifications.notify.mock.calls.map(([input]) => input)
      expect(dany).toEqual(
        expect.objectContaining({
          kind: NotificationKind.COLLECT,
          amount: 130,
          refId: 'dany',
          dedupeKey: 'collect:dany:2026-10',
        }),
      )
      expect(dany.body).toContain('Zapatillas (cuota 2/3): S/ 100.00')
    })

    it('should send on day 5 what is still owed from the months before', async () => {
      mockDebts.list.mockResolvedValue([debt({ paymentMonth: 8 })])

      await service.run(NotificationJob.COLLECT_LATE, new Date('2026-10-05T14:00:00Z'))

      expect(mockDebts.list).toHaveBeenCalledWith({ direction: 'owed_to_me', month: 9, year: 2026, until: true })
      expect(mockNotifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          dedupeKey: 'collect-late:dany:2026-10',
          title: '⏰ Danery tiene S/ 100.00 atrasados',
        }),
      )
    })
    it('should send now the cobros of a month only to the chosen people, once per person and day', async () => {
      mockDebts.list.mockResolvedValue([
        debt({}),
        debt({ personId: 'dora', person: { id: 'dora', name: 'Dora' }, balance: 50 }),
      ])

      const result = await service.collectNow(
        { month: 9, year: 2026, personIds: ['dany'] },
        new Date('2026-10-10T14:00:00Z'),
      )

      expect(mockDebts.list).toHaveBeenCalledWith({ direction: 'owed_to_me', month: 9, year: 2026 })
      expect(result).toEqual(expect.objectContaining({ notifications: 1, details: { people: 1 } }))
      expect(mockNotifications.notify).toHaveBeenCalledTimes(1)
      expect(mockNotifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({ dedupeKey: 'collect:dany:2026-09:now:2026-10-10' }),
      )
    })

    it('should remind each person the selected debts that are still open, cobros and deudas apart', async () => {
      mockDebts.listByIds.mockResolvedValue([
        debt({ direction: 'owed_to_me' }),
        debt({ direction: 'owed_to_me', description: 'Cine', installment: null, balance: 30 }),
        debt({ direction: 'owed_to_me', description: 'Pagada', balance: 0 }),
        debt({ direction: 'i_owe', personId: 'dora', person: { id: 'dora', name: 'Dora' }, balance: 80 }),
      ])

      const result = await service.remindDebts(['a', 'b', 'c', 'd'], new Date('2026-10-10T14:00:00Z'))

      expect(result).toEqual(expect.objectContaining({ notifications: 2, details: { people: 2, skipped: 1 } }))
      const [owed, owe] = mockNotifications.notify.mock.calls.map(([input]) => input)
      expect(owed).toEqual(
        expect.objectContaining({ amount: 130, dedupeKey: 'remind-collect:dany:2026-10-10', refId: 'dany' }),
      )
      expect(owe).toEqual(
        expect.objectContaining({
          amount: 80,
          dedupeKey: 'remind-pay:dora:2026-10-10',
          title: expect.stringContaining('Recuerda pagar'),
        }),
      )
    })
  })
})
