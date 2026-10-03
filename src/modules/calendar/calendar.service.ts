import { statementBalances } from '@/modules/statements/statement.balance'
import { Injectable } from '@nestjs/common'

import { APP_TIME_ZONE } from '@/commons/constants/app.constant'
import { CalendarEventKind, CalendarEventStatus, PaymentOutcome } from '@/commons/constants/calendar.constant'
import { DebtDirection, DebtStatus, toCents } from '@/commons/constants/debt.constant'
import { NotificationRefType, UNPAID_STATUSES } from '@/commons/constants/notification.constant'
import { AppException } from '@/commons/exceptions/app.exception'
import { DateHelper } from '@/commons/helpers/date.helper'
import { addMonths, comparePeriods, PaymentPeriod } from '@/commons/helpers/payment-period.helper'
import { isDue } from '@/commons/helpers/recurring.helper'
import { CalendarDBRepository } from '@/db/models/calendar/calendarDB.repository'
import { StatementDBRepository } from '@/db/models/statement/statementDB.repository'
import { DebtsService } from '@/modules/debts/debts.service'
import { normalizeText } from '@/modules/expense-extraction/expense-extraction.catalog'

import {
  dayOf,
  isoDate,
  parseInstallment,
  periodKey,
  periodOf,
  periodsBetween,
  statementDates,
} from './calendar.helper'

// One day of the payment calendar. Names are the ones of the catalog or the expense: channels write the labels
export interface CalendarEvent {
  date: string // YYYY-MM-DD
  kind: CalendarEventKind
  name: string // card, expense or debt description
  personName: string | null // debts
  installment: string | null // "3/10"
  amount: number | null // what is still to pay (the total when it is paid); null: a closing day with nothing yet
  currency: string
  status: CalendarEventStatus
  refType: NotificationRefType | null
  refId: string | null
  color: string | null // the card color
}

export interface InstallmentItem {
  paymentMethodId: string
  description: string
  installment: string
  amount: number // PEN
  month: number
  year: number
  estimated: boolean // "por generar": the next installments of a series only partly saved (D45), same amount
}

export interface CommittedInstallments {
  months: { month: number; year: number; total: number }[]
  cards: {
    paymentMethodId: string
    name: string
    color: string | null
    total: number
    months: { month: number; year: number; amount: number; count: number; estimated: number }[]
  }[]
  items: InstallmentItem[]
}

// New reminders use "<paymentMethodId>@<yyyy>-<mm>:<currency>"; legacy references without a currency still parse.
export const cardStatementRef = (paymentMethodId: string, period: PaymentPeriod, currency?: string) =>
  `${paymentMethodId}@${periodKey(period)}${currency ? `:${currency}` : ''}`

export function parseCardStatementRef(
  ref: string,
): { paymentMethodId: string; period: PaymentPeriod; currency?: string } | null {
  const match = /^(.+)@(\d{4})-(\d{2})(?::(PEN|USD))?$/.exec(ref)
  if (!match) return null
  return {
    paymentMethodId: match[1],
    period: { paymentYear: Number(match[2]), paymentMonth: Number(match[3]) },
    ...(match[4] ? { currency: match[4] } : {}),
  }
}

const statusOf = (paid: boolean, date: string, today: string) =>
  paid ? CalendarEventStatus.PAID : date < today ? CalendarEventStatus.LATE : CalendarEventStatus.PENDING

const outcomeOf = (paid: boolean | null) =>
  paid === null ? PaymentOutcome.NOT_FOUND : paid ? PaymentOutcome.PAID : PaymentOutcome.ALREADY_PAID

const amountOf = (row: { amount: number; amountInPen: number | null }) => row.amountInPen ?? row.amount

// Payment calendar (P20, D89): card closing and payment days, due dates of fixed costs, subscriptions and debts, and
// the recurring expenses still to be generated. Computed on every call from the expense tables.
@Injectable()
export class CalendarService {
  constructor(
    private readonly calendarDBRepository: CalendarDBRepository,
    private readonly debtsService: DebtsService,
    private readonly statementDBRepository: StatementDBRepository,
  ) {}

  // ✅ Pagado of a reminder (bot) or of the calendar (web): the unpaid rows of a card statement, a fixed cost, a
  // subscription, or the whole balance of a debt installment
  async pay(refType: NotificationRefType | string | null, refId: string): Promise<PaymentOutcome> {
    const paidAt = new Date(`${DateHelper.todayIn(APP_TIME_ZONE)}T00:00:00.000Z`)
    try {
      switch (refType) {
        case NotificationRefType.CARD_STATEMENT: {
          const ref = parseCardStatementRef(refId)
          if (!ref) return PaymentOutcome.NOT_FOUND
          const count = await this.calendarDBRepository.payCardStatement(ref.paymentMethodId, ref.period, ref.currency)
          return count > 0 ? PaymentOutcome.PAID : PaymentOutcome.NOTHING_TO_PAY
        }
        case NotificationRefType.FIXED_COST:
          return outcomeOf(await this.calendarDBRepository.payFixedCost(refId, paidAt))
        case NotificationRefType.SUBSCRIPTION:
          return outcomeOf(await this.calendarDBRepository.paySubscription(refId, paidAt))
        case NotificationRefType.DEBT: {
          const debt = await this.debtsService.get(refId)
          if (debt.balance <= 0) return PaymentOutcome.ALREADY_PAID
          await this.debtsService.addPayment(refId, { amount: debt.balance, paidAt })
          return PaymentOutcome.PAID
        }
        default:
          return PaymentOutcome.NOT_FOUND
      }
    } catch (error) {
      // The expense or debt was deleted after the reminder
      if (error instanceof AppException) return PaymentOutcome.NOT_FOUND
      throw error
    }
  }

  async events(from: string, to: string, today: string = DateHelper.todayIn(APP_TIME_ZONE)): Promise<CalendarEvent[]> {
    const [cards, fixedCosts, subscriptions, debts, recurring] = await Promise.all([
      this.cardEvents(from, to, today),
      this.calendarDBRepository.findFixedCostsDue(from, to),
      this.calendarDBRepository.findSubscriptionsDue(from, to),
      this.calendarDBRepository.findDebtsDue(from, to),
      this.calendarDBRepository.findActiveRecurring(),
    ])

    const dueRows = [
      ...fixedCosts.map((row) => ({
        ...row,
        kind: CalendarEventKind.FIXED_COST,
        refType: NotificationRefType.FIXED_COST,
      })),
      ...subscriptions.map((row) => ({
        ...row,
        kind: CalendarEventKind.SUBSCRIPTION,
        refType: NotificationRefType.SUBSCRIPTION,
      })),
    ].map((row): CalendarEvent => {
      const date = isoDate(row.dueDate!)
      return {
        date,
        kind: row.kind,
        name: row.description,
        personName: null,
        installment: null,
        amount: row.amount,
        currency: row.currency,
        status: statusOf(!UNPAID_STATUSES.includes(row.paymentStatus), date, today),
        refType: row.refType,
        refId: row.id,
        color: null,
      }
    })

    const debtEvents = debts.map((debt): CalendarEvent => {
      const date = isoDate(debt.dueDate!)
      const paid = debt.status === DebtStatus.PAID || debt.status === DebtStatus.PREPAID
      return {
        date,
        kind: debt.direction === DebtDirection.I_OWE ? CalendarEventKind.DEBT_I_OWE : CalendarEventKind.DEBT_OWED_TO_ME,
        name: debt.description,
        personName: debt.person.name,
        installment: debt.installment,
        amount: paid ? debt.amount : toCents(debt.amount - debt.paidAmount),
        currency: debt.currency,
        status: statusOf(paid, date, today),
        refType: NotificationRefType.DEBT,
        refId: debt.id,
        color: null,
      }
    })

    // Recurring expenses (D88) show up on their day until the job of the 1st creates their rows for that month
    const current = periodOf(today)
    const recurringEvents = recurring.flatMap((item) =>
      periodsBetween(from, to)
        .filter((period) => comparePeriods(period, current) >= 0)
        .filter(
          (period) =>
            !item.lastGeneratedAt ||
            (comparePeriods(periodOf(isoDate(item.lastGeneratedAt)), period) < 0 &&
              isDue(
                item.period,
                item.lastGeneratedAt,
                new Date(Date.UTC(period.paymentYear, period.paymentMonth - 1, 1)),
              )),
        )
        .map((period): CalendarEvent => {
          const date = dayOf(period.paymentYear, period.paymentMonth, item.dayOfMonth)
          return {
            date,
            kind: CalendarEventKind.RECURRING,
            name: item.description,
            personName: null,
            installment: null,
            amount: item.amount,
            currency: item.currency,
            status: statusOf(false, date, today),
            refType: null,
            refId: item.id,
            color: null,
          }
        })
        .filter((event) => event.date >= from && event.date <= to),
    )

    return [...cards, ...dueRows, ...debtEvents, ...recurringEvents].sort(
      (a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
    )
  }

  // What is due from today on, for the reminders list (Redis ntf:upcoming) and /calendario
  upcoming(days: number, today: string = DateHelper.todayIn(APP_TIME_ZONE)): Promise<CalendarEvent[]> {
    return this.events(today, DateHelper.addDays(today, days), today)
  }

  // Cuotas comprometidas (D89): the installments of every card for the next `months` payment months, including the
  // ones "por generar" of a series saved only up to some installment (same amount as its last saved one)
  async installments(
    months: number,
    today: string = DateHelper.todayIn(APP_TIME_ZONE),
  ): Promise<CommittedInstallments> {
    const first = periodOf(today)
    const window = Array.from({ length: months }, (_, index) => addMonths(first, index))
    const inWindow = (period: PaymentPeriod) =>
      comparePeriods(period, first) >= 0 && comparePeriods(period, window[window.length - 1]) <= 0

    const [cards, rows] = await Promise.all([
      this.calendarDBRepository.findActiveCards(),
      this.calendarDBRepository.findCardInstallments(),
    ])

    const items: InstallmentItem[] = []
    const series = new Map<string, typeof rows>()
    for (const row of rows) {
      const parsed = parseInstallment(row.installment)
      if (!parsed) continue
      const key =
        row.originDraftId ??
        row.draftId ??
        `${row.paymentMethodId}|${normalizeText(row.description)}|${parsed.total}|${toCents(amountOf(row))}`
      series.set(key, [...(series.get(key) ?? []), row])

      const period = { paymentMonth: row.paymentMonth, paymentYear: row.paymentYear }
      if (inWindow(period)) {
        items.push({
          paymentMethodId: row.paymentMethodId,
          description: row.description,
          installment: row.installment!,
          amount: toCents(amountOf(row)),
          month: row.paymentMonth,
          year: row.paymentYear,
          estimated: false,
        })
      }
    }

    for (const seriesRows of series.values()) {
      const last = seriesRows
        .map((row) => ({ row, parsed: parseInstallment(row.installment)! }))
        .sort((a, b) => b.parsed.current - a.parsed.current)[0]
      const lastPeriod = { paymentMonth: last.row.paymentMonth, paymentYear: last.row.paymentYear }
      for (let current = last.parsed.current + 1; current <= last.parsed.total; current++) {
        const period = addMonths(lastPeriod, current - last.parsed.current)
        if (!inWindow(period)) continue
        items.push({
          paymentMethodId: last.row.paymentMethodId,
          description: last.row.description,
          installment: `${current}/${last.parsed.total}`,
          amount: toCents(amountOf(last.row)),
          month: period.paymentMonth,
          year: period.paymentYear,
          estimated: true,
        })
      }
    }

    const sumOf = (list: InstallmentItem[]) => toCents(list.reduce((sum, item) => sum + item.amount, 0))
    const ofPeriod = (list: InstallmentItem[], period: PaymentPeriod) =>
      list.filter((item) => item.month === period.paymentMonth && item.year === period.paymentYear)
    const cardIds = new Set(items.map((item) => item.paymentMethodId))

    return {
      months: window.map((period) => ({
        month: period.paymentMonth,
        year: period.paymentYear,
        total: sumOf(ofPeriod(items, period)),
      })),
      cards: cards
        .filter((card) => cardIds.has(card.id))
        .map((card) => {
          const ofCard = items.filter((item) => item.paymentMethodId === card.id)
          return {
            paymentMethodId: card.id,
            name: card.name,
            color: card.color,
            total: sumOf(ofCard),
            months: window.map((period) => {
              const list = ofPeriod(ofCard, period)
              return {
                month: period.paymentMonth,
                year: period.paymentYear,
                amount: sumOf(list),
                count: list.length,
                estimated: list.filter((item) => item.estimated).length,
              }
            }),
          }
        }),
      items: items.sort((a, b) => a.year - b.year || a.month - b.month || a.description.localeCompare(b.description)),
    }
  }

  // Closing and payment day of every active card whose statement touches the range
  private async cardEvents(from: string, to: string, today: string): Promise<CalendarEvent[]> {
    const cards = (await this.calendarDBRepository.findActiveCards()).filter(
      (card) => card.billingCloseDay && card.paymentDueDay,
    )
    if (!cards.length) return []

    // A statement is paid up to a month after it closes: the month before `from` may be due inside the range
    const periods = periodsBetween(DateHelper.addDays(from, -31), to)
    const [rows, statements] = await Promise.all([
      this.calendarDBRepository.findCardRows(periods),
      this.statementDBRepository.findForPeriods(periods),
    ])

    return cards.flatMap((card) =>
      periods.flatMap((period) => {
        const dates = statementDates(card.billingCloseDay!, card.paymentDueDay!, period)
        // A statement read from the bank (P14, D95) has the real due date and total to pay
        const statement = statements.find(
          (candidate) =>
            candidate.paymentMethodId === card.id &&
            candidate.paymentMonth === period.paymentMonth &&
            candidate.paymentYear === period.paymentYear,
        )
        const closeDate = dates.closeDate
        const dueDate = statement?.dueDate ? isoDate(statement.dueDate) : dates.dueDate
        const ofStatement = rows.filter(
          (row) =>
            row.paymentMethodId === card.id &&
            row.paymentMonth === period.paymentMonth &&
            row.paymentYear === period.paymentYear,
        )
        const balances = statement ? statementBalances(statement) : []
        const currencies = new Set([
          ...ofStatement.map((row) => row.currency),
          ...balances.map((balance) => balance.currency),
        ])
        if (!currencies.size) currencies.add('PEN')
        const events: CalendarEvent[] = []
        for (const currency of currencies) {
          const currencyRows = ofStatement.filter((row) => row.currency === currency)
          const total = toCents(currencyRows.reduce((sum, row) => sum + row.amount, 0))
          const unpaid = toCents(
            currencyRows
              .filter((row) => UNPAID_STATUSES.includes(row.paymentStatus))
              .reduce((sum, row) => sum + row.amount, 0),
          )
          const base = {
            name: card.name,
            personName: null,
            installment: null,
            currency,
            refType: NotificationRefType.CARD_STATEMENT,
            refId: cardStatementRef(card.id, period, currency),
            color: card.color,
          }
          if (closeDate >= from && closeDate <= to) {
            events.push({
              ...base,
              date: closeDate,
              kind: CalendarEventKind.CARD_CLOSE,
              amount: total || null,
              status: closeDate < today ? CalendarEventStatus.PAID : CalendarEventStatus.PENDING,
            })
          }
          const bankTotal = balances.find((balance) => balance.currency === currency)?.totalDue ?? null
          if (dueDate >= from && dueDate <= to && (total > 0 || (bankTotal ?? 0) > 0)) {
            const paid = total > 0 && unpaid === 0
            events.push({
              ...base,
              date: dueDate,
              kind: CalendarEventKind.CARD_DUE,
              amount: !paid && bankTotal ? bankTotal : unpaid || total,
              status: statusOf(paid, dueDate, today),
            })
          }
        }
        return events
      }),
    )
  }
}
