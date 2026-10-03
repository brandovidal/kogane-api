import { Injectable } from '@nestjs/common'

import { PrismaService } from '@/db/prisma/prisma.service'
import { PaymentMethodType } from '@/commons/constants/catalog.constant'
import { Currency, PaymentStatus } from '@/commons/constants/expense.constant'
import { UNPAID_STATUSES } from '@/commons/constants/notification.constant'
import { PaymentPeriod } from '@/commons/helpers/payment-period.helper'

const dayStart = (isoDay: string) => new Date(`${isoDay}T00:00:00.000Z`)
const nextDayStart = (isoDay: string) => new Date(dayStart(isoDay).getTime() + 24 * 60 * 60_000)

const periodFilter = (periods: PaymentPeriod[]) => ({
  OR: periods.map(({ paymentMonth, paymentYear }) => ({ paymentMonth, paymentYear })),
})

const cardRowSelect = {
  id: true,
  description: true,
  amount: true,
  amountInPen: true,
  currency: true,
  paymentStatus: true,
  paymentMethodId: true,
  paymentMonth: true,
  paymentYear: true,
  installment: true,
  draftId: true,
  originDraftId: true,
} as const

// What the payment calendar and the reminders read (P20, D89): cards, due dates and recurring expenses.
// Dates are days at 00:00 UTC, like every date saved from the bot and the web.
@Injectable()
export class CalendarDBRepository {
  constructor(private readonly prisma: PrismaService) {}

  findActiveCards() {
    return this.prisma.paymentMethod.findMany({
      where: { type: PaymentMethodType.CREDIT_CARD, isActive: true },
      select: { id: true, name: true, code: true, color: true, billingCloseDay: true, paymentDueDay: true },
      orderBy: { name: 'asc' },
    })
  }

  // Every row of those card statements (to add up what is due and what is still unpaid)
  findCardRows(periods: PaymentPeriod[]) {
    if (!periods.length) return Promise.resolve([])
    return this.prisma.creditCardExpense.findMany({ where: periodFilter(periods), select: cardRowSelect })
  }

  // Rows in installments from that payment month on (cuotas comprometidas); the previous ones tell which series go on
  findCardInstallments() {
    return this.prisma.creditCardExpense.findMany({
      where: { installment: { not: null } },
      select: cardRowSelect,
    })
  }

  findFixedCostsDue(from: string, to: string) {
    return this.prisma.fixedCost.findMany({
      where: { dueDate: { gte: dayStart(from), lt: nextDayStart(to) } },
      select: {
        id: true,
        description: true,
        amount: true,
        currency: true,
        paymentStatus: true,
        dueDate: true,
        paymentMethodId: true,
      },
    })
  }

  findSubscriptionsDue(from: string, to: string) {
    return this.prisma.subscription.findMany({
      where: { dueDate: { gte: dayStart(from), lt: nextDayStart(to) } },
      select: {
        id: true,
        description: true,
        amount: true,
        currency: true,
        paymentStatus: true,
        dueDate: true,
        paymentMethodId: true,
      },
    })
  }

  findDebtsDue(from: string, to: string) {
    return this.prisma.debt.findMany({
      where: { dueDate: { gte: dayStart(from), lt: nextDayStart(to) } },
      select: {
        id: true,
        description: true,
        amount: true,
        paidAmount: true,
        currency: true,
        status: true,
        direction: true,
        dueDate: true,
        installment: true,
        person: { select: { id: true, name: true } },
      },
    })
  }

  // Subscriptions of those payment months (cargos raros: platform price and platforms not charged)
  findSubscriptions(periods: PaymentPeriod[]) {
    if (!periods.length) return Promise.resolve([])
    return this.prisma.subscription.findMany({
      where: periodFilter(periods),
      select: {
        id: true,
        description: true,
        amount: true,
        currency: true,
        period: true,
        paymentStatus: true,
        dueDate: true,
        paymentMonth: true,
        paymentYear: true,
      },
    })
  }

  findActiveRecurring() {
    return this.prisma.recurringExpense.findMany({ where: { isActive: true }, orderBy: { dayOfMonth: 'asc' } })
  }

  // ✅ Pagado of a card reminder: every unpaid row of that statement
  async payCardStatement(
    paymentMethodId: string,
    { paymentMonth, paymentYear }: PaymentPeriod,
    currency?: string,
  ): Promise<number> {
    const { count } = await this.prisma.creditCardExpense.updateMany({
      where: {
        paymentMethodId,
        paymentMonth,
        paymentYear,
        ...(currency ? { currency } : {}),
        paymentStatus: { in: UNPAID_STATUSES },
      },
      data: { paymentStatus: PaymentStatus.PAID },
    })
    return count
  }

  // ✅ Pagado of a fixed cost or a subscription reminder: true when paid now, false when it was already paid, null
  // when it does not exist anymore
  async payFixedCost(id: string, paymentDate: Date): Promise<boolean | null> {
    const { count } = await this.prisma.fixedCost.updateMany({
      where: { id, paymentStatus: { in: UNPAID_STATUSES } },
      data: { paymentStatus: PaymentStatus.PAID, paymentDate },
    })
    if (count > 0) return true
    return (await this.prisma.fixedCost.count({ where: { id } })) ? false : null
  }

  async paySubscription(id: string, paymentDate: Date): Promise<boolean | null> {
    const { count } = await this.prisma.subscription.updateMany({
      where: { id, paymentStatus: { in: UNPAID_STATUSES } },
      data: { paymentStatus: PaymentStatus.PAID, paymentDate },
    })
    if (count > 0) return true
    return (await this.prisma.subscription.count({ where: { id } })) ? false : null
  }

  // ✏️ Editar monto of a fixed cost or a subscription reminder (amountInPen follows the amount only in soles)
  async setFixedCostAmount(id: string, amount: number): Promise<boolean> {
    const row = await this.prisma.fixedCost.findUnique({ where: { id }, select: { currency: true } })
    if (!row) return false
    await this.prisma.fixedCost.update({
      where: { id },
      data: { amount, ...(row.currency === Currency.PEN ? { amountInPen: amount } : {}) },
    })
    return true
  }

  async setSubscriptionAmount(id: string, amount: number): Promise<boolean> {
    const row = await this.prisma.subscription.findUnique({ where: { id }, select: { currency: true } })
    if (!row) return false
    await this.prisma.subscription.update({
      where: { id },
      data: { amount, ...(row.currency === Currency.PEN ? { amountInPen: amount } : {}) },
    })
    return true
  }
}
