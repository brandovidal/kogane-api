import { ExpenseDraftDbDto } from '@/db/models/expense-draft/expenseDraftDB.dto'

import { quickCandidates } from './quick.helper'

const draft = (overrides: Partial<ExpenseDraftDbDto> = {}) =>
  ({
    id: 'd',
    description: 'Café',
    amount: 8,
    currency: 'PEN',
    paymentMethodId: 'yape',
    categoryId: 'comida',
    destination: 'daily',
    installment: null,
    sharedWith: null,
    ...overrides,
  }) as ExpenseDraftDbDto

describe('quickCandidates (/rapido)', () => {
  it('should group what was saved the same way at least twice and put the most repeated first', () => {
    const list = quickCandidates([
      draft({ id: 'a' }),
      draft({ id: 'b', description: 'Menú', amount: 15 }),
      draft({ id: 'c', description: 'CAFÉ' }),
      draft({ id: 'd2', description: 'Menú', amount: 15 }),
      draft({ id: 'e', description: 'Café' }),
    ])

    expect(list.map((item) => [item.description, item.count])).toEqual([
      ['Café', 3],
      ['Menú', 2],
    ])
    expect(list[0].sample.id).toBe('a') // the latest one: the list comes newest first
  })

  it('should not offer what was saved once, in installments, shared, or that is not day to day or a card', () => {
    const list = quickCandidates([
      draft({ description: 'Una vez' }),
      draft({ description: 'Cuotas', installment: '1/3' }),
      draft({ description: 'Cuotas', installment: '1/3' }),
      draft({ description: 'Compartido', sharedWith: { shares: [{ personId: 'p', ratio: 0.5 }] } }),
      draft({ description: 'Compartido', sharedWith: { shares: [{ personId: 'p', ratio: 0.5 }] } }),
      draft({ description: 'Alquiler', destination: 'fixed_cost' }),
      draft({ description: 'Alquiler', destination: 'fixed_cost' }),
    ])

    expect(list).toEqual([])
  })

  it('should treat another amount, card or category as another expense', () => {
    const list = quickCandidates([
      draft(),
      draft(),
      draft({ amount: 9 }),
      draft({ paymentMethodId: 'oh' }),
      draft({ categoryId: 'otro' }),
    ])

    expect(list).toHaveLength(1)
    expect(list[0].count).toBe(2)
  })

  it('should give each group a short stable key for its button, and at most 6 groups', () => {
    const many = Array.from({ length: 8 }, (_, index) => [
      draft({ description: `G${index}` }),
      draft({ description: `G${index}` }),
    ]).flat()

    const list = quickCandidates(many)
    const again = quickCandidates(many)

    expect(list).toHaveLength(6)
    expect(list[0].key).toMatch(/^[0-9a-f]{10}$/)
    expect(list.map((item) => item.key)).toEqual(again.map((item) => item.key))
    expect(`qk:${list[0].key}`.length).toBeLessThan(64)
  })
})
