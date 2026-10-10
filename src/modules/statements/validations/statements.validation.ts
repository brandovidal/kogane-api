import { z } from 'zod'

import { Currency } from '@/commons/constants/expense.constant'

import { StatementRowResult, StatementSource, StatementStatus } from '@/commons/constants/statement.constant'
import { dateTimeSchema } from '@/commons/helpers/api-response.helper'

export const uploadStatementSchema = z.object({
  password: z.string().trim().max(40).optional(),
  paymentMethodId: z.string().min(1).optional(),
  personId: z.string().min(1).optional(),
  // multipart sends "true"; the password is saved only if it opened the PDF (D94)
  savePassword: z.stringbool().optional(),
  saveCardPassword: z.stringbool().optional(),
})

const updateStatementBalanceSchema = z
  .object({
    currency: z.enum(Currency),
    totalDue: z.number().nullable().optional(),
    minimumDue: z.number().nullable().optional(),
    previousBalance: z.number().nullable().optional(),
    previousPayments: z.number().nullable().optional(),
    monthlyPayment: z.number().nullable().optional(),
  })
  .refine((balance) => Object.keys(balance).some((key) => key !== 'currency'))

export const updateStatementSchema = z
  .object({
    personId: z.string().min(1).optional(),
    // Corrects a wrongly identified card (D-105+): re-reconciles the rows that are not a card expense yet
    paymentMethodId: z.string().min(1).optional(),
    currency: z.enum(Currency).optional(),
    minimumDue: z.number().nonnegative().nullable().optional(),
    minimumAllocations: z.record(z.string(), z.number().nonnegative()).nullable().optional(),
    balances: z
      .array(updateStatementBalanceSchema)
      .min(1)
      .refine((balances) => new Set(balances.map((balance) => balance.currency)).size === balances.length)
      .optional(),
  })
  .refine(
    (value) =>
      value.personId !== undefined ||
      value.paymentMethodId !== undefined ||
      value.minimumDue !== undefined ||
      value.minimumAllocations !== undefined ||
      value.balances !== undefined,
  )

// Selección múltiple (D116): the person of several purchases at once; null goes back to the statement's
export const assignRowsSchema = z.object({
  rowIds: z.array(z.string().min(1)).min(1).max(500),
  personId: z.string().min(1).nullable(),
})

export const createNewRowsSchema = z.object({
  rowIds: z
    .array(z.string().min(1))
    .optional()
    .describe('Only these rows (also matched or ignored ones: created anyway); without it every new row'),
})

export const updateRowSchema = z
  .object({
    result: z.enum([StatementRowResult.IGNORED, StatementRowResult.NEW]).optional(),
    label: z
      .string()
      .trim()
      .max(120)
      .nullable()
      .optional()
      .describe('Your description; empty goes back to the bank text'),
    personId: z.string().min(1).nullable().optional().describe("Who made it; null goes back to the statement's person"),
  })
  .refine(
    (body) => body.result !== undefined || body.label !== undefined || body.personId !== undefined,
    'result, label or personId is required',
  )

// ==================== Responses (Swagger / kogane-app types) ====================

export const statementBalanceResponseSchema = z.object({
  currency: z.enum(Currency),
  totalDue: z.number().nullable(),
  minimumDue: z.number().nullable(),
  previousBalance: z.number().nullable(),
  previousPayments: z.number().nullable(),
  monthlyPayment: z.number().nullable(),
})

const statementFields = {
  currencyReviewRequired: z.boolean(),
  balances: z.array(statementBalanceResponseSchema),
  id: z.string(),
  paymentMethodId: z.string(),
  personId: z.string().nullable(),
  cardName: z.string(),
  paymentMonth: z.number().int(),
  paymentYear: z.number().int(),
  periodStart: dateTimeSchema.nullable(),
  periodEnd: dateTimeSchema.nullable(),
  dueDate: dateTimeSchema.nullable(),
  totalDue: z.number().nullable(),
  minimumDue: z.number().nullable(),
  previousBalance: z.number().nullable(),
  previousPayments: z.number().nullable(),
  monthlyPayment: z.number().nullable(),
  currency: z.string(),
  source: z.enum(StatementSource),
  fileId: z.string().nullable(),
  status: z.enum(StatementStatus),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
}

export const statementRowResponseSchema = z.object({
  id: z.string(),
  statementId: z.string(),
  date: dateTimeSchema.nullable(),
  description: z.string().describe('As the bank wrote it (never edited)'),
  label: z.string().nullable().describe('Your description: the name of the expense it creates'),
  amount: z.number(),
  currency: z.string(),
  installment: z.string().nullable(),
  locked: z.boolean(),
  result: z.enum(StatementRowResult),
  expenseId: z.string().nullable(),
  personId: z
    .string()
    .nullable()
    .describe("Who it belongs to: the person of its expense, the one chosen for the row, or the statement's"),
  debtId: z.string().nullable().describe("The cobro created with it when the purchase is another person's (D116)"),
  createdAt: dateTimeSchema,
})

export const statementResponseSchema = z.object({
  ...statementFields,
  balances: z.array(
    statementBalanceResponseSchema.extend({
      koganeTotal: z.number(),
      difference: z.number().nullable(),
      // "Resumen de movimientos y pagos del mes" (D95): computed from the rows below, not stated by the bank
      directConsumption: z.number().describe('Purchases without an installment plan, no interest/fees'),
      installmentConsumption: z.number().describe('Purchases with an installment plan ("2/6"), no interest/fees'),
      itemizedCharges: z.number().describe('Interest, insurance, commissions, ITF… as itemized rows'),
    }),
  ),
  rows: z.array(statementRowResponseSchema),
  missing: z
    .array(
      z.object({
        id: z.string(),
        description: z.string(),
        amount: z.number(),
        currency: z.string(),
        processDate: z.string().nullable(),
        installment: z.string().nullable(),
        personId: z.string(),
      }),
    )
    .describe('Card expenses of the month that are not in the statement'),
  koganeTotal: z.number().describe('Card expenses registered for that payment month'),
  difference: z.number().nullable().describe('totalDue − koganeTotal'),
})

export const statementSummaryResponseSchema = z.object({
  ...statementFields,
  counts: z.object({
    matched: z.number().int(),
    new: z.number().int(),
    created: z.number().int(),
    ignored: z.number().int(),
  }),
})

export const statementFileSchema = z.object({
  url: z.string().nullable().describe('Signed link to the PDF (10 minutes); null when the file was not kept'),
})
