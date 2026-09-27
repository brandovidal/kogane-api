import { Injectable } from '@nestjs/common'

import { Trip } from '@/generated/prisma/client'
import { PrismaService } from '@/db/prisma/prisma.service'
import { ownPen } from '@/commons/helpers/charge.helper'

export interface TripTotals {
  total: number // your part in soles
  count: number
  byCategory: { categoryId: string | null; total: number }[]
}

// Trips (P18, D128): one open at a time; the expenses saved meanwhile point to it
@Injectable()
export class TripDBRepository {
  constructor(private readonly prisma: PrismaService) {}

  findActive(): Promise<Trip | null> {
    return this.prisma.trip.findFirst({ where: { endedAt: null }, orderBy: { startedAt: 'desc' } })
  }

  // Opens a trip; the one that was open ends now
  async start(name: string): Promise<Trip> {
    const [, trip] = await this.prisma.$transaction([
      this.prisma.trip.updateMany({ where: { endedAt: null }, data: { endedAt: new Date() } }),
      this.prisma.trip.create({ data: { name } }),
    ])
    return trip
  }

  async end(): Promise<Trip | null> {
    const active = await this.findActive()
    if (!active) return null
    return this.prisma.trip.update({ where: { id: active.id }, data: { endedAt: new Date() } })
  }

  // What the trip cost: day-to-day and card expenses tagged with it, your part in soles (D73)
  async totals(tripId: string): Promise<TripTotals> {
    const select = { amount: true, amountInPen: true, othersShare: true, currency: true, categoryId: true } as const
    const [daily, cards] = await Promise.all([
      this.prisma.dailyExpense.findMany({ where: { tripId }, select }),
      this.prisma.creditCardExpense.findMany({ where: { tripId }, select }),
    ])
    const byCategory = new Map<string | null, number>()
    let total = 0
    for (const row of [...daily, ...cards]) {
      const own = ownPen(row)
      total += own
      byCategory.set(row.categoryId, (byCategory.get(row.categoryId) ?? 0) + own)
    }
    return {
      total: Math.round(total * 100) / 100,
      count: daily.length + cards.length,
      byCategory: [...byCategory].map(([categoryId, sum]) => ({ categoryId, total: Math.round(sum * 100) / 100 })),
    }
  }
}
