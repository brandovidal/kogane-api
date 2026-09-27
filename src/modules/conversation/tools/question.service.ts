import { Injectable } from '@nestjs/common'

import { APP_TIME_ZONE } from '@/commons/constants/app.constant'
import { AiOperation } from '@/commons/constants/ai.constant'
import { CatalogKind } from '@/commons/constants/expense-extraction.constant'
import { DateHelper } from '@/commons/helpers/date.helper'
import { matchCatalogEntry, normalizeText } from '@/modules/expense-extraction/expense-extraction.catalog'
import { ExpenseExtractionService } from '@/modules/expense-extraction/expense-extraction.service'

import { BotReply } from '../dto/conversation.types'
import { QUESTION_INSTRUCTIONS, questionJsonSchema, questionSchema } from './question.prompt'
import { answerQuestion, describeFilters, QUESTION_TEXTS, QuestionPeriod } from './question.messages'
import { SpendingQueriesService } from './spending-queries.service'

// /pregunta <question> (P18, D131): one AI call that picks a predefined query, then the answer is computed here. The AI
// never sees an expense
@Injectable()
export class QuestionService {
  constructor(
    private readonly expenseExtractionService: ExpenseExtractionService,
    private readonly spendingQueriesService: SpendingQueriesService,
  ) {}

  async ask(question: string): Promise<BotReply> {
    const today = DateHelper.todayIn(APP_TIME_ZONE)
    const query = await this.expenseExtractionService.generateStructured({
      instructions: QUESTION_INSTRUCTIONS,
      text: `Today is ${today}.\nQuestion: ${question}`,
      jsonSchema: questionJsonSchema,
      parse: (json) => {
        const result = questionSchema.safeParse(json)
        return result.success ? { success: true, data: result.data } : { success: false, error: result.error.message }
      },
      operation: AiOperation.QUESTION,
    })
    if (!query) return { text: QUESTION_TEXTS.failed }
    if (query.kind === 'unknown') return { text: QUESTION_TEXTS.unknown }

    const catalog = await this.expenseExtractionService.loadCatalog()
    const category = query.category ? matchCatalogEntry(catalog, CatalogKind.CATEGORY, query.category) : null
    if (query.category && !category) return { text: QUESTION_TEXTS.unknownFilter('la categoría', query.category) }
    const method = query.paymentMethod
      ? matchCatalogEntry(catalog, CatalogKind.PAYMENT_METHOD, query.paymentMethod)
      : null
    if (query.paymentMethod && !method) return { text: QUESTION_TEXTS.unknownFilter('el medio', query.paymentMethod) }

    const [year, month] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))]
    // "diciembre" asked in march is last year's
    const period: QuestionPeriod = {
      month: query.month ?? month,
      year: query.year ?? (query.month && query.month > month ? year - 1 : year),
    }
    const previous: QuestionPeriod =
      period.month === 1 ? { month: 12, year: period.year - 1 } : { month: period.month - 1, year: period.year }

    const keep = (rows: Awaited<ReturnType<SpendingQueriesService['monthRows']>>) =>
      rows.filter(
        (row) =>
          (!category || row.category === category.name) &&
          (!method || row.method === method.name) &&
          (!query.text || normalizeText(row.description).includes(normalizeText(query.text))),
      )
    const rows = keep(await this.spendingQueriesService.monthRows(period.month, period.year))
    const previousRows =
      query.kind === 'compare' ? keep(await this.spendingQueriesService.monthRows(previous.month, previous.year)) : []

    return {
      text: answerQuestion(
        query,
        period,
        rows,
        previous,
        previousRows,
        describeFilters(query, category?.name ?? null, method?.name ?? null),
      ),
    }
  }
}
