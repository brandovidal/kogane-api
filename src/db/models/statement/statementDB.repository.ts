import { StatementBalanceData } from '@/modules/statements/statement.balance'
import { Injectable } from '@nestjs/common'
import { Statement, StatementBalance } from '@/generated/prisma/client'

import { PrismaService } from '@/db/prisma/prisma.service'
import { runAsImport } from '@/db/audit/audit-context'
import { AuditAction } from '@/commons/constants/audit.constant'
import { PaymentStatus } from '@/commons/constants/expense.constant'
import { StatementRowResult, StatementStatus } from '@/commons/constants/statement.constant'
import { StatementNotFoundException } from '@/commons/exceptions/statement/statement-not-found.exception'
import { PaymentPeriod } from '@/commons/helpers/payment-period.helper'

export interface CreateStatementDbDto {
  balances: StatementBalanceData[]
  paymentMethodId: string
  personId: string
  paymentMonth: number
  paymentYear: number
  periodEnd: Date | null
  dueDate: Date | null
  totalDue: number | null
  minimumDue: number | null
  previousBalance: number | null
  previousPayments: number | null
  monthlyPayment: number | null
  currency: string
  source: string
  fileId: string | null
  status: string
  rows: {
    date: Date | null
    description: string
    amount: number
    currency: string
    installment: string | null
    locked: boolean
    result: string
    expenseId: string | null
  }[]
}

const withRows = {
  balances: { orderBy: { currency: 'asc' as const } },
  rows: { orderBy: [{ date: 'asc' as const }, { createdAt: 'asc' as const }] },
}

// Bank statements (P14 block 2, D95) and the card expenses they are reconciled with
@Injectable()
export class StatementDBRepository {
  constructor(private readonly prisma: PrismaService) {}

  create({ rows, balances, ...data }: CreateStatementDbDto) {
    return this.prisma.$transaction(async (tx) => {
      const statement = await tx.statement.create({ data })
      await tx.statementBalance.createMany({
        data: balances.map((balance) => ({ ...balance, statementId: statement.id })),
      })
      await tx.statementRow.createMany({ data: rows.map((row) => ({ ...row, statementId: statement.id })) })
      return tx.statement.findUniqueOrThrow({ where: { id: statement.id }, include: withRows })
    })
  }

  async findById(id: string) {
    const statement = await this.prisma.statement.findUnique({ where: { id }, include: withRows })
    if (!statement) throw new StatementNotFoundException({ id })
    return statement
  }

  findMany() {
    return this.prisma.statement.findMany({
      orderBy: [{ paymentYear: 'desc' }, { paymentMonth: 'desc' }, { createdAt: 'desc' }],
      include: { balances: true, rows: { select: { result: true } } },
    })
  }

  // The last statement read of a card and month, with its rows (Cobros contrasts it with the debts, D114)
  findLatestForCard(paymentMethodId: string, { paymentMonth, paymentYear }: PaymentPeriod) {
    return this.prisma.statement.findFirst({
      where: { paymentMethodId, paymentMonth, paymentYear },
      orderBy: { createdAt: 'desc' },
      include: withRows,
    })
  }

  // The statements of those months (the calendar shows their real total and due date, P20)
  findForPeriods(periods: PaymentPeriod[]): Promise<(Statement & { balances: StatementBalance[] })[]> {
    if (!periods.length) return Promise.resolve([])
    return this.prisma.statement.findMany({
      where: { OR: periods.map(({ paymentMonth, paymentYear }) => ({ paymentMonth, paymentYear })) },
      include: { balances: true },
      orderBy: { createdAt: 'desc' },
    })
  }

  async delete(id: string): Promise<void> {
    await this.findById(id)
    await this.prisma.statement.delete({ where: { id } })
  }

  // The card expenses of that statement month, to reconcile
  findCardExpenses(paymentMethodId: string, { paymentMonth, paymentYear }: PaymentPeriod) {
    return this.prisma.creditCardExpense.findMany({
      where: { paymentMethodId, paymentMonth, paymentYear, paymentStatus: { not: PaymentStatus.SKIPPED } },
      select: {
        id: true,
        description: true,
        amount: true,
        currency: true,
        processDate: true,
        installment: true,
        personId: true,
        person: { select: { name: true } },
      },
    })
  }

  // "Crear nuevos": each new row becomes a pending card expense of the statement month, in one transaction
  // Each row becomes a card expense; another person's purchase also becomes their cobro (D116), in the same transaction
  async createExpenses(
    statementId: string,
    rows: { id: string; data: Record<string, unknown>; debt?: Record<string, unknown> }[],
  ): Promise<number> {
    // The history gets one event for the statement, not a row per purchase (P29, D103)
    await runAsImport(
      this.prisma,
      { entity: 'imp_statements', entityId: statementId, action: AuditAction.CREATE },
      async () => {
        await this.prisma.$transaction(async (tx) => {
          for (const row of rows) {
            const expense = await tx.creditCardExpense.create({ data: row.data as never, select: { id: true } })
            const debt = row.debt ? await tx.debt.create({ data: row.debt as never, select: { id: true } }) : null
            await tx.statementRow.update({
              where: { id: row.id },
              data: { result: StatementRowResult.CREATED, expenseId: expense.id, debtId: debt?.id ?? null },
            })
          }
          await this.refreshStatus(tx, statementId)
        })
        return { expenses: rows.length, debts: rows.filter((row) => row.debt).length }
      },
    )
    return rows.length
  }

  // Selección múltiple (D116): the person of several purchases not saved yet (matched and created ones follow their
  // expense). Returns how many changed
  async assignRows(statementId: string, rowIds: string[], personId: string | null): Promise<number> {
    const { count } = await this.prisma.statementRow.updateMany({
      where: {
        statementId,
        id: { in: rowIds },
        result: { in: [StatementRowResult.NEW, StatementRowResult.IGNORED] },
        locked: false,
      },
      data: { personId },
    })
    return count
  }

  // Whose statement it is (P14): reassigned by hand when the PDF did not say or said someone else
  async assignPerson(id: string, personId: string) {
    await this.prisma.statement.update({ where: { id }, data: { personId } })
    return this.findById(id)
  }

  // Corrects a wrongly identified card: the rows not tied to an expense yet (new, matched, ignored) are re-reconciled
  // against the new card's expenses; a row already turned into a card expense (created) keeps its own
  async changeCard(
    id: string,
    paymentMethodId: string,
    rows: { id: string; result: string; expenseId: string | null }[],
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.statement.update({ where: { id }, data: { paymentMethodId } })
      for (const row of rows) {
        await tx.statementRow.update({ where: { id: row.id }, data: { result: row.result, expenseId: row.expenseId } })
      }
      await this.refreshStatus(tx, id)
    })
    return this.findById(id)
  }

  async updateMinimumDue(id: string, minimumDue: number | null, currency?: string) {
    return this.updateBalance(id, { minimumDue }, currency)
  }

  async updateMinimumAllocations(id: string, allocations: Record<string, number> | null, currency?: string) {
    return this.updateBalance(
      id,
      { minimumAllocations: allocations === null ? null : JSON.stringify(allocations) },
      currency,
    )
  }

  private async updateBalance(
    id: string,
    data: { minimumDue?: number | null; minimumAllocations?: string | null },
    currency?: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const statement = await tx.statement.findUniqueOrThrow({ where: { id } })
      const selectedCurrency = currency ?? statement.currency
      await tx.statementBalance.upsert({
        where: { statementId_currency: { statementId: id, currency: selectedCurrency } },
        create: { statementId: id, currency: selectedCurrency, ...data },
        update: data,
      })
      if (selectedCurrency === statement.currency) {
        await tx.statement.update({ where: { id }, data })
      }
    })
    return this.findById(id)
  }

  // Ignore a row (a matched one lets its expense go back to "Solo en Kogane"), bring it back, or rename it
  async updateRow(
    statementId: string,
    rowId: string,
    { result, label, personId }: { result?: StatementRowResult; label?: string | null; personId?: string | null },
  ) {
    await this.prisma.$transaction(async (tx) => {
      if (personId !== undefined) {
        const row = await tx.statementRow.findFirst({
          where: { id: rowId, statementId },
          select: { expenseId: true, debtId: true, statement: { select: { personId: true } } },
        })
        const assignedPersonId = personId ?? row?.statement.personId
        if (row?.expenseId && assignedPersonId) {
          await tx.creditCardExpense.updateMany({ where: { id: row.expenseId }, data: { personId: assignedPersonId } })
        }
        if (row?.debtId && assignedPersonId) {
          await tx.debt.updateMany({ where: { id: row.debtId }, data: { personId: assignedPersonId } })
        }
      }
      const data = {
        ...(label !== undefined ? { label } : {}),
        ...(personId !== undefined ? { personId } : {}),
        ...(result ? { result, ...(result === StatementRowResult.IGNORED ? { expenseId: null } : {}) } : {}),
      }
      await tx.statementRow.updateMany({ where: { id: rowId, statementId }, data })
      await this.refreshStatus(tx, statementId)
    })
    return this.findById(statementId)
  }

  // Done when no row is left new
  private async refreshStatus(tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0], statementId: string) {
    const pending = await tx.statementRow.count({ where: { statementId, result: StatementRowResult.NEW } })
    await tx.statement.update({
      where: { id: statementId },
      data: { status: pending ? StatementStatus.REVIEW : StatementStatus.DONE },
    })
  }
}
