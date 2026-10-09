import { PaymentMethod } from '@/generated/prisma/client'

// The statement password never leaves the repository: only whether there is one
export type PaymentMethodDbDto = Omit<PaymentMethod, 'aliases' | 'statementPassword'> & {
  aliases: string[]
  hasStatementPassword: boolean
}

export interface PaymentMethodWriteDbDto {
  name: string
  type: string // PaymentMethodType
  code?: string | null
  aliases?: string[]
  isActive?: boolean
  showInBot?: boolean
  billingCloseDay?: number | null
  paymentDueDay?: number | null
  supportsAmortization?: boolean
  supportsCashback?: boolean
  bank?: string | null
  network?: string | null
  currency?: string | null
  creditLimit?: number | null
  comment?: string | null
  color?: string | null
}
