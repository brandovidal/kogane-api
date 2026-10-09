import { z } from 'zod'

import { CardHolderRole, PaymentMethodType } from '@/commons/constants/catalog.constant'
import { dateTimeSchema } from '@/commons/helpers/api-response.helper'

const day = z.number().int().min(1).max(31)
const aliases = z.array(z.string().trim().min(1).max(40)).max(20)

export const personSchema = z.object({
  name: z.string().trim().min(1).max(60),
  aliases: aliases.optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  documentNumber: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z]{6,15}$/)
    .nullable()
    .optional(),
})

export const paymentMethodSchema = z.object({
  name: z.string().trim().min(1).max(40),
  type: z.enum(PaymentMethodType),
  code: z.string().trim().min(1).max(10).nullable().optional(),
  aliases: aliases.optional(),
  isActive: z.boolean().optional(),
  showInBot: z.boolean().optional(),
  billingCloseDay: day.nullable().optional(),
  paymentDueDay: day.nullable().optional(),
  supportsAmortization: z.boolean().optional(),
  supportsCashback: z.boolean().optional(),
  bank: z.string().trim().min(1).max(40).nullable().optional(),
  network: z.string().trim().max(40).nullable().optional(),
  currency: z.enum(['PEN', 'USD']).nullable().optional(),
  creditLimit: z.number().min(0).nullable().optional(),
  comment: z.string().trim().max(500).nullable().optional(),
  color: z.string().trim().max(20).nullable().optional(),
})

type CardFields = Partial<Record<'type' | 'code' | 'bank' | 'billingCloseDay' | 'paymentDueDay', unknown>>
export const CARD_REQUIRED_FIELDS: Partial<Record<PaymentMethodType, (keyof CardFields)[]>> = {
  [PaymentMethodType.CREDIT_CARD]: ['code', 'billingCloseDay', 'paymentDueDay'],
  [PaymentMethodType.DEBIT_CARD]: ['bank'],
}
export const missingCardFields = (card: CardFields): string[] =>
  (CARD_REQUIRED_FIELDS[card.type as PaymentMethodType] ?? []).filter(
    (field) => card[field] == null || card[field] === '',
  )

export const createPaymentMethodSchema = paymentMethodSchema.superRefine((card, context) => {
  for (const field of missingCardFields(card)) {
    context.addIssue({ code: 'custom', path: [field], message: `Required for a ${card.type}` })
  }
})

export const categorySchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().trim().max(20).optional(),
  icon: z.string().trim().max(40).nullable().optional(),
  isDefault: z.boolean().optional(),
  budgetGroupId: z.string().min(1).nullable().optional(),
})

export const budgetGroupSchema = z.object({
  name: z.string().trim().min(1).max(40),
  emoji: z.string().trim().max(8).optional(),
  percentage: z.number().min(0).max(100).optional(),
  order: z.number().int().min(0).optional(),
})

// ==================== Responses (Swagger / kogane-app types) ====================

const record = { id: z.string(), createdAt: dateTimeSchema, updatedAt: dateTimeSchema }

export const personResponseSchema = z.object({
  ...record,
  name: z.string(),
  aliases: z.array(z.string()),
  isActive: z.boolean(),
  isDefault: z.boolean(),
  documentNumber: z.string().nullable().describe('Masked: only the last 3 characters (D94)'),
})

export const paymentMethodResponseSchema = z.object({
  ...record,
  name: z.string(),
  type: z.enum(PaymentMethodType),
  code: z.string().nullable(),
  aliases: z.array(z.string()),
  isActive: z.boolean(),
  showInBot: z.boolean(),
  billingCloseDay: z.number().int().nullable(),
  paymentDueDay: z.number().int().nullable(),
  supportsAmortization: z.boolean(),
  supportsCashback: z.boolean(),
  bank: z.string().nullable(),
  network: z.string().nullable(),
  currency: z.enum(['PEN', 'USD']).nullable(),
  creditLimit: z.number().nullable(),
  comment: z.string().nullable(),
  color: z.string().nullable(),
  hasStatementPassword: z.boolean().describe('A statement PDF password is saved for this card (I12); never returned'),
})

export const statementPasswordSchema = z.object({
  password: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .nullable()
    .describe('The password of the statement PDFs of this card; null removes it'),
})

export const categoryResponseSchema = z.object({
  ...record,
  name: z.string(),
  color: z.string(),
  icon: z.string().nullable(),
  isDefault: z.boolean(),
  budgetGroupId: z.string().nullable(),
})

export const budgetGroupResponseSchema = z.object({
  ...record,
  name: z.string(),
  emoji: z.string(),
  percentage: z.number(),
  order: z.number().int(),
})

export const cardHoldersSchema = z.object({
  holders: z
    .array(
      z.object({
        personId: z.string().min(1),
        role: z.enum(CardHolderRole),
        last4: z
          .string()
          .regex(/^\d{4}$/, 'The last 4 digits')
          .nullable()
          .optional(),
      }),
    )
    .refine((holders) => holders.filter((holder) => holder.role === CardHolderRole.TITULAR).length === 1, {
      message: 'Exactly one titular',
    })
    .refine((holders) => new Set(holders.map((holder) => holder.personId)).size === holders.length, {
      message: 'A person only once per card',
    }),
})

export const cardHolderResponseSchema = z.object({
  id: z.string(),
  paymentMethodId: z.string(),
  personId: z.string(),
  role: z.enum(CardHolderRole),
  last4: z.string().nullable(),
  person: z.object({ id: z.string(), name: z.string(), aliases: z.array(z.string()) }),
})
