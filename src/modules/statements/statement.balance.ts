import { Currency } from '@/commons/constants/expense.constant'

export interface StatementBalanceData {
  currency: string
  totalDue: number | null
  minimumDue: number | null
  previousBalance: number | null
  previousPayments: number | null
  monthlyPayment: number | null
}

export const emptyStatementBalance = (currency: string): StatementBalanceData => ({
  currency,
  totalDue: null,
  minimumDue: null,
  previousBalance: null,
  previousPayments: null,
  monthlyPayment: null,
})

// Legacy callers read only the primary currency; the new API exposes every balance.
export function statementBalances(
  value: Partial<StatementBalanceData> & { balances?: StatementBalanceData[] },
): StatementBalanceData[] {
  return value.balances?.length
    ? value.balances
    : [
        {
          currency: value.currency ?? Currency.PEN,
          totalDue: value.totalDue ?? null,
          minimumDue: value.minimumDue ?? null,
          previousBalance: value.previousBalance ?? null,
          previousPayments: value.previousPayments ?? null,
          monthlyPayment: value.monthlyPayment ?? null,
        },
      ]
}
