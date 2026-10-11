import { Injectable } from '@nestjs/common'

import { PrismaService } from '@/db/prisma/prisma.service'
import { PaymentPeriod } from '@/commons/helpers/payment-period.helper'

export interface PaymentWriteDbDto {
  refType: string // NotificationRefType
  refId: string
  title: string
  amount: number
  currency: string
  kind: string // PaymentKind
  paidAt: Date
  method?: string | null // PayMethod
  accountId?: string | null
  note?: string | null
}

// The trace of what was paid from the calendar: amount, day, how and from which account (exp_payments)
@Injectable()
export class PaymentDBRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: PaymentWriteDbDto) {
    return this.prisma.payment.create({ data })
  }

  // What was already paid in parts of those references: refId → sum
  async sumsByRefs(refType: string, refIds: string[]): Promise<Map<string, number>> {
    const sums = new Map<string, number>()
    if (!refIds.length) return sums
    const rows = await this.prisma.payment.findMany({
      where: { refType, refId: { in: refIds } },
      select: { refId: true, amount: true },
    })
    for (const row of rows) sums.set(row.refId, (sums.get(row.refId) ?? 0) + row.amount)
    return sums
  }

  // Payments of card statements of those payment months (refId "<card>@<yyyy>-<mm>[:<currency>]"): refId → sum
  async sumsByStatementPeriods(refType: string, periods: PaymentPeriod[]): Promise<Map<string, number>> {
    const sums = new Map<string, number>()
    if (!periods.length) return sums
    const rows = await this.prisma.payment.findMany({
      where: {
        refType,
        OR: periods.map(({ paymentMonth, paymentYear }) => ({
          refId: { contains: `@${paymentYear}-${String(paymentMonth).padStart(2, '0')}` },
        })),
      },
      select: { refId: true, amount: true },
    })
    for (const row of rows) sums.set(row.refId, (sums.get(row.refId) ?? 0) + row.amount)
    return sums
  }
}
