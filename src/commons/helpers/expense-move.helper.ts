import { PaymentStatus, SUBSCRIPTION_STATUSES, SubscriptionPeriod } from '@/commons/constants/expense.constant'

// The two tables "Pasar a…" moves between (D106): Costos fijos and exp_subscriptions (Plataformas and Recurrentes)
export type MovableTable = 'fixedCost' | 'subscription'

type Row = Record<string, unknown>

// Columns only one of the two tables has
const ONLY_IN: Record<MovableTable, string[]> = {
  fixedCost: ['attentionDate', 'commitmentId'], // a subscription is not an installment of a loan (P27)
  subscription: ['period', 'kind', 'supplyNumber'],
}

// Fixed costs have statuses subscriptions do not: a deposit is a payment, a partial payment is still pending
const SUBSCRIPTION_STATUS_OF: Record<string, PaymentStatus> = {
  [PaymentStatus.DEPOSITED]: PaymentStatus.PAID,
  [PaymentStatus.PARTIALLY_PAID]: PaymentStatus.PENDING,
}

export interface MoveTarget {
  kind?: string // subscription only
  period?: string // subscription only, monthly when it comes from a fixed cost
  categoryId?: string | null // fixed cost only, for rows without a category
}

// The same row written for the other table: ids, drafts, importKey, shares and dates stay (D106)
export function convertRow(row: Row, from: MovableTable, to: MovableTable, target: MoveTarget = {}): Row {
  const data: Row = { ...row }
  if (from !== to) for (const column of ONLY_IN[from]) delete data[column]

  if (to === 'subscription') {
    if (from === 'fixedCost') {
      if (data.dueDate == null && row.attentionDate != null) data.dueDate = row.attentionDate
      data.period = target.period ?? SubscriptionPeriod.MONTHLY
      const status = String(data.paymentStatus ?? PaymentStatus.NOT_STARTED)
      data.paymentStatus = (SUBSCRIPTION_STATUSES as readonly string[]).includes(status)
        ? status
        : (SUBSCRIPTION_STATUS_OF[status] ?? PaymentStatus.PENDING)
    }
    if (target.kind) data.kind = target.kind
  }
  if (to === 'fixedCost' && data.categoryId == null) {
    // Fixed costs require one: the move asks for it; an import update keeps the one the row already has
    if (target.categoryId) data.categoryId = target.categoryId
    else delete data.categoryId
  }
  return data
}

// Columns a copy never keeps: it is a new row, unpaid, with nothing linked (draft, Notion row, cobros)
const NOT_COPIED = ['id', 'userId', 'draftId', 'importKey', 'createdAt', 'updatedAt', 'commitmentId']

// "Copiar" of Transferir: the same row written for the other table (or the same one) as a new, unpaid row. Shares are
// not copied: a copy creates no cobros, so it starts as the user's own expense
export function copyRow(row: Row, from: MovableTable, to: MovableTable, target: MoveTarget = {}): Row {
  const data = convertRow(row, from, to, target)
  for (const column of NOT_COPIED) delete data[column]
  data.paymentStatus = PaymentStatus.NOT_STARTED
  data.paymentDate = null
  data.othersShare = 0
  return data
}

// The rows of a series from a payment month on ("Desde el mes"); every row without one
export function rowsFrom<T extends { paymentMonth: number; paymentYear: number }>(
  rows: T[],
  from: { month: number; year: number } | null | undefined,
): T[] {
  if (!from) return rows
  const start = from.year * 12 + from.month
  return rows.filter((row) => row.paymentYear * 12 + row.paymentMonth >= start)
}
