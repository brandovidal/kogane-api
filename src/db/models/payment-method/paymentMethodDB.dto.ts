import { PaymentMethod } from '@/generated/prisma/client'

export type PaymentMethodDbDto = Omit<PaymentMethod, 'aliases'> & { aliases: string[] }

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
