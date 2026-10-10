import { z } from 'zod'

import { RecurringTargetType } from '@/commons/constants/expense.constant'
import { ExpenseResource } from '@/db/models/expense-record/expenseRecordDB.repository'

// Without month and year: the current month (America/Lima)
export const generateRecurringSchema = z
  .object({
    month: z.number().int().min(1).max(12),
    year: z.number().int().min(2020).max(2100),
  })
  .partial()
  .refine(({ month, year }) => (month == null) === (year == null), { message: 'month and year go together' })

// "Pasar desde Costos fijos… / Plataformas…": the row whose series becomes a monthly template
export const recurringFromSeriesSchema = z.object({
  resource: z.enum([ExpenseResource.FIXED_COST, ExpenseResource.SUBSCRIPTION]),
  id: z.string().min(1).describe('Any row of the series (same description and person); its latest row is copied'),
})

// ==================== Responses (Swagger / kogane-app types) ====================

export const recurringGenerationResponseSchema = z.object({
  month: z.number().int(),
  year: z.number().int(),
  created: z.array(
    z.object({
      recurringId: z.string(),
      id: z.string().describe('The new row of its table'),
      targetType: z.enum(RecurringTargetType),
      description: z.string(),
      amount: z.number(),
      currency: z.string(),
      date: z.iso.date(),
    }),
  ),
  skipped: z.array(
    z.object({
      recurringId: z.string(),
      description: z.string(),
      reason: z.enum(['already_generated', 'not_due', 'missing_card', 'missing_category']),
    }),
  ),
})
