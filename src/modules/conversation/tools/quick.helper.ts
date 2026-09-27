import { createHash } from 'node:crypto'

import { ExpenseDestination } from '@/commons/constants/expense.constant'
import { ExpenseDraftDbDto } from '@/db/models/expense-draft/expenseDraftDB.dto'
import { normalizeText } from '@/modules/expense-extraction/expense-extraction.catalog'

export const QUICK_LIMIT = 6
export const QUICK_LOOKBACK_DAYS = 90
const MIN_REPEATS = 2

// The expenses that can be saved with one tap: day to day and card ones, in one payment, not shared
const QUICK_DESTINATIONS: string[] = [ExpenseDestination.DAILY, ExpenseDestination.CREDIT_CARD]

export interface QuickCandidate {
  key: string // callback data of its button: short and stable (a hash of what makes two expenses "the same")
  description: string
  amount: number
  currency: string
  count: number
  sample: ExpenseDraftDbDto // the latest one: its fields are copied
}

const keyOf = (draft: ExpenseDraftDbDto): string =>
  [
    normalizeText(draft.description ?? ''),
    draft.amount,
    draft.currency,
    draft.paymentMethodId,
    draft.categoryId,
    draft.destination,
  ].join('|')

// Your most repeated expenses (P18, /rapido): the same concept, amount, payment method and category saved at least
// twice. `drafts` come newest first, so the sample of each group is its latest one
export function quickCandidates(drafts: ExpenseDraftDbDto[], limit = QUICK_LIMIT): QuickCandidate[] {
  const groups = new Map<string, { count: number; sample: ExpenseDraftDbDto }>()
  for (const draft of drafts) {
    if (
      !draft.description ||
      draft.amount == null ||
      !draft.destination ||
      !QUICK_DESTINATIONS.includes(draft.destination)
    )
      continue
    if (draft.installment || draft.sharedWith) continue
    const key = keyOf(draft)
    const group = groups.get(key)
    if (group) group.count++
    else groups.set(key, { count: 1, sample: draft })
  }

  return [...groups]
    .filter(([, group]) => group.count >= MIN_REPEATS)
    .map(([raw, group]) => ({
      key: createHash('sha1').update(raw).digest('hex').slice(0, 10),
      description: group.sample.description!,
      amount: group.sample.amount!,
      currency: group.sample.currency ?? 'PEN',
      count: group.count,
      sample: group.sample,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
}
