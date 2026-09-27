import { Injectable } from '@nestjs/common'

import { APP_TIME_ZONE } from '@/commons/constants/app.constant'
import { DateHelper } from '@/commons/helpers/date.helper'

import { BotReply } from '../dto/conversation.types'
import { parseMonthArg } from '../month-arg.parser'
import { renderDonut } from './chart.helper'
import { CHART_TEXTS, chartCaption, toSlices } from './chart.messages'
import { monthLabel, monthUsage } from './spending.messages'
import { SpendingQueriesService } from './spending-queries.service'

// /grafico [mes] (P18, D130): the month by category as a donut image. No AI
@Injectable()
export class ChartService {
  constructor(private readonly spendingQueriesService: SpendingQueriesService) {}

  async reply(args: string): Promise<BotReply> {
    const period = parseMonthArg(args, DateHelper.todayIn(APP_TIME_ZONE))
    if (!period) return { text: monthUsage('📈', 'grafico') }

    const rows = await this.spendingQueriesService.monthRows(period.month, period.year)
    const totals = new Map<string, number>()
    for (const row of rows)
      totals.set(row.category ?? 'Sin categoría', (totals.get(row.category ?? 'Sin categoría') ?? 0) + row.own)
    const slices = toSlices([...totals].map(([name, total]) => ({ name, total: Math.round(total * 100) / 100 })))
    if (!slices.length) return { text: CHART_TEXTS.empty(monthLabel(period.month, period.year)) }

    return {
      text: chartCaption(period.month, period.year, slices),
      photo: {
        filename: `gastos-${period.year}-${String(period.month).padStart(2, '0')}.png`,
        mimeType: 'image/png',
        data: renderDonut(slices),
      },
    }
  }
}
