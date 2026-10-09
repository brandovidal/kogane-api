import { Injectable } from '@nestjs/common'

import { parseYearMonth, paymentRangeWhere } from '@/commons/helpers/period-range.helper'
import { PrismaService } from '@/db/prisma/prisma.service'
import { PrismaErrorCode } from '@/commons/constants/database.constant'
import { DEBT_PAYMENT_PROPOSAL_MINUTES, OPEN_DEBT_STATUSES } from '@/commons/constants/debt.constant'
import { debtStatusFor, PaymentAllocation } from '@/commons/helpers/debt.helper'
import { isPrismaError } from '@/commons/helpers/prisma-error.helper'
import { DebtNotFoundException } from '@/commons/exceptions/debt/debt-not-found.exception'
import { Debt, DebtPayment } from '@/generated/prisma/client'

import { toCatalogError } from '../catalog-error.helper'

import {
  CreateDebtDbDto,
  CreateDebtPaymentDbDto,
  DebtFilterDbDto,
  DebtPaymentProposalDbDto,
  DebtWithPersonDbDto,
  UpdateDebtDbDto,
} from './debtDB.dto'

type Transaction = Parameters<Parameters<PrismaService['$transaction']>[0]>[0]

const WITH_PERSON = { person: { select: { id: true, name: true } } } as const

// That payment month, or every month up to it (Cobros / Deudas, D111)
function periodFilter(month?: number, year?: number, until?: boolean, from?: string, to?: string) {
  if (!month && !year && (from || to)) return paymentRangeWhere(parseYearMonth(from), parseYearMonth(to))
  if (!month || !year) return year ? { paymentYear: until ? { lte: year } : year } : {}
  if (!until) return { paymentMonth: month, paymentYear: year }
  return { OR: [{ paymentYear: { lt: year } }, { paymentYear: year, paymentMonth: { lte: month } }] }
}
// Oldest installment first: the order payments are applied in
const BY_PERIOD = [{ paymentYear: 'asc' }, { paymentMonth: 'asc' }, { createdAt: 'asc' }] as const

// exp_debts + exp_debt_payments (P17, D60). paidAmount and status are never written from outside: they follow the
// confirmed payments, recomputed in the same transaction as every payment change.
@Injectable()
export class DebtDBRepository {
  constructor(private readonly prisma: PrismaService) {}

  findMany({
    personId,
    direction,
    statuses,
    month,
    year,
    until,
    from,
    to,
    paymentMethodId,
  }: DebtFilterDbDto): Promise<DebtWithPersonDbDto[]> {
    return this.prisma.debt.findMany({
      where: {
        personId,
        direction,
        paymentMethodId,
        ...(statuses?.length ? { status: { in: statuses } } : {}),
        ...periodFilter(month, year, until, from, to),
      },
      include: WITH_PERSON,
      orderBy: [...BY_PERIOD],
    })
  }

  findCardPayments(paymentMethodId: string, from: Date, to: Date) {
    return this.prisma.debtPayment.findMany({
      where: {
        confirmedAt: { not: null },
        paidAt: { gte: from, lt: to },
        debt: { paymentMethodId },
      },
      select: {
        amount: true,
        debt: { select: { currency: true, personId: true, person: { select: { name: true } } } },
      },
    })
  }

  findByIds(ids: string[]): Promise<DebtWithPersonDbDto[]> {
    return this.prisma.debt.findMany({ where: { id: { in: ids } }, include: WITH_PERSON, orderBy: [...BY_PERIOD] })
  }

  // Pay the given amounts (the balance or a spread abono) as confirmed payments of one kind, in one transaction
  payMany(
    allocations: PaymentAllocation[],
    { paidAt, kind, paymentMethodId }: { paidAt: Date; kind: string; paymentMethodId: string | null },
  ): Promise<Debt[]> {
    return this.prisma.$transaction(async (tx) => {
      await tx.debtPayment.createMany({
        data: allocations.map(({ debtId, amount }) => ({
          debtId,
          amount,
          paidAt,
          kind,
          paymentMethodId,
          confirmedAt: new Date(),
        })),
      })
      return Promise.all(allocations.map(({ debtId }) => this.recompute(tx, debtId)))
    })
  }

  // Back to "No iniciado": the confirmed payments of these debts go away
  resetMany(ids: string[]): Promise<Debt[]> {
    return this.prisma.$transaction(async (tx) => {
      await tx.debtPayment.deleteMany({ where: { debtId: { in: ids }, confirmedAt: { not: null } } })
      return Promise.all(ids.map((debtId) => this.recompute(tx, debtId)))
    })
  }

  async setCard(ids: string[], paymentMethodId: string | null): Promise<number> {
    try {
      return (await this.prisma.debt.updateMany({ where: { id: { in: ids } }, data: { paymentMethodId } })).count
    } catch (error) {
      throw toCatalogError(error, 'debts')
    }
  }

  // "Arrastrar saldos pendientes": open installments of months before the target, oldest first
  findCarryable(target: { month: number; year: number }, filters: { direction?: string; personId?: string }) {
    return this.prisma.debt.findMany({
      where: {
        ...filters,
        status: { in: [...OPEN_DEBT_STATUSES] },
        OR: [{ paymentYear: { lt: target.year } }, { paymentYear: target.year, paymentMonth: { lt: target.month } }],
      },
      orderBy: [...BY_PERIOD],
    })
  }

  // Moves them to the target month in one transaction; the month they had is kept only the first time
  async carryOver(
    debts: { id: string; paymentMonth: number; paymentYear: number; carriedFromMonth: number | null }[],
    target: { month: number; year: number },
  ): Promise<number> {
    await this.prisma.$transaction(async (tx) => {
      for (const debt of debts) {
        await tx.debt.update({
          where: { id: debt.id },
          data: {
            paymentMonth: target.month,
            paymentYear: target.year,
            ...(debt.carriedFromMonth == null
              ? { carriedFromMonth: debt.paymentMonth, carriedFromYear: debt.paymentYear }
              : {}),
          },
        })
      }
    })
    return debts.length
  }

  async deleteMany(ids: string[]): Promise<number> {
    return (await this.prisma.debt.deleteMany({ where: { id: { in: ids } } })).count
  }

  // Confirmed payments per debt, to leave out of a delete without force
  async withPayments(ids: string[]): Promise<Set<string>> {
    const rows = await this.prisma.debtPayment.groupBy({
      by: ['debtId'],
      where: { debtId: { in: ids }, confirmedAt: { not: null } },
    })
    return new Set(rows.map((row) => row.debtId))
  }

  findOpen(filter: Omit<DebtFilterDbDto, 'statuses'> = {}): Promise<DebtWithPersonDbDto[]> {
    return this.findMany({ ...filter, statuses: OPEN_DEBT_STATUSES })
  }

  async findById(id: string): Promise<DebtWithPersonDbDto & { payments: DebtPayment[] }> {
    const debt = await this.prisma.debt.findUnique({
      where: { id },
      include: { ...WITH_PERSON, payments: { where: { confirmedAt: { not: null } }, orderBy: { paidAt: 'asc' } } },
    })
    if (!debt) throw new DebtNotFoundException({ id })
    return debt
  }

  // Every installment or none
  async createMany(rows: CreateDebtDbDto[]): Promise<Debt[]> {
    try {
      return await this.prisma.$transaction(rows.map((data) => this.prisma.debt.create({ data })))
    } catch (error) {
      throw toCatalogError(error, 'debts')
    }
  }

  async update(id: string, data: UpdateDebtDbDto): Promise<Debt> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.debt.update({ where: { id }, data })
        return this.recompute(tx, id)
      })
    } catch (error) {
      if (isPrismaError(error, PrismaErrorCode.RECORD_NOT_FOUND)) throw new DebtNotFoundException({ id })
      throw toCatalogError(error, 'debts', id)
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await this.prisma.debt.delete({ where: { id } })
    } catch (error) {
      if (isPrismaError(error, PrismaErrorCode.RECORD_NOT_FOUND)) throw new DebtNotFoundException({ id })
      throw error
    }
  }

  // A payment registered from the web: confirmed at once
  // The debt recomputed, plus the id of the new payment (its Comprobante is attached to it, refType debt_payment)
  addPayment(data: CreateDebtPaymentDbDto): Promise<Debt & { paymentId: string }> {
    return this.prisma.$transaction(async (tx) => {
      const payment = await tx.debtPayment.create({ data: { ...data, confirmedAt: new Date() } })
      return { ...(await this.recompute(tx, data.debtId)), paymentId: payment.id }
    })
  }

  findPayment(id: string) {
    return this.prisma.debtPayment.findUnique({ where: { id } })
  }

  async deletePayment(debtId: string, paymentId: string): Promise<Debt> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.debtPayment.deleteMany({ where: { id: paymentId, debtId } })
      if (!count) throw new DebtNotFoundException({ debtId, paymentId })
      return this.recompute(tx, debtId)
    })
  }

  // Bot: "dany me pagó 150" becomes unconfirmed payments grouped by batchId until ✅ Confirmar
  async replaceProposal(batchId: string, allocations: PaymentAllocation[], paidAt: Date, notes: string | null) {
    await this.prisma.$transaction([
      this.prisma.debtPayment.deleteMany({ where: { batchId, confirmedAt: null } }),
      this.prisma.debtPayment.createMany({
        data: allocations.map(({ debtId, amount }) => ({ debtId, amount, paidAt, batchId, notes })),
      }),
    ])
  }

  // Proposals expire like open drafts: an old button does nothing
  findProposal(batchId: string, now = new Date()): Promise<DebtPaymentProposalDbDto[]> {
    return this.prisma.debtPayment.findMany({
      where: {
        batchId,
        confirmedAt: null,
        createdAt: { gte: new Date(now.getTime() - DEBT_PAYMENT_PROPOSAL_MINUTES * 60_000) },
      },
      include: { debt: { include: WITH_PERSON } },
      orderBy: { createdAt: 'asc' },
    })
  }

  confirmProposal(batchId: string): Promise<Debt[]> {
    return this.prisma.$transaction(async (tx) => {
      const payments = await tx.debtPayment.findMany({ where: { batchId, confirmedAt: null } })
      await tx.debtPayment.updateMany({ where: { batchId, confirmedAt: null }, data: { confirmedAt: new Date() } })
      const debtIds = [...new Set(payments.map((payment) => payment.debtId))]
      return Promise.all(debtIds.map((debtId) => this.recompute(tx, debtId)))
    })
  }

  discardProposal(batchId: string) {
    return this.prisma.debtPayment.deleteMany({ where: { batchId, confirmedAt: null } })
  }

  // paidAmount = confirmed payments; status from debtStatusFor (D60)
  private async recompute(tx: Transaction, debtId: string): Promise<Debt> {
    const debt = await tx.debt.findUniqueOrThrow({ where: { id: debtId } })
    const confirmed = { debtId, confirmedAt: { not: null } }
    const [{ _sum }, last] = await Promise.all([
      tx.debtPayment.aggregate({ where: confirmed, _sum: { amount: true } }),
      tx.debtPayment.findFirst({
        where: confirmed,
        orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
        select: { paidAt: true, kind: true },
      }),
    ])
    const paidAmount = _sum.amount ?? 0
    const status = debtStatusFor({ ...debt, paidAmount }, last)

    return tx.debt.update({ where: { id: debtId }, data: { paidAmount, paidDate: last?.paidAt ?? null, status } })
  }
}
