import { Currency } from '@/commons/constants/expense.constant'

export interface StatementBalanceData {
  currency: string
  totalDue: number | null
  minimumDue: number | null
  previousBalance: number | null
  previousPayments: number | null
  monthlyPayment: number | null
}

// An edit only carries the amounts that changed; the rest stays as saved
export type StatementBalanceUpdate = Partial<StatementBalanceData> & Pick<StatementBalanceData, 'currency'>

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
