import { Debt, DebtPayment, Person, Prisma } from '@/generated/prisma/client'

export type CreateDebtDbDto = Omit<Prisma.DebtUncheckedCreateInput, 'id' | 'status' | 'paidAmount' | 'paidDate'>

export type UpdateDebtDbDto = Partial<
  Pick<
    Debt,
    | 'description'
    | 'amount'
    | 'currency'
    | 'exchangeRate'
    | 'amountInPen'
    | 'installment'
    | 'paymentMonth'
    | 'paymentYear'
    | 'dueDate'
    | 'personId'
    | 'paymentMethodId'
    | 'notes'
  >
>

export interface DebtFilterDbDto {
  personId?: string
  direction?: string
  statuses?: string[]
  month?: number // with year: that payment month (or every one until it, with until)
  year?: number
  until?: boolean
  from?: string // YYYY-MM range (PeriodFilter), only without month and year
  to?: string
  paymentMethodId?: string
}

export interface CreateDebtPaymentDbDto {
  debtId: string
  amount: number
  paidAt: Date
  paymentMethodId?: string | null
  kind?: string // DebtPaymentKind
  notes?: string | null
}

export type DebtWithPersonDbDto = Debt & { person: Pick<Person, 'id' | 'name'> }

export type DebtPaymentProposalDbDto = DebtPayment & { debt: DebtWithPersonDbDto }
