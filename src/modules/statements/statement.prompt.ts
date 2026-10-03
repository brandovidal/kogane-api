import { statementBalances, StatementBalanceData } from './statement.balance'
import { z } from 'zod'

import { Currency } from '@/commons/constants/expense.constant'

import { lockCancelledStatementRows, ParsedStatement } from './statement.parser'

// The AI reads only the extracted text of the statement (never the PDF nor the document number, D94, D95)
export const STATEMENT_INSTRUCTIONS = `You read the text of a Peruvian credit card statement (estado de cuenta).
Return JSON with:
- cardName: the card as printed (e.g. "Sip", "American Express Green", "iO", "CMR").
- holderName: the cardholder's name as printed (titular / cliente), or null.
- periodEnd: closing date of the billing period (YYYY-MM-DD) or null.
- dueDate: last day to pay (YYYY-MM-DD) or null.
- totalDue: total amount to pay of this statement, or null. minimumDue: minimum payment, or null.
- previousBalance: "saldo mes anterior" before payments, or null. previousPayments: total payments/credits applied against
  that balance as a positive number, or null. monthlyPayment: the amount labelled "pago del mes", or null.
- balances: one object per billing currency printed in the PDF (PEN and/or USD). Each has currency, totalDue,
  minimumDue, previousBalance, previousPayments, monthlyPayment. Use null when a value is not printed.
  Read soles and dollars columns independently, even when both are on the same line. Never add them or convert.
- currency and the top-level totals: compatibility copy of the PEN balance, or USD if there is no PEN balance.
- The billing currency of each movement comes from its column, section heading or explicit symbol, NOT the country
  of the merchant. A foreign merchant can bill in soles. Do not use the original purchase amount in a second
  currency as another movement when the bank already converted it to the billing currency.
- movements: every purchase and every individual charge of the period, one per line of the statement: date (YYYY-MM-DD,
  the processing date when there are two), description as printed, amount (positive for charges, negative for annulments), currency, installment "n/m"
  when the line is an installment of a purchase, otherwise null. Include itemized compensatory or late interest, insurance,
  fees, commissions and taxes (for example ITF).
Leave out payments to the card except a payment line that is explicitly part of a purchase cancellation; leave out the
previous balance, totals and explanatory interest summaries that are not individual movements. Keep both the original
purchase and its matching "ANULACION" / reversal as movements with equal opposite amounts. Never omit an itemized charge
because it is interest or a fee.
Do not invent movements: if the text has none, return an empty list.`

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()

const balanceSchema = z.object({
  currency: z.enum(Currency),
  totalDue: z.number().nullable(),
  minimumDue: z.number().nullable(),
  previousBalance: z.number().nullable(),
  previousPayments: z.number().nullable(),
  monthlyPayment: z.number().nullable(),
})

export const statementAiSchema = z.object({
  balances: z.array(balanceSchema).max(2).optional(),
  cardName: z.string().nullable(),
  holderName: z.string().nullable().optional(), // optional: answers recorded before it still parse
  periodEnd: day,
  dueDate: day,
  totalDue: z.number().nullable(),
  minimumDue: z.number().nullable(),
  previousBalance: z.number().nonnegative().nullable().optional(),
  previousPayments: z.number().nonnegative().nullable().optional(),
  monthlyPayment: z.number().nonnegative().nullable().optional(),
  currency: z.enum(Currency),
  movements: z.array(
    z.object({
      date: day,
      description: z.string().min(1),
      amount: z.number().refine((amount) => amount !== 0),
      currency: z.enum(Currency),
      installment: z
        .string()
        .regex(/^\d{1,3}\/\d{1,3}$/)
        .nullable(),
    }),
  ),
})

// Without $schema, as expenseExtractionJsonSchema (Gemini rejects it)
export const statementAiJsonSchema = (() => {
  const { $schema: _schema, ...jsonSchema } = z.toJSONSchema(statementAiSchema) as Record<string, unknown>
  return jsonSchema
})()

export type StatementAiOutput = z.infer<typeof statementAiSchema>

export function fromAi(output: StatementAiOutput, cardHint: string | null): ParsedStatement {
  const balances: StatementBalanceData[] = output.balances?.length
    ? output.balances
    : statementBalances({
        ...output,
        previousBalance: output.previousBalance ?? null,
        previousPayments: output.previousPayments ?? (output.previousBalance != null ? 0 : null),
        monthlyPayment: output.monthlyPayment ?? null,
      })
  const normalizedBalances = balances.map((balance) => ({
    ...balance,
    totalDue: balance.totalDue ?? balance.monthlyPayment,
  }))
  const primary = normalizedBalances.find((balance) => balance.currency === Currency.PEN) ?? normalizedBalances[0]
  const rows = output.movements.map((movement) => ({ ...movement }))
  for (const balance of normalizedBalances) {
    if (balance.previousBalance == null || balance.previousPayments == null) continue
    const remainder = Math.round((balance.previousBalance - balance.previousPayments) * 100) / 100
    if (remainder > 0)
      rows.push({
        date: null,
        description: `Saldo mes anterior neto (${balance.previousBalance.toFixed(2)} - ${balance.previousPayments.toFixed(2)})`,
        amount: remainder,
        currency: balance.currency as Currency,
        installment: null,
      })
  }
  return {
    cardHint,
    holderName: output.holderName ?? null,
    cardName: output.cardName,
    periodEnd: output.periodEnd,
    dueDate: output.dueDate,
    ...primary,
    balances: normalizedBalances,
    rows: lockCancelledStatementRows(rows),
  }
}
