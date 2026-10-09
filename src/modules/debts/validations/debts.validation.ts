import { yearMonthSchema } from '@/commons/helpers/period-range.helper'
import { z } from 'zod'

import { DebtDirection, DebtPaymentKind, DebtStatus, DebtTiming } from '@/commons/constants/debt.constant'
import { Currency } from '@/commons/constants/expense.constant'
import { StatementRowResult } from '@/commons/constants/statement.constant'
import { dateTimeSchema } from '@/commons/helpers/api-response.helper'

// YYYY-MM-DD from the web forms, stored as a date at 00:00 UTC
const date = z.iso.date().transform((value) => new Date(`${value}T00:00:00.000Z`))
const amount = z.number().positive()

const month = z.coerce.number().int().min(1).max(12)
const year = z.coerce.number().int().min(2000).max(2100)

// Cobros / Deudas (D111, D114): the month of the header by default; "until" = that month and every earlier one
export const debtListQuerySchema = z.object({
  personId: z.string().min(1).optional(),
  direction: z.enum(DebtDirection).optional(),
  status: z.enum(DebtStatus).optional(),
  month: month.optional(),
  year: year.optional(),
  until: z.stringbool().optional().describe('With month and year: that month and every earlier one'),
  from: yearMonthSchema.optional().describe('First payment month of a range (YYYY-MM); ignored with month and year'),
  to: yearMonthSchema.optional().describe('Last payment month of a range (YYYY-MM); ignored with month and year'),
  paymentMethodId: z.string().min(1).optional().describe('The card the debts were charged on (D114)'),
})

export const debtSummaryQuerySchema = z.object({
  month: month.optional(),
  year: year.optional(),
  until: z.stringbool().optional(),
  from: yearMonthSchema.optional().describe('First payment month of a range (YYYY-MM)'),
  to: yearMonthSchema.optional().describe('Last payment month of a range (YYYY-MM)'),
})

const debtFields = {
  description: z.string().trim().min(1),
  amount,
  currency: z.enum(Currency).optional(),
  exchangeRate: z.number().positive().nullable().optional(),
  personId: z.string().min(1),
  paymentMonth: z.number().int().min(1).max(12),
  paymentYear: z.number().int().min(2000).max(2100),
  dueDate: date.nullable().optional(),
  paymentMethodId: z.string().min(1).nullable().optional().describe('The card it was charged on (D114)'),
  notes: z.string().trim().max(500).nullable().optional(),
}

// "installments: 3" creates three rows, one per month from paymentMonth (D60); amount is each installment's
export const createDebtSchema = z.object({
  ...debtFields,
  direction: z.enum(DebtDirection),
  installments: z.number().int().min(1).max(120).optional(),
})

// One installment at a time; paidAmount and status follow the payments and cannot be edited
export const updateDebtSchema = z
  .object({
    ...debtFields,
    installment: z
      .string()
      .regex(/^\d{1,3}\/\d{1,3}$/)
      .nullable(),
  })
  .partial()

export const debtPaymentSchema = z.object({
  amount,
  kind: z.enum(DebtPaymentKind).optional().describe('Pago · Abono · Amortizado · Cashback (D114); payment by default'),
  paidAt: date.optional(),
  paymentMethodId: z.string().min(1).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
})

// ==================== Responses (Swagger / kogane-app types) ====================

export const debtResponseSchema = z.object({
  id: z.string(),
  direction: z.enum(DebtDirection),
  description: z.string(),
  amount: z.number(),
  currency: z.string(),
  exchangeRate: z.number().nullable(),
  amountInPen: z.number().nullable(),
  installment: z.string().nullable(),
  paymentMonth: z.number().int(),
  paymentYear: z.number().int(),
  carriedFromMonth: z
    .number()
    .int()
    .nullable()
    .describe('Carried to this month from that payment month ("Arrastrada de …")'),
  carriedFromYear: z.number().int().nullable(),
  dueDate: dateTimeSchema.nullable(),
  status: z.enum(DebtStatus),
  paidAmount: z.number(),
  paidDate: dateTimeSchema.nullable(),
  personId: z.string(),
  paymentMethodId: z.string().nullable(),
  notes: z.string().nullable(),
  draftId: z.string().nullable(),
  originDraftId: z.string().nullable().describe('The expense draft that created it (installments, shared parts, D73)'),
  createdAt: dateTimeSchema,
  updatedAt: dateTimeSchema,
})

// Listed with the person, the balance and the timing computed from today
export const debtViewResponseSchema = debtResponseSchema.extend({
  person: z.object({ id: z.string(), name: z.string() }),
  balance: z.number(),
  timing: z.enum(DebtTiming),
})

export const debtPaymentResponseSchema = z.object({
  id: z.string(),
  debtId: z.string(),
  amount: z.number(),
  paidAt: dateTimeSchema,
  paymentMethodId: z.string().nullable(),
  kind: z.enum(DebtPaymentKind),
  batchId: z.string().nullable(),
  confirmedAt: dateTimeSchema.nullable(),
  notes: z.string().nullable(),
  createdAt: dateTimeSchema,
})

export const debtPaymentCreatedResponseSchema = debtResponseSchema.extend({
  paymentId: z.string().describe('The new payment: attach its Comprobante with refType debt_payment'),
})

export const debtDetailResponseSchema = debtViewResponseSchema.extend({ payments: z.array(debtPaymentResponseSchema) })

export const debtSummaryResponseSchema = z.object({
  personId: z.string(),
  name: z.string(),
  owedToMe: z.number(),
  iOwe: z.number(),
  net: z.number().describe('Positive: the person owes the user'),
  late: z.number(),
  dueThisMonth: z.number(),
})

// Selección múltiple (D115): one action over several debts, in one transaction
export enum DebtBulkAction {
  PAY = 'pay', // pay the balance of each one
  PREPAID = 'prepaid', // Amortizado: the balance, before its month
  CASHBACK = 'cashback', // the bank gave it back
  PARTIAL = 'partial', // Abono: an amount spread over them, oldest first
  CLONE = 'clone', // a copy of each one (without payments) in another month
  RESET = 'reset', // back to "No iniciado": its payments are removed
  CARD = 'card', // the card they were charged on
  DELETE = 'delete',
}

export const debtBulkSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(500),
    action: z.enum(DebtBulkAction),
    amount: amount.optional().describe('partial: the amount to spread'),
    paidAt: date.optional(),
    paymentMethodId: z.string().min(1).nullable().optional().describe('card: the card; payments: how it was paid'),
    month: z.number().int().min(1).max(12).optional().describe('clone: the target month'),
    year: z.number().int().min(2000).max(2100).optional().describe('clone: the target year'),
    force: z.boolean().optional().describe('delete: also debts with payments'),
  })
  .superRefine((body, context) => {
    const need = (field: keyof typeof body, when: boolean) => {
      if (when && body[field] == null)
        context.addIssue({ code: 'custom', path: [field], message: `Required for ${body.action}` })
    }
    need('amount', body.action === DebtBulkAction.PARTIAL)
    need('month', body.action === DebtBulkAction.CLONE)
    need('year', body.action === DebtBulkAction.CLONE)
  })

export const debtBulkResponseSchema = z.object({
  action: z.enum(DebtBulkAction),
  affected: z.number().int().describe('Debts changed, created or deleted'),
  paid: z.number().describe('Amount registered as payments'),
  excess: z.number().describe('partial: what was left over after every balance'),
  skipped: z.array(z.string()).describe('Debts left out: already paid, or with payments on delete without force'),
})

// "Arrastrar saldos pendientes al mes en curso": the open installments of earlier months move to the target month,
// remembering where they came from (carriedFrom…, the first time only)
export const debtCarryOverSchema = z.object({
  month: z.number().int().min(1).max(12).describe('The target month (usually the current one)'),
  year: z.number().int().min(2000).max(2100),
  direction: z.enum(DebtDirection).optional().describe('Only cobros (owed_to_me) or only deudas (i_owe)'),
  personId: z.string().min(1).optional(),
  dryRun: z.boolean().optional().describe('Only count what would be carried (the confirmation of the dialog)'),
})

export const debtCarryOverResponseSchema = z.object({
  dryRun: z.boolean(),
  affected: z.number().int().describe('Installments carried (or that would be)'),
  balance: z.number().describe('Their open balance in soles'),
  ids: z.array(z.string()),
})

// Contraste con la tarjeta (D114): what each person owes on a card in a month vs what the statement billed
export const cardCheckQuerySchema = z.object({
  paymentMethodId: z.string().min(1),
  month,
  year,
  currency: z.enum(Currency).optional(),
})

export const cardCheckResponseSchema = z.object({
  currency: z.enum(Currency),
  availableCurrencies: z.array(z.enum(Currency)),
  currencyReviewRequired: z.boolean(),
  paymentMethodId: z.string(),
  month: z.number().int(),
  year: z.number().int(),
  statementId: z.string().nullable().describe('The statement of that card and month, when uploaded'),
  statementPersonId: z.string().nullable().describe('The person assigned as the statement holder'),
  statementTotal: z.number().nullable().describe('What the bank asks to pay'),
  statementPeriodEnd: dateTimeSchema.nullable().describe('End of the card billing cycle'),
  statementDueDate: dateTimeSchema.nullable().describe('Due date of the statement payment'),
  minimumDue: z.number().nullable().describe('Minimum payment on the statement'),
  minimumAllocations: z
    .record(z.string(), z.number())
    .nullable()
    .describe('Saved proposed minimum payment contribution per person'),
  koganeTotal: z.number().describe('Card expenses registered for that month'),
  unexplained: z.number().nullable().describe('statementTotal − koganeTotal: interest, fees or charges not registered'),
  othersOwed: z.number().describe('What other people owe of that card and month'),
  othersPaid: z.number(),
  people: z.array(
    z.object({
      personId: z.string(),
      name: z.string(),
      owed: z.number().describe('Their debts on that card and month'),
      paid: z.number(),
      balance: z.number(),
    }),
  ),
  periodPayments: z.array(
    z.object({
      personId: z.string(),
      name: z.string(),
      amount: z.number(),
    }),
  ),
  expensesByPerson: z.array(
    z.object({
      personId: z.string(),
      name: z.string(),
      amount: z.number(),
      expenses: z.array(z.object({ id: z.string(), description: z.string(), amount: z.number() })),
    }),
  ),
  statementRows: z.array(
    z.object({
      id: z.string(),
      date: dateTimeSchema.nullable(),
      description: z.string(),
      label: z.string().nullable(),
      amount: z.number(),
      installment: z.string().nullable(),
      result: z.enum(StatementRowResult),
      personId: z.string().nullable(),
      expenseId: z.string().nullable(),
      debtId: z.string().nullable(),
    }),
  ),
  possibleInterest: z
    .array(z.object({ description: z.string(), amount: z.number() }))
    .describe('Statement lines of that month or the next that read like interest or fees'),
})
