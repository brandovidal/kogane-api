import { z } from 'zod'

import { PersonSummaryStatus } from '@/commons/constants/debt.constant'
import { dateTimeSchema } from '@/commons/helpers/api-response.helper'

const month = z.coerce.number().int().min(1).max(12)
const year = z.coerce.number().int().min(2000).max(2100)
const day = z.iso
  .date()
  .transform((value) => new Date(`${value}T00:00:00.000Z`))
  .nullable()

const adjustment = z.object({
  description: z.string().trim().min(1).max(120),
  amount: z
    .number()
    .refine((value) => value !== 0, 'An adjustment cannot be 0')
    .describe('Positive: they owe more'),
})

export const personSummaryQuerySchema = z.object({ month, year })

// Resumen ▸ Detalle of a person: any of these fields; the rest stays as it was
export const savePersonSummarySchema = z.object({
  month,
  year,
  status: z.enum(PersonSummaryStatus).optional(),
  cutoffDate: day.optional().describe('Fecha de corte (YYYY-MM-DD); null clears it'),
  collectBy: day.optional().describe('Fecha límite de cobro (YYYY-MM-DD); null clears it'),
  note: z.string().trim().max(500).nullable().optional(),
  adjustments: z.array(adjustment).max(50).optional().describe('Replaces the manual adjustments of that month'),
})

// Cambio en masa: the same status for several people of a month
export const bulkPersonSummaryStatusSchema = z.object({
  month,
  year,
  personIds: z.array(z.string().min(1)).min(1).max(200),
  status: z.enum(PersonSummaryStatus),
})

// ==================== Responses (Swagger / kogane-app types) ====================

export const personSummaryResponseSchema = z.object({
  id: z.string(),
  personId: z.string(),
  month: z.number().int(),
  year: z.number().int(),
  status: z.enum(PersonSummaryStatus),
  cutoffDate: dateTimeSchema.nullable(),
  collectBy: dateTimeSchema.nullable(),
  note: z.string().nullable(),
  adjustments: z.array(z.object({ description: z.string(), amount: z.number() })),
  adjustmentTotal: z.number().describe('Sum of the adjustments (positive: they owe more)'),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
})
