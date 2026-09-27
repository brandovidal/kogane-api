import { CatalogKind, ExpenseField, LOW_CONFIDENCE_THRESHOLD } from '@/commons/constants/expense-extraction.constant'
import {
  ExtractionCatalog,
  ResolvedExpense,
  ResolvedExpenseFields,
} from '@/modules/expense-extraction/dto/expense-extraction.types'
import { findCatalogEntryById, normalizeText } from '@/modules/expense-extraction/expense-extraction.catalog'
import { completeExpense } from '@/modules/expense-extraction/expense-extraction.resolver'

const MIN_KEY_LENGTH = 3

export interface MerchantRuleData {
  merchant: string
  categoryId: string | null
  paymentMethodId: string | null
}

// What a rule is keyed by: the merchant, or the description when the expense has none ("almuerzo"). '' when there is
// nothing to key by
export function ruleKey({ merchant, description }: Pick<ResolvedExpenseFields, 'merchant' | 'description'>): string {
  const key = normalizeText(merchant ?? description ?? '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return key.length >= MIN_KEY_LENGTH ? key : ''
}

// The learned category always wins (it was the user's correction); the payment method only fills what is empty or
// unsure, since the message may say it ("almuerzo 30 plin"). A rule whose category or method no longer exists is ignored
export function applyRules(
  expenses: ResolvedExpense[],
  rules: MerchantRuleData[],
  catalog: ExtractionCatalog,
): ResolvedExpense[] {
  if (!rules.length) return expenses
  const byKey = new Map(rules.map((rule) => [rule.merchant, rule]))

  return expenses.map((expense) => {
    const rule = byKey.get(ruleKey(expense))
    if (!rule) return expense

    const confidence = { ...expense.confidence }
    let { categoryId, paymentMethodId } = expense
    if (rule.categoryId && findCatalogEntryById(catalog, rule.categoryId)?.kind === CatalogKind.CATEGORY) {
      categoryId = rule.categoryId
      confidence[ExpenseField.CATEGORY] = 1
    }
    const unsureMethod =
      paymentMethodId == null || (confidence[ExpenseField.PAYMENT_METHOD] ?? 1) < LOW_CONFIDENCE_THRESHOLD
    if (
      rule.paymentMethodId &&
      unsureMethod &&
      findCatalogEntryById(catalog, rule.paymentMethodId)?.kind === CatalogKind.PAYMENT_METHOD
    ) {
      paymentMethodId = rule.paymentMethodId
      confidence[ExpenseField.PAYMENT_METHOD] = 1
    }
    if (categoryId === expense.categoryId && paymentMethodId === expense.paymentMethodId) return expense
    return completeExpense({ ...expense, categoryId, paymentMethodId }, confidence, catalog)
  })
}
