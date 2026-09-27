import { Injectable } from '@nestjs/common'

import { BotCommand } from '@/commons/constants/conversation.constant'
import { TripDBRepository } from '@/db/models/trip/tripDB.repository'
import { Trip } from '@/generated/prisma/client'
import { ExpenseExtractionService } from '@/modules/expense-extraction/expense-extraction.service'
import { ExtractionCatalog } from '@/modules/expense-extraction/dto/expense-extraction.types'

import { commandButtons } from '../conversation.messages'
import { BotReply } from '../dto/conversation.types'
import { TRIP_TEXTS, TripSummary } from './trip.messages'

const NAME_MAX = 40

// /viaje <name> and /fin (P18, D128): a trip tags every day-to-day and card expense saved until it closes, and closing
// it gives the total by category
@Injectable()
export class TripsService {
  constructor(
    private readonly tripDBRepository: TripDBRepository,
    private readonly expenseExtractionService: ExpenseExtractionService,
  ) {}

  // /viaje Lima: opens it; alone: shows the open one, or null when there is none (the caller asks for the name)
  async open(name: string): Promise<BotReply | null> {
    const clean = name.trim().slice(0, NAME_MAX)
    if (!clean) {
      const active = await this.tripDBRepository.findActive()
      return active
        ? { text: TRIP_TEXTS.open(await this.summaryOf(active)), buttons: commandButtons(BotCommand.TRIP_END) }
        : null
    }
    const previous = await this.tripDBRepository.findActive()
    await this.tripDBRepository.start(clean)
    return { text: TRIP_TEXTS.started(clean, previous?.name ?? null), buttons: commandButtons(BotCommand.TRIP_END) }
  }

  // /fin: closes it and adds it up
  async close(): Promise<BotReply> {
    const ended = await this.tripDBRepository.end()
    return ended ? { text: TRIP_TEXTS.closed(await this.summaryOf(ended)) } : { text: TRIP_TEXTS.none }
  }

  private async summaryOf(trip: Trip): Promise<TripSummary> {
    const [totals, catalog] = await Promise.all([
      this.tripDBRepository.totals(trip.id),
      this.expenseExtractionService.loadCatalog(),
    ])
    return {
      name: trip.name,
      startedAt: trip.startedAt,
      endedAt: trip.endedAt,
      total: totals.total,
      count: totals.count,
      byCategory: totals.byCategory.map((row) => ({ name: nameOf(catalog, row.categoryId), total: row.total })),
    }
  }
}

const nameOf = (catalog: ExtractionCatalog, id: string | null) =>
  catalog.entries.find((entry) => entry.id === id)?.name ?? 'Sin categoría'
