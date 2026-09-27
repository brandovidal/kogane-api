import { Injectable } from '@nestjs/common'

import { APP_TIME_ZONE } from '@/commons/constants/app.constant'
import { PaymentMethodType } from '@/commons/constants/catalog.constant'
import { dayStart, ownPen } from '@/commons/helpers/charge.helper'
import { DateHelper } from '@/commons/helpers/date.helper'
import { ExpenseDBRepository } from '@/db/models/expense/expenseDB.repository'
import { ChargeDbDto } from '@/db/models/expense/expenseDB.dto'
import { PaymentMethodDBRepository } from '@/db/models/payment-method/paymentMethodDB.repository'
import { PersonDBRepository } from '@/db/models/person/personDB.repository'
import { statementDates } from '@/modules/calendar/calendar.helper'
import { ExpenseExtractionService } from '@/modules/expense-extraction/expense-extraction.service'
import { ExtractionCatalog } from '@/modules/expense-extraction/dto/expense-extraction.types'

import { BotReply } from '../dto/conversation.types'
import { formatCards, formatToday, formatWeek, SpendingRow } from './spending.messages'

const WEEK_DAYS = 7

// /hoy, /semana and /tarjetas (P18, D128): what was spent and what the cards will charge. Read-only, no AI
@Injectable()
export class SpendingQueriesService {
  constructor(
    private readonly expenseDBRepository: ExpenseDBRepository,
    private readonly paymentMethodDBRepository: PaymentMethodDBRepository,
    private readonly personDBRepository: PersonDBRepository,
    private readonly expenseExtractionService: ExpenseExtractionService,
  ) {}

  async today(): Promise<BotReply> {
    const today = DateHelper.todayIn(APP_TIME_ZONE)
    const rows = await this.rows(today, DateHelper.addDays(today, 1))
    return { text: formatToday(rows, today) }
  }

  // The last 7 days including today
  async week(): Promise<BotReply> {
    const today = DateHelper.todayIn(APP_TIME_ZONE)
    const from = DateHelper.addDays(today, -(WEEK_DAYS - 1))
    const rows = await this.rows(from, DateHelper.addDays(today, 1))
    return { text: formatWeek(rows, from, today) }
  }

  // Your expenses of a whole month (/exportar)
  monthRows(month: number, year: number): Promise<SpendingRow[]> {
    const first = `${year}-${String(month).padStart(2, '0')}-01`
    const next = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`
    return this.rows(first, next)
  }

  // The cycle each credit card is in: today up to its closing day is this month's statement, after it the next one
  async cards(): Promise<BotReply> {
    const today = DateHelper.todayIn(APP_TIME_ZONE)
    const [year, month, day] = today.split('-').map(Number)
    const cards = (await this.paymentMethodDBRepository.findActive()).filter(
      (card) => card.type === PaymentMethodType.CREDIT_CARD && card.billingCloseDay && card.paymentDueDay,
    )

    const rows = await Promise.all(
      cards.map(async (card) => {
        const next = day > card.billingCloseDay!
        const period = {
          paymentMonth: next ? (month % 12) + 1 : month,
          paymentYear: next && month === 12 ? year + 1 : year,
        }
        const totals = (await this.expenseDBRepository.findCardCycleTotals(period)).find(
          (row) => row.paymentMethodId === card.id,
        )
        const dates = statementDates(card.billingCloseDay!, card.paymentDueDay!, period)
        return { name: card.name, total: totals?.total ?? 0, installments: totals?.installments ?? 0, ...dates }
      }),
    )
    return { text: formatCards(rows) }
  }

  // Your day-to-day and card expenses of the days [from, to): the default person's, in soles (the budget's rule, D71)
  private async rows(from: string, to: string): Promise<SpendingRow[]> {
    const [charges, owner, catalog] = await Promise.all([
      this.expenseDBRepository.findChargesBetween(dayStart(from), dayStart(to)),
      this.personDBRepository.findDefault(),
      this.expenseExtractionService.loadCatalog(),
    ])
    return charges
      .filter((charge) => !owner || charge.personId === owner.id)
      .map((charge) => toRow(charge, catalog))
      .sort((a, b) => a.date.localeCompare(b.date))
  }
}

const nameOf = (catalog: ExtractionCatalog, id: string | null) =>
  catalog.entries.find((entry) => entry.id === id)?.name ?? null

const toRow = (charge: ChargeDbDto, catalog: ExtractionCatalog): SpendingRow => ({
  description: charge.description,
  amount: charge.amount,
  currency: charge.currency,
  own: ownPen(charge),
  date: charge.date.toISOString().slice(0, 10),
  method: nameOf(catalog, charge.paymentMethodId),
  category: nameOf(catalog, charge.categoryId),
})
