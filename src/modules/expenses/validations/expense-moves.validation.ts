import { z } from 'zod'

import { SubscriptionKind, SubscriptionPeriod } from '@/commons/constants/expense.constant'
import { ExpenseResource } from '@/db/models/expense-record/expenseRecordDB.repository'

const movable = z.enum([ExpenseResource.FIXED_COST, ExpenseResource.SUBSCRIPTION])
const period = z.object({ month: z.number().int(), year: z.number().int() })

// "Pasar a…" (D106): the whole series of a row (same table, description and person) and its template
export const moveSeriesSchema = z
  .object({
    resource: movable.describe('Table of the row the user picked'),
    id: z.string().min(1),
    to: movable,
    kind: z.enum(SubscriptionKind).optional().describe('Required when moving to subscriptions'),
    period: z
      .enum(SubscriptionPeriod)
      .optional()
      .describe('Subscriptions only; monthly when it comes from a fixed cost'),
    categoryId: z.string().min(1).optional().describe('For rows without a category when moving to fixed costs'),
    dryRun: z.boolean().optional().describe('Only count what would move (the confirmation of the dialog)'),
    mode: z
      .enum(['move', 'copy'])
      .optional()
      .describe('move by default; copy: new unpaid rows in the target (the series and its templates stay as they are)'),
    from: period
      .optional()
      .describe('Only the rows from this payment month on ("Desde el mes"); the whole series without it'),
  })
  .superRefine((body, context) => {
    if (body.to === ExpenseResource.SUBSCRIPTION && !body.kind) {
      context.addIssue({ code: 'custom', path: ['kind'], message: 'Required when moving to subscriptions' })
    }
    if (
      body.mode !== 'copy' &&
      body.to === ExpenseResource.FIXED_COST &&
      body.resource === ExpenseResource.FIXED_COST
    ) {
      context.addIssue({ code: 'custom', path: ['to'], message: 'The row is already a fixed cost' })
    }
  })

export const moveSeriesResponseSchema = z.object({
  dryRun: z.boolean(),
  mode: z.enum(['move', 'copy']),
  count: z.number().int().describe('Rows of the series'),
  from: period.nullable().describe('First payment month of the series'),
  until: period.nullable().describe('Last payment month of the series'),
  templates: z.number().int().describe('Recurring templates moved with it'),
  withoutCategory: z.number().int().describe('Rows that need categoryId to become fixed costs'),
  blocked: z
    .array(z.object({ id: z.string(), month: z.number().int(), year: z.number().int() }))
    .describe('Rows with an /editar copy open: finish or cancel it first'),
})

// "Marcar como revisados" of Tarjetas: card charges checked against the statement (or back to unchecked)
export const cardReviewSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
  reviewed: z.boolean().default(true),
})

export const cardReviewResponseSchema = z.object({
  affected: z.number().int().describe('Card charges marked (or unmarked)'),
  reviewedAt: z.string().nullable().describe('ISO date set on them; null when unmarked'),
})
