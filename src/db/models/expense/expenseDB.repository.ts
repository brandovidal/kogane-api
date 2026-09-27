import { Injectable } from '@nestjs/common'

import { PrismaService } from '@/db/prisma/prisma.service'
import { PaymentMethodType } from '@/commons/constants/catalog.constant'
import { DebtDirection, OPEN_DEBT_STATUSES } from '@/commons/constants/debt.constant'
import { Currency, ExpenseDestination } from '@/commons/constants/expense.constant'
import { ExpenseDraftStatus } from '@/commons/constants/expense-draft.constant'
import { SavedExpenseLockedException } from '@/commons/exceptions/expense/saved-expense-locked.exception'

import { CategorySpentDbDto, ChargeDbDto, MonthlyTotalDbDto, SaveExpenseDbDto } from './expenseDB.dto'

type Transaction = Parameters<Parameters<PrismaService['$transaction']>[0]>[0]

const CHARGE_FIELDS = {
  id: true,
  description: true,
  amount: true,
  othersShare: true,
  currency: true,
  amountInPen: true,
  paymentMethodId: true,
  categoryId: true,
  personId: true,
  createdAt: true,
} as const

const CHARGE_SELECT = {
  daily: { ...CHARGE_FIELDS, spentAt: true },
  card: { ...CHARGE_FIELDS, processDate: true },
} as const

type ChargeFields = Omit<ChargeDbDto, 'source' | 'date'>

function toCharges(
  daily: (ChargeFields & { spentAt: Date })[],
  cards: (ChargeFields & { processDate: Date | null })[],
) {
  return [
    ...daily.map(({ spentAt, ...row }): ChargeDbDto => ({ ...row, source: 'daily', date: spentAt })),
    ...cards.map(({ processDate, ...row }): ChargeDbDto => ({
      ...row,
      source: 'card',
      date: processDate ?? row.createdAt,
    })),
  ]
}

@Injectable()
export class ExpenseDBRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Creates the expense and marks its ExpenseDraft as saved in one transaction. With replacesDraftId (/editar, D76) the
  // rows of that saved draft (its record, installments and shared debts) are deleted first and it stops being saved.
  async saveFromExpenseDraft(
    draftId: string,
    input: SaveExpenseDbDto,
    replacesDraftId?: string,
  ): Promise<{ id: string }> {
    return this.prisma.$transaction(async (tx) => {
      if (replacesDraftId) await this.deleteRowsOf(tx, replacesDraftId)
      const record = await this.createRecord(tx, draftId, input)
      if (input.sharedDebts?.length) await tx.debt.createMany({ data: input.sharedDebts })

      await tx.expenseDraft.update({
        where: { id: draftId },
        data: { status: ExpenseDraftStatus.SAVED, pendingField: null, confirmedAt: new Date() },
      })

      return { id: record.id }
    })
  }

  // PEN spent per category in a month (P19), your part of shared expenses only (D73): day to day by date, fixed costs and cards by payment month. Subscriptions
  // are left out: their charge is already a card expense (D46). categoryId null: expenses without category.
  // With personId, only that person's expenses (the budget counts only yours, D71)
  // Subscriptions add only the kinds switched on in bud_settings and never when paid with a credit card: the card
  // charge already counts (D46, D96, D107)
  async findSpentByCategory(
    month: number,
    year: number,
    personId?: string,
    subscriptionKinds: string[] = [],
  ): Promise<CategorySpentDbDto[]> {
    const person = personId ? { personId } : {}
    const period = { paymentMonth: month, paymentYear: year, currency: Currency.PEN, ...person }
    const aggregate = { by: ['categoryId'] as ['categoryId'], _sum: { amount: true, othersShare: true } } as const
    const subscriptions = subscriptionKinds.length
      ? this.prisma.subscription.groupBy({
          ...aggregate,
          where: {
            ...period,
            kind: { in: subscriptionKinds },
            OR: [{ paymentMethodId: null }, { paymentMethod: { type: { not: PaymentMethodType.CREDIT_CARD } } }],
          },
        })
      : Promise.resolve([])
    const [daily, fixedCosts, creditCards, counted] = await Promise.all([
      this.prisma.dailyExpense.groupBy({
        ...aggregate,
        where: {
          currency: Currency.PEN,
          ...person,
          spentAt: { gte: new Date(Date.UTC(year, month - 1, 1)), lt: new Date(Date.UTC(year, month, 1)) },
        },
      }),
      this.prisma.fixedCost.groupBy({ ...aggregate, where: period }),
      this.prisma.creditCardExpense.groupBy({ ...aggregate, where: period }),
      subscriptions,
    ])

    const totals = new Map<string | null, number>()
    for (const row of [...daily, ...fixedCosts, ...creditCards, ...counted]) {
      // Your part (D73): what others owe of a shared expense is not your spending
      const own = (row._sum.amount ?? 0) - (row._sum.othersShare ?? 0)
      totals.set(row.categoryId, (totals.get(row.categoryId) ?? 0) + own)
    }
    return [...totals].map(([categoryId, total]) => ({ categoryId, total }))
  }

  // Totals of the month per destination, currency and person (debts: the balance of everything not paid yet)
  async findMonthlyTotals(month: number, year: number): Promise<MonthlyTotalDbDto[]> {
    const where = { paymentMonth: month, paymentYear: year }
    const monthStart = new Date(Date.UTC(year, month - 1, 1))
    const nextMonthStart = new Date(Date.UTC(year, month, 1))
    const by: ['currency', 'personId'] = ['currency', 'personId']
    const aggregate = { _sum: { amount: true }, _count: { _all: true } } as const

    const [daily, fixedCosts, subscriptions, creditCards, debts] = await Promise.all([
      this.prisma.dailyExpense.groupBy({
        by,
        where: { spentAt: { gte: monthStart, lt: nextMonthStart } },
        ...aggregate,
      }),
      this.prisma.fixedCost.groupBy({ by, where, ...aggregate }),
      this.prisma.subscription.groupBy({ by, where, ...aggregate }),
      this.prisma.creditCardExpense.groupBy({ by, where, ...aggregate }),
      this.prisma.debt.groupBy({
        by: ['currency', 'personId', 'direction'],
        where: { status: { in: OPEN_DEBT_STATUSES } },
        _sum: { amount: true, paidAmount: true },
        _count: { _all: true },
      }),
    ])

    type Row = {
      currency: string | null
      personId: string | null
      _sum: { amount: number | null }
      _count: { _all: number }
    }
    const toTotals = (destination: ExpenseDestination, rows: Row[]) =>
      rows.map((row) => ({
        destination,
        currency: row.currency ?? 'PEN',
        personId: row.personId ?? '',
        total: row._sum.amount ?? 0,
        count: row._count._all,
      }))

    return [
      ...toTotals(ExpenseDestination.DAILY, daily),
      ...toTotals(ExpenseDestination.FIXED_COST, fixedCosts),
      ...toTotals(ExpenseDestination.SUBSCRIPTION, subscriptions),
      ...toTotals(ExpenseDestination.CREDIT_CARD, creditCards),
      ...debts.map((row) => ({
        destination: row.direction === DebtDirection.I_OWE ? ExpenseDestination.PAYABLE : ExpenseDestination.RECEIVABLE,
        currency: row.currency,
        personId: row.personId,
        total: (row._sum.amount ?? 0) - (row._sum.paidAmount ?? 0),
        count: row._count._all,
      })),
    ]
  }

  // Day-to-day and card expenses of the days [from, to) (P20: daily close and weekly summary)
  async findChargesBetween(from: Date, to: Date): Promise<ChargeDbDto[]> {
    const range = { gte: from, lt: to }
    const [daily, cards] = await Promise.all([
      this.prisma.dailyExpense.findMany({ where: { spentAt: range }, select: CHARGE_SELECT.daily }),
      this.prisma.creditCardExpense.findMany({
        where: { OR: [{ processDate: range }, { processDate: null, createdAt: range }] },
        select: CHARGE_SELECT.card,
      }),
    ])
    return toCharges(daily, cards)
  }

  // Day-to-day and card expenses registered since that instant (P20: duplicated charges, price changes)
  async findChargesCreatedSince(since: Date): Promise<ChargeDbDto[]> {
    const where = { createdAt: { gte: since } }
    const [daily, cards] = await Promise.all([
      this.prisma.dailyExpense.findMany({ where, select: CHARGE_SELECT.daily }),
      this.prisma.creditCardExpense.findMany({ where, select: CHARGE_SELECT.card }),
    ])
    return toCharges(daily, cards)
  }

  // /deshacer (P18): the rows of a saved expense (record, installments and shared debts) are deleted and it stops being
  // saved. SavedExpenseLockedException when one of its debts already has payments
  async deleteSavedExpense(draftId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.deleteRowsOf(tx, draftId)
      await tx.expenseDraft.update({
        where: { id: draftId },
        data: { status: ExpenseDraftStatus.DISCARDED, pendingField: null },
      })
    })
  }

  // What each credit card charges in a billing period (its statement): the total, and the part in installments (P18,
  // /tarjetas). The amount charged by the bank, not your part: it is what has to be paid
  async findCardCycleTotals(period: { paymentMonth: number; paymentYear: number }) {
    const rows = await this.prisma.creditCardExpense.findMany({
      where: period,
      select: { paymentMethodId: true, amount: true, amountInPen: true, installment: true },
    })
    const totals = new Map<string, { total: number; installments: number; count: number }>()
    for (const row of rows) {
      const current = totals.get(row.paymentMethodId) ?? { total: 0, installments: 0, count: 0 }
      const pen = row.amountInPen ?? row.amount
      current.total += pen
      if (row.installment) current.installments += pen
      current.count++
      totals.set(row.paymentMethodId, current)
    }
    return [...totals].map(([paymentMethodId, value]) => ({
      paymentMethodId,
      total: Math.round(value.total * 100) / 100,
      installments: Math.round(value.installments * 100) / 100,
      count: value.count,
    }))
  }

  // P21 reconciliation: card expenses bought (processDate) in a month, in soles
  async sumCardExpensesProcessedBetween(paymentMethodId: string, from: Date, to: Date): Promise<number> {
    const rows = await this.prisma.creditCardExpense.findMany({
      where: { paymentMethodId, processDate: { gte: from, lt: to } },
      select: { amount: true, amountInPen: true },
    })
    return Math.round(rows.reduce((sum, row) => sum + (row.amountInPen ?? row.amount), 0) * 100) / 100
  }

  private async deleteRowsOf(tx: Transaction, draftId: string) {
    const linked = { OR: [{ draftId }, { originDraftId: draftId }] }
    const paid = await tx.debtPayment.count({ where: { debt: linked } })
    if (paid) throw new SavedExpenseLockedException({ draftId })

    await tx.debt.deleteMany({ where: linked })
    await tx.creditCardExpense.deleteMany({ where: linked })
    await tx.dailyExpense.deleteMany({ where: { draftId } })
    await tx.fixedCost.deleteMany({ where: { draftId } })
    await tx.subscription.deleteMany({ where: { draftId } })
    await tx.expenseDraft.update({
      where: { id: draftId },
      data: { status: ExpenseDraftStatus.DISCARDED, pendingField: null },
    })
  }

  private async createRecord(tx: Transaction, draftId: string, input: SaveExpenseDbDto) {
    const { destination, data } = input
    switch (destination) {
      case ExpenseDestination.DAILY:
        return tx.dailyExpense.create({ data: { ...data, draftId } })
      case ExpenseDestination.FIXED_COST:
        return tx.fixedCost.create({ data: { ...data, draftId } })
      case ExpenseDestination.SUBSCRIPTION:
        return tx.subscription.create({ data: { ...data, draftId } })
      case ExpenseDestination.CREDIT_CARD: {
        const expense = await tx.creditCardExpense.create({ data: { ...data, draftId } })
        if (input.nextInstallments.length) await tx.creditCardExpense.createMany({ data: input.nextInstallments })
        return expense
      }
      case ExpenseDestination.RECEIVABLE:
      case ExpenseDestination.PAYABLE: {
        const debt = await tx.debt.create({ data: { ...data, draftId } })
        if ('nextInstallments' in input && input.nextInstallments.length) {
          await tx.debt.createMany({ data: input.nextInstallments })
        }
        return debt
      }
    }
  }
}
