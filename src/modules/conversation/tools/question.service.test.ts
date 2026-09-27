import { vi } from 'vitest'

import { AiOperation } from '@/commons/constants/ai.constant'
import { CatalogKind } from '@/commons/constants/expense-extraction.constant'
import { ExpenseExtractionService } from '@/modules/expense-extraction/expense-extraction.service'

import { QuestionQuery, questionSchema } from './question.prompt'
import { QuestionService } from './question.service'
import { SpendingQueriesService } from './spending-queries.service'

// (the AI is a mock: no real call, D-rule of P9)
const mockExtraction = {
  generateStructured: vi.fn(),
  loadCatalog: vi.fn().mockResolvedValue({
    entries: [
      { id: 'cat-food', kind: CatalogKind.CATEGORY, name: 'Comida', aliases: [] },
      { id: 'pm-yape', kind: CatalogKind.PAYMENT_METHOD, name: 'Yape', aliases: [] },
    ],
  }),
}
const mockSpending = { monthRows: vi.fn() }
const query = (overrides: Partial<QuestionQuery> = {}): QuestionQuery => ({
  kind: 'total',
  month: null,
  year: null,
  groupBy: null,
  category: null,
  paymentMethod: null,
  text: null,
  ...overrides,
})
const row = (overrides = {}) => ({
  description: 'Almuerzo',
  amount: 20,
  currency: 'PEN',
  own: 20,
  date: '2026-08-05',
  method: 'Yape',
  category: 'Comida',
  ...overrides,
})

describe('QuestionService', () => {
  const service = new QuestionService(
    mockExtraction as unknown as ExpenseExtractionService,
    mockSpending as unknown as SpendingQueriesService,
  )

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-26T15:00:00.000Z'))
    mockSpending.monthRows.mockResolvedValue([
      row(),
      row({ category: 'Taxi', method: 'CMR', own: 80, description: 'Uber' }),
    ])
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('should send only the question and the date to the AI, once, as a question', async () => {
    mockExtraction.generateStructured.mockResolvedValue(query())

    await service.ask('cuánto gasté')

    expect(mockExtraction.generateStructured).toHaveBeenCalledTimes(1)
    const call = mockExtraction.generateStructured.mock.calls[0][0]
    expect(call.operation).toBe(AiOperation.QUESTION)
    expect(call.text).toBe('Today is 2026-09-26.\nQuestion: cuánto gasté')
  })

  it('should answer from the rows of the month and filter by the category and the method', async () => {
    mockExtraction.generateStructured.mockResolvedValue(query({ month: 8, category: 'comida', paymentMethod: 'yape' }))

    const { text } = await service.ask('cuánto gasté en comida con yape en agosto')

    expect(mockSpending.monthRows).toHaveBeenCalledWith(8, 2026)
    expect(text).toContain('<b>S/ 20.00</b> en 1 movimiento')
  })

  it('should take a month that has not come yet as the one of last year, and compare with the month before', async () => {
    mockExtraction.generateStructured.mockResolvedValue(query({ kind: 'compare', month: 1 }))

    await service.ask('cómo voy frente a diciembre')

    expect(mockSpending.monthRows).toHaveBeenNthCalledWith(1, 1, 2026)
    expect(mockSpending.monthRows).toHaveBeenNthCalledWith(2, 12, 2025)
  })

  it('should say so when the category is not in the catalog, without querying', async () => {
    mockExtraction.generateStructured.mockResolvedValue(query({ category: 'mascotas' }))

    expect((await service.ask('cuánto en mascotas')).text).toContain('No conozco la categoría «mascotas»')
    expect(mockSpending.monthRows).not.toHaveBeenCalled()
  })

  it('should not answer what is not about the expenses, and say when the AI did not answer', async () => {
    mockExtraction.generateStructured.mockResolvedValueOnce(query({ kind: 'unknown' }))
    expect((await service.ask('qué hora es')).text).toContain('Solo puedo responder sobre tus gastos')

    mockExtraction.generateStructured.mockResolvedValueOnce(null)
    expect((await service.ask('cuánto gasté')).text).toContain('No pude entender')
  })
})

describe('questionSchema', () => {
  it('should reject a query outside the predefined ones', () => {
    expect(questionSchema.safeParse({ kind: 'sql', month: null }).success).toBe(false)
    expect(
      questionSchema.safeParse({
        kind: 'top',
        month: 13,
        year: null,
        groupBy: null,
        category: null,
        paymentMethod: null,
        text: null,
      }).success,
    ).toBe(false)
  })
})
