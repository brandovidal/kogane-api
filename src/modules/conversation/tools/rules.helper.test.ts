import { CatalogKind, ExpenseField } from '@/commons/constants/expense-extraction.constant'
import { ExtractionCatalog, ResolvedExpense } from '@/modules/expense-extraction/dto/expense-extraction.types'

import { applyRules, ruleKey } from './rules.helper'

const catalog = {
  entries: [
    { id: 'cat-food', kind: CatalogKind.CATEGORY, name: 'Comida', aliases: [] },
    { id: 'cat-transport', kind: CatalogKind.CATEGORY, name: 'Transporte', aliases: [] },
    { id: 'pm-yape', kind: CatalogKind.PAYMENT_METHOD, name: 'Yape', aliases: [] },
    { id: 'pm-cmr', kind: CatalogKind.PAYMENT_METHOD, name: 'CMR', aliases: [] },
  ],
} as unknown as ExtractionCatalog

const expense = (overrides: Partial<ResolvedExpense> = {}): ResolvedExpense =>
  ({
    destination: 'daily',
    description: 'Almuerzo',
    amount: 20,
    currency: 'PEN',
    spentAt: '2026-09-20',
    expenseType: null,
    installment: null,
    period: null,
    personId: 'p1',
    paymentMethodId: null,
    categoryId: 'cat-transport',
    merchant: null,
    operationNumber: null,
    notes: null,
    confidence: { categoryId: 0.9 },
    missingFields: [],
    lowConfidenceFields: [],
    ...overrides,
  }) as ResolvedExpense

describe('ruleKey', () => {
  it('should key by the merchant, or by the description without one, without accents or symbols', () => {
    expect(ruleKey({ merchant: ' Café  Tostado!! ', description: 'Desayuno' })).toBe('cafe tostado')
    expect(ruleKey({ merchant: null, description: 'Almuerzo' })).toBe('almuerzo')
  })

  it('should not key by something too short', () => {
    expect(ruleKey({ merchant: null, description: 'ab' })).toBe('')
    expect(ruleKey({ merchant: null, description: null })).toBe('')
  })
})

describe('applyRules', () => {
  const rules = [{ merchant: 'almuerzo', categoryId: 'cat-food', paymentMethodId: 'pm-yape' }]

  it('should put the learned category (it wins over the AI) and fill the empty payment method', () => {
    const [result] = applyRules([expense()], rules, catalog)

    expect(result.categoryId).toBe('cat-food')
    expect(result.paymentMethodId).toBe('pm-yape')
    expect(result.confidence).toEqual(expect.objectContaining({ categoryId: 1, paymentMethodId: 1 }))
  })

  it('should keep the payment method the message said, but replace one the AI was unsure about', () => {
    const [said] = applyRules(
      [expense({ paymentMethodId: 'pm-cmr', confidence: { paymentMethodId: 0.95 } })],
      rules,
      catalog,
    )
    const [unsure] = applyRules(
      [expense({ paymentMethodId: 'pm-cmr', confidence: { paymentMethodId: 0.3 } })],
      rules,
      catalog,
    )

    expect(said.paymentMethodId).toBe('pm-cmr')
    expect(unsure.paymentMethodId).toBe('pm-yape')
  })

  it('should leave alone an expense with no rule, and ignore a rule whose category no longer exists', () => {
    const other = expense({ description: 'Taxi' })
    const [untouched] = applyRules([other], rules, catalog)
    const [stale] = applyRules(
      [expense()],
      [{ merchant: 'almuerzo', categoryId: 'deleted', paymentMethodId: null }],
      catalog,
    )

    expect(untouched).toBe(other)
    expect(stale.categoryId).toBe('cat-transport')
  })

  it('should not need a payment method to be complete once the rule gave it', () => {
    const [result] = applyRules([expense({ missingFields: [ExpenseField.PAYMENT_METHOD] })], rules, catalog)

    expect(result.missingFields).not.toContain(ExpenseField.PAYMENT_METHOD)
  })
})
