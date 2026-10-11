import { z } from 'zod'

import {
  CalendarEventKind,
  CalendarEventStatus,
  PayMethod,
  PaymentKind,
  PaymentOutcome,
  DEFAULT_INSTALLMENT_MONTHS,
  MAX_CALENDAR_DAYS,
  MAX_INSTALLMENT_MONTHS,
} from '@/commons/constants/calendar.constant'
import { NotificationRefType } from '@/commons/constants/notification.constant'

const day = z.iso.date()
const dayCount = (from: string, to: string) =>
  (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / (24 * 60 * 60_000)

export const calendarQuerySchema = z
  .object({ from: day, to: day })
  .refine(({ from, to }) => from <= to && dayCount(from, to) <= MAX_CALENDAR_DAYS, {
    message: `from must be before to, at most ${MAX_CALENDAR_DAYS} days apart`,
  })

export const installmentsQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(MAX_INSTALLMENT_MONTHS).default(DEFAULT_INSTALLMENT_MONTHS),
})

// ✅ Pagado of the calendar: what a reminder points to (refType and refId of the event) and, optionally, how it was
// paid. Without details everything that is left is paid today
export const payEventSchema = z.object({
  refType: z.enum([
    NotificationRefType.CARD_STATEMENT,
    NotificationRefType.FIXED_COST,
    NotificationRefType.SUBSCRIPTION,
    NotificationRefType.DEBT,
  ]),
  refId: z.string().min(1),
  amount: z
    .number()
    .positive()
    .optional()
    .describe(
      'Card statement or debt: what is paid now (less than what is left leaves the rest open). Fixed cost or subscription: the real amount, which replaces the registered one',
    ),
  kind: z
    .enum(PaymentKind)
    .optional()
    .describe('Card statement only: total, minimum or partial; by default total, or partial when amount is less'),
  paidAt: day.optional().describe('Day of the payment (yyyy-mm-dd); today by default'),
  method: z.enum(PayMethod).optional().describe('Medio de pago: transfer, cash, wallet, debit_card or other'),
  accountId: z.string().min(1).optional().describe('Cuenta de salida: an active account of /v1/accounts'),
  note: z.string().trim().max(500).optional(),
})

// ==================== Responses (Swagger / kogane-app types) ====================

export const calendarEventResponseSchema = z.object({
  date: day,
  kind: z.enum(CalendarEventKind),
  name: z.string().describe('Card, expense or debt description'),
  personName: z.string().nullable(),
  installment: z.string().nullable(),
  amount: z.number().nullable().describe('What is still to pay; the total once paid; null on an empty closing day'),
  currency: z.string(),
  status: z.enum(CalendarEventStatus),
  refType: z.enum(NotificationRefType).nullable(),
  refId: z.string().nullable(),
  color: z.string().nullable(),
})

const monthAmount = { month: z.number().int(), year: z.number().int() }

export const committedInstallmentsResponseSchema = z.object({
  months: z.array(z.object({ ...monthAmount, total: z.number() })),
  cards: z.array(
    z.object({
      paymentMethodId: z.string(),
      name: z.string(),
      color: z.string().nullable(),
      total: z.number(),
      months: z.array(
        z.object({
          ...monthAmount,
          amount: z.number(),
          count: z.number().int(),
          estimated: z.number().int().describe('Installments "por generar" in that month'),
        }),
      ),
    }),
  ),
  items: z.array(
    z.object({
      paymentMethodId: z.string(),
      description: z.string(),
      installment: z.string(),
      amount: z.number(),
      ...monthAmount,
      estimated: z.boolean().describe('Not saved yet: same amount as the last saved installment of the series'),
    }),
  ),
})

export const payEventResponseSchema = z.object({
  outcome: z.enum(PaymentOutcome),
  paymentId: z.string().nullable().describe('The payment registered; null when nothing was paid'),
})
