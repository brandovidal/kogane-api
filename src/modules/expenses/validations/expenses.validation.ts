import { yearMonthSchema } from '@/commons/helpers/period-range.helper'
import { z } from 'zod'

import {
  CREDIT_CARD_EXPENSE_STATUSES,
  Currency,
  ExpenseType,
  FIXED_COST_STATUSES,
  INSTALLMENT_REGEX,
  PaymentStatus,
  RecurringTargetType,
  SUBSCRIPTION_STATUSES,
  SubscriptionKind,
  SubscriptionPeriod,
} from '@/commons/constants/expense.constant'
import { dateTimeSchema } from '@/commons/helpers/api-response.helper'
import { ExpenseResource } from '@/db/models/expense-record/expenseRecordDB.repository'

// YYYY-MM-DD from the web forms, stored as a date at 00:00 UTC
const date = z.iso.date().transform((value) => new Date(`${value}T00:00:00.000Z`))
const id = z.string().min(1)
const month = z.number().int().min(1).max(12)
const year = z.number().int().min(2020).max(2100)

const money = {
  description: z.string().trim().min(1).max(120),
  amount: z.number().positive(),
  currency: z.enum(Currency).default(Currency.PEN),
  exchangeRate: z.number().positive().nullable().optional(),
  personId: id,
  notes: z.string().trim().max(500).nullable().optional(),
}

const expense = {
  ...money,
  expenseType: z.enum(ExpenseType).optional(),
  categoryId: id.nullable().optional(),
  installment: z.string().regex(INSTALLMENT_REGEX, 'Use n/m, e.g. 1/3').nullable().optional(),
}

const paymentPeriod = { paymentMonth: month, paymentYear: year }

// A template shared with people (Netflix a medias, D73): every month its row keeps othersShare and each one a cobro
const sharedWith = z
  .object({
    shares: z.array(
      z
        .object({
          personId: id,
          ratio: z.number().gt(0).max(1).optional(),
          amount: z.number().positive().optional(),
        })
        .refine((share) => (share.ratio == null) !== (share.amount == null), { message: 'Either ratio or amount' }),
    ),
  })
  .nullable()
  .optional()

// N.º de suministro of a service (Bitel, Enel): P25 marks it paid from the bank email
const supplyNumber = z.string().trim().max(40).nullable().optional()

// Each table allows its own subset of payment statuses (Notion boards)
const statusOf = (allowed: readonly PaymentStatus[]) =>
  z.enum(PaymentStatus).refine((status) => allowed.includes(status), { message: `One of: ${allowed.join(', ')}` })

export const EXPENSE_SCHEMAS = {
  [ExpenseResource.DAILY]: z.object({
    ...expense,
    spentAt: date,
    paymentMethodId: id,
    merchant: z.string().trim().max(120).nullable().optional(),
    operationNumber: z.string().trim().max(40).nullable().optional(),
  }),
  [ExpenseResource.FIXED_COST]: z.object({
    ...expense,
    ...paymentPeriod,
    categoryId: id,
    paymentMethodId: id.nullable().optional(),
    paymentStatus: statusOf(FIXED_COST_STATUSES).optional(),
    paymentDate: date.nullable().optional(),
    dueDate: date.nullable().optional(),
    attentionDate: date.nullable().optional(),
  }),
  [ExpenseResource.SUBSCRIPTION]: z.object({
    ...expense,
    ...paymentPeriod,
    period: z.enum(SubscriptionPeriod),
    kind: z.enum(SubscriptionKind).optional(),
    supplyNumber,
    paymentMethodId: id.nullable().optional(),
    paymentStatus: statusOf(SUBSCRIPTION_STATUSES).optional(),
    paymentDate: date.nullable().optional(),
    dueDate: date.nullable().optional(),
  }),
  [ExpenseResource.CREDIT_CARD]: z.object({
    ...expense,
    ...paymentPeriod,
    paymentMethodId: id,
    paymentStatus: statusOf(CREDIT_CARD_EXPENSE_STATUSES).optional(),
    processDate: date.nullable().optional(),
  }),
  [ExpenseResource.RECURRING]: z.object({
    ...money,
    targetType: z.enum(RecurringTargetType),
    kind: z.enum(SubscriptionKind).optional(),
    period: z.enum(SubscriptionPeriod).optional(),
    supplyNumber,
    sharedWith,
    expenseType: z.enum(ExpenseType).optional(),
    categoryId: id.nullable().optional(),
    paymentMethodId: id.nullable().optional(),
    dayOfMonth: z.number().int().min(1).max(31),
    isActive: z.boolean().optional(),
  }),
} satisfies Record<ExpenseResource, z.ZodObject>

export const expenseListQuerySchema = z.object({
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  from: yearMonthSchema.optional().describe('First month of a range (YYYY-MM, included); ignored with month and year'),
  to: yearMonthSchema.optional().describe('Last month of a range (YYYY-MM, included); ignored with month and year'),
  personId: z.string().min(1).optional(),
  paymentMethodId: z.string().min(1).optional(),
  kind: z
    .enum(['platform', 'recurring'])
    .optional()
    .describe('Subscriptions only: platform = Plataformas, recurring = Recurrentes (D107)'),
})

// ==================== Responses (Swagger / kogane-app types) ====================

const nullableDate = dateTimeSchema.nullable()
const recordFields = {
  id: z.string(),
  description: z.string(),
  amount: z.number(),
  currency: z.string(),
  expenseType: z.enum(ExpenseType),
  personId: z.string(),
  categoryId: z.string().nullable(),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
}
const expenseRecordFields = {
  ...recordFields,
  exchangeRate: z.number().nullable(),
  amountInPen: z.number().nullable(),
  notes: z.string().nullable(),
  draftId: z.string().nullable(),
  othersShare: z
    .number()
    .describe('What other people owe of this expense (shared, D73); your part is amount − othersShare'),
}
const paidInMonth = {
  paymentStatus: z.enum(PaymentStatus),
  installment: z.string().nullable(),
  paymentMonth: z.number().int(),
  paymentYear: z.number().int(),
}

export const EXPENSE_RESPONSE_SCHEMAS = {
  [ExpenseResource.DAILY]: z.object({
    ...expenseRecordFields,
    spentAt: dateTimeSchema,
    paymentMethodId: z.string(),
    merchant: z.string().nullable(),
    operationNumber: z.string().nullable(),
  }),
  [ExpenseResource.FIXED_COST]: z.object({
    ...expenseRecordFields,
    ...paidInMonth,
    categoryId: z.string(),
    paymentMethodId: z.string().nullable(),
    paymentDate: nullableDate,
    dueDate: nullableDate,
    attentionDate: nullableDate,
  }),
  [ExpenseResource.SUBSCRIPTION]: z.object({
    ...expenseRecordFields,
    ...paidInMonth,
    period: z.enum(SubscriptionPeriod),
    kind: z.enum(SubscriptionKind),
    supplyNumber: z.string().nullable(),
    paymentMethodId: z.string().nullable(),
    paymentDate: nullableDate,
    dueDate: nullableDate,
  }),
  [ExpenseResource.CREDIT_CARD]: z.object({
    ...expenseRecordFields,
    ...paidInMonth,
    paymentMethodId: z.string(),
    processDate: nullableDate,
    reviewedAt: nullableDate.describe('"Marcar como revisados": when it was checked against the statement'),
    originDraftId: z.string().nullable().describe('The draft that also created this installment (D73)'),
  }),
  [ExpenseResource.RECURRING]: z.object({
    ...recordFields,
    targetType: z.enum(RecurringTargetType),
    kind: z.enum(SubscriptionKind),
    period: z.enum(SubscriptionPeriod),
    supplyNumber: z.string().nullable(),
    sharedWith: z
      .object({
        shares: z.array(
          z.object({ personId: z.string(), ratio: z.number().optional(), amount: z.number().optional() }),
        ),
      })
      .nullable()
      .describe('Shared with people: each month their cobro is created with the row (D73, P30)'),
    paymentMethodId: z.string().nullable(),
    dayOfMonth: z.number().int(),
    isActive: z.boolean(),
    lastGeneratedAt: nullableDate,
  }),
} satisfies Record<ExpenseResource, z.ZodObject>

// /v1/expenses/{resource}: the shape depends on the resource of the path
export const expenseRecordResponseSchema = z.union(Object.values(EXPENSE_RESPONSE_SCHEMAS))
