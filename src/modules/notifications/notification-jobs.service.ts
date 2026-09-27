import { Injectable, Logger } from '@nestjs/common'

import { APP_TIME_ZONE } from '@/commons/constants/app.constant'
import { CalendarEventKind, CalendarEventStatus } from '@/commons/constants/calendar.constant'
import { DebtDirection, toCents } from '@/commons/constants/debt.constant'
import { ANOMALY_LOOKBACK_DAYS, NotificationJob } from '@/commons/constants/notification.constant'
import { dayStart, ownPen } from '@/commons/helpers/charge.helper'
import { DateHelper } from '@/commons/helpers/date.helper'
import { addMonths } from '@/commons/helpers/payment-period.helper'
import { CalendarDBRepository } from '@/db/models/calendar/calendarDB.repository'
import { ChargeDbDto } from '@/db/models/expense/expenseDB.dto'
import { ExpenseDBRepository } from '@/db/models/expense/expenseDB.repository'
import { PersonDBRepository } from '@/db/models/person/personDB.repository'
import { BudgetService } from '@/modules/budget/budget.service'
import { CalendarService } from '@/modules/calendar/calendar.service'
import { isoDate, periodOf } from '@/modules/calendar/calendar.helper'
import { DebtsService } from '@/modules/debts/debts.service'
import { RecurringExpensesService } from '@/modules/expenses/recurring-expenses.service'
import { StoredFilesService } from '@/modules/stored-files/stored-files.service'

import {
  budgetNotice,
  collectLateNotice,
  collectMonthNotice,
  dailyCloseNotice,
  dueNotice,
  duplicateNotice,
  notChargedNotice,
  priceChangeNotice,
  recurringNotice,
  weeklyNotice,
} from './notification.messages'
import { budgetAlerts, ChargeRow, duplicateCharges, notCharged, priceChanges } from './notification.rules'
import { NotificationsService } from './notifications.service'

export interface JobResult {
  job: NotificationJob
  notifications: number // created in this run (the ones that already existed are not counted)
  details?: Record<string, unknown>
}

const toChargeRow = (row: ChargeDbDto): ChargeRow => ({
  id: row.id,
  source: row.source,
  description: row.description,
  amount: row.amount,
  currency: row.currency,
  paymentMethodId: row.paymentMethodId,
  date: isoDate(row.date),
})

// The scheduled jobs of P20 (D87), run by the BullMQ worker at their time (America/Lima) or by hand with
// POST /v1/notifications/run/:job. Each notice has a dedupeKey, so running a job twice sends nothing twice.
@Injectable()
export class NotificationJobsService {
  private readonly logger = new Logger(NotificationJobsService.name)

  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly calendarService: CalendarService,
    private readonly calendarDBRepository: CalendarDBRepository,
    private readonly expenseDBRepository: ExpenseDBRepository,
    private readonly personDBRepository: PersonDBRepository,
    private readonly budgetService: BudgetService,
    private readonly debtsService: DebtsService,
    private readonly recurringExpensesService: RecurringExpensesService,
    private readonly storedFilesService: StoredFilesService,
  ) {}

  async run(job: NotificationJob, now: Date = new Date()): Promise<JobResult> {
    const today = DateHelper.todayIn(APP_TIME_ZONE, now)
    const result = await this.runJob(job, today)
    this.logger.log(`[run] ${job}: ${result.notifications} notification(s)`)
    return result
  }

  private async runJob(job: NotificationJob, today: string): Promise<JobResult> {
    switch (job) {
      case NotificationJob.RECURRING:
        return this.recurring(today)
      case NotificationJob.DUE_REMINDERS:
        return this.dueReminders(today)
      case NotificationJob.DAILY_CLOSE:
        return this.dailyClose(today)
      case NotificationJob.WEEKLY:
        return this.weekly(today)
      case NotificationJob.UPCOMING_REFRESH: {
        const events = await this.notificationsService.refreshUpcoming()
        return { job, notifications: 0, details: { events: events.length } }
      }
      case NotificationJob.FILES_CLEANUP: {
        const deleted = await this.storedFilesService.deleteExpired()
        return { job, notifications: 0, details: { deleted } }
      }
      case NotificationJob.COLLECT_MONTH:
        return this.collect(job, today, false)
      case NotificationJob.COLLECT_LATE:
        return this.collect(job, today, true)
    }
  }

  // Cobros (P30): day 1, what each person owes this month; day 5, what they still owe from earlier months. One notice
  // per person, so each can be forwarded as it is
  private async collect(job: NotificationJob, today: string, late: boolean): Promise<JobResult> {
    const { paymentMonth: month, paymentYear: year } = periodOf(today)
    const previous = addMonths({ paymentMonth: month, paymentYear: year }, -1)
    const debts = (
      await this.debtsService.list({
        direction: DebtDirection.OWED_TO_ME,
        ...(late ? { month: previous.paymentMonth, year: previous.paymentYear, until: true } : { month, year }),
      })
    ).filter((debt) => debt.balance > 0)

    const byPerson = new Map<string, typeof debts>()
    debts.forEach((debt) => byPerson.set(debt.personId, [...(byPerson.get(debt.personId) ?? []), debt]))
    let created = 0
    for (const owed of byPerson.values()) {
      const notice = late ? collectLateNotice : collectMonthNotice
      created += await this.notify(notice(owed[0].person, owed, month, year))
    }
    return { job, notifications: created, details: { people: byPerson.size } }
  }

  // Day 1, 06:00 (D88): the pending rows of the month, and one notice that lists them
  private async recurring(today: string): Promise<JobResult> {
    const { paymentMonth, paymentYear } = periodOf(today)
    const generation = await this.recurringExpensesService.generate(paymentMonth, paymentYear)
    const created = generation.created.length ? await this.notify(recurringNotice(generation)) : 0
    if (generation.created.length) await this.notificationsService.refreshUpcoming()
    return {
      job: NotificationJob.RECURRING,
      notifications: created,
      details: { created: generation.created.length, skipped: generation.skipped },
    }
  }

  // 09:00: what closes or is due tomorrow and is not paid yet
  private async dueReminders(today: string): Promise<JobResult> {
    const tomorrow = DateHelper.addDays(today, 1)
    const events = (await this.calendarService.events(tomorrow, tomorrow, today)).filter(
      (event) => event.kind !== CalendarEventKind.RECURRING && event.status !== CalendarEventStatus.PAID,
    )
    let created = 0
    for (const event of events) created += await this.notify(dueNotice(event))
    return { job: NotificationJob.DUE_REMINDERS, notifications: created, details: { events: events.length } }
  }

  // 21:00: today's expenses and what is still due today, the budget alerts and the cargos raros
  private async dailyClose(today: string): Promise<JobResult> {
    const tomorrow = DateHelper.addDays(today, 1)
    const [todayCharges, dueToday] = await Promise.all([
      this.expenseDBRepository.findChargesBetween(dayStart(today), dayStart(tomorrow)),
      this.calendarService.events(today, today, today),
    ])
    const unpaidToday = dueToday.filter(
      (event) => event.kind !== CalendarEventKind.CARD_CLOSE && event.status !== CalendarEventStatus.PAID,
    )
    let created = await this.notify(
      dailyCloseNotice(
        today,
        todayCharges.map((row) => ({ ...toChargeRow(row), own: ownPen(row) })),
        unpaidToday,
      ),
    )

    const { paymentMonth, paymentYear } = periodOf(today)
    const lines = budgetAlerts(await this.budgetService.byCategory(paymentMonth, paymentYear))
    for (const line of lines) created += await this.notify(budgetNotice(line, paymentMonth, paymentYear))

    const anomalies = await this.anomalies(today)
    for (const notice of anomalies) created += await this.notify(notice)

    return {
      job: NotificationJob.DAILY_CLOSE,
      notifications: created,
      details: { expenses: todayCharges.length, budgetAlerts: lines.length, anomalies: anomalies.length },
    }
  }

  // Cargos raros (D86): price changes and duplicates among the expenses of the last days, and monthly
  // subscriptions not charged 3 days after their due date
  private async anomalies(today: string) {
    const current = periodOf(today)
    const previous = addMonths(current, -1)
    const lookback = dayStart(DateHelper.addDays(today, -ANOMALY_LOOKBACK_DAYS))
    const [recent, cardMonths, subscriptions] = await Promise.all([
      this.expenseDBRepository.findChargesCreatedSince(lookback),
      this.expenseDBRepository.findChargesBetween(
        dayStart(`${previous.paymentYear}-${String(previous.paymentMonth).padStart(2, '0')}-01`),
        dayStart(DateHelper.addDays(today, 1)),
      ),
      this.calendarDBRepository.findSubscriptions([previous, current]),
    ])

    const recentRows = recent.map(toChargeRow)
    const cardRows = cardMonths.filter((row) => row.source === 'card').map(toChargeRow)
    const subscriptionRows = subscriptions.map((row) => ({
      ...row,
      dueDate: row.dueDate ? isoDate(row.dueDate) : null,
    }))
    const thisMonth = subscriptionRows.filter(
      (row) => row.paymentMonth === current.paymentMonth && row.paymentYear === current.paymentYear,
    )

    return [
      ...priceChanges(
        recentRows.filter((row) => row.source === 'card'),
        subscriptionRows,
        cardRows,
      ).map(priceChangeNotice),
      ...duplicateCharges(recentRows).map(duplicateNotice),
      ...notCharged(thisMonth, cardRows, today).map(notChargedNotice),
    ]
  }

  // Sunday 20:00: the last 7 days, the budget of the month, the debts and what is due next week
  private async weekly(today: string): Promise<JobResult> {
    const from = DateHelper.addDays(today, -6)
    const { paymentMonth, paymentYear } = periodOf(today)
    const owner = await this.personDBRepository.findDefault()
    const [week, month, debts, nextWeek] = await Promise.all([
      this.expenseDBRepository.findChargesBetween(dayStart(from), dayStart(DateHelper.addDays(today, 1))),
      this.budgetService.month(paymentMonth, paymentYear),
      this.debtsService.summary(),
      this.calendarService.events(DateHelper.addDays(today, 1), DateHelper.addDays(today, 7), today),
    ])

    const created = await this.notify(
      weeklyNotice({
        from,
        to: today,
        // The budget counts only your expenses (D71)
        spent: toCents(
          week.filter((row) => !owner || row.personId === owner.id).reduce((sum, row) => sum + ownPen(row), 0),
        ),
        month: paymentMonth,
        year: paymentYear,
        budgetLimit: month.budget?.limit ?? null,
        spentThisMonth: month.spentPen,
        surplus: month.surplus,
        owedToMe: toCents(debts.reduce((sum, person) => sum + person.owedToMe, 0)),
        late: toCents(debts.reduce((sum, person) => sum + person.late, 0)),
        iOwe: toCents(debts.reduce((sum, person) => sum + person.iOwe, 0)),
        nextWeek,
      }),
    )
    return { job: NotificationJob.WEEKLY, notifications: created }
  }

  private async notify(input: Parameters<NotificationsService['notify']>[0]): Promise<number> {
    return (await this.notificationsService.notify(input)) ? 1 : 0
  }
}
