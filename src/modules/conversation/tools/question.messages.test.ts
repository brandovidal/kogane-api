import { answerQuestion, describeFilters } from './question.messages'
import { QuestionQuery } from './question.prompt'
import { SpendingRow } from './spending.messages'

const row = (overrides: Partial<SpendingRow> = {}): SpendingRow => ({
  description: 'Almuerzo',
  amount: 20,
  currency: 'PEN',
  own: 20,
  date: '2026-09-05',
  method: 'Yape',
  category: 'Comida',
  ...overrides,
})
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
const sept = { month: 9, year: 2026 }
const aug = { month: 8, year: 2026 }

describe('answerQuestion', () => {
  it('should add up the total, your part, and say how many movements', () => {
    const text = answerQuestion(query(), sept, [row(), row({ own: 10 })], aug, [], 'en Comida')

    expect(text).toContain('setiembre 2026</b> · en Comida')
    expect(text).toContain('<b>S/ 30.00</b> en 2 movimientos')
  })

  it('should say when there is nothing', () => {
    expect(answerQuestion(query(), sept, [], aug, [], '')).toContain('No encontré gastos')
  })

  it('should rank the groups and total them', () => {
    const rows = [row({ own: 10 }), row({ own: 50, category: 'Taxi' }), row({ own: 15, category: 'Taxi' })]

    const text = answerQuestion(query({ kind: 'top', groupBy: 'category' }), sept, rows, aug, [], '')

    expect(text).toContain('1. Taxi: S/ 65.00\n2. Comida: S/ 10.00')
    expect(text).toContain('Total: <b>S/ 75.00</b>')
  })

  it('should show the three biggest expenses', () => {
    const rows = [1, 2, 3, 4].map((own) => row({ own, description: `Gasto ${own}` }))

    const text = answerQuestion(query({ kind: 'biggest' }), sept, rows, aug, [], '')

    expect(text).toContain('Gasto 4')
    expect(text).toContain('Gasto 2')
    expect(text).not.toContain('Gasto 1')
  })

  it('should compare with the previous month', () => {
    const text = answerQuestion(query({ kind: 'compare' }), sept, [row({ own: 150 })], aug, [row({ own: 100 })], '')

    expect(text).toContain('setiembre 2026: <b>S/ 150.00</b>')
    expect(text).toContain('agosto 2026: <b>S/ 100.00</b>')
    expect(text).toContain('⬆️ S/ 50.00 (50 %)')
  })
})

describe('describeFilters', () => {
  it('should join the filters and escape the text', () => {
    expect(describeFilters({ text: 'a&b' }, 'Comida', 'Yape')).toBe('en Comida · con Yape · «a&amp;b»')
    expect(describeFilters({ text: null }, null, null)).toBe('')
  })
})
