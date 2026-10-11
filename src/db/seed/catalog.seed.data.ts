// Catalogs taken from the Notion boards ("Seguimiento financiero", read on 2026-09-22) and kogane-app mocks.
// Names are the user's data, so they keep their Spanish spelling. Aliases are what the AI and the bot match.
import { PaymentMethodType } from '@/commons/constants/catalog.constant'

export interface PersonSeed {
  name: string
  aliases?: string[]
  isDefault?: boolean
}

export interface PaymentMethodSeed {
  name: string
  type: PaymentMethodType
  aliases: string[]
  showInBot?: boolean
  isPrimary?: boolean
  bank?: string // debit cards (D107)
  // credit cards only
  code?: string
  billingCloseDay?: number
  paymentDueDay?: number
  color?: string
}

export interface BudgetGroupSeed {
  name: string
  emoji: string
  percentage: number
  order: number
}

export interface CategorySeed {
  name: string
  color: string
  icon: string
  budgetGroup: string
}

// Every "Persona" option across the card, fixed cost and receivable boards. Brando is the owner (D19).
export const PEOPLE: PersonSeed[] = [
  { name: 'Brando', aliases: ['yo', 'yuji'], isDefault: true },
  { name: 'Danery', aliases: ['dany'] },
  { name: 'Brenda' },
  { name: 'Bruce' },
  { name: 'Alexander' },
  { name: 'Dora' },
  { name: 'Bryan' },
  { name: 'Miguel' },
  { name: 'Abel' },
  { name: 'Jordy' },
  { name: 'Paola' },
  { name: 'Josue' },
  { name: 'Jesus' },
  { name: 'Sandro' },
  { name: 'Marjorie' },
  { name: 'Kevin' },
  { name: 'Andrea' },
  { name: 'Wally' },
  { name: 'Angie' },
  { name: 'Vanessa' },
]

// "Cuenta" options of Costos fijos and Plataformas plus Efectivo. Credit cards carry the closing and due days
// from the board titles ("Resumen de gastos de IO - 25 cierre / 12 pago límite").
export const PAYMENT_METHODS: PaymentMethodSeed[] = [
  { name: 'Yape', type: PaymentMethodType.WALLET, aliases: ['yape'] },
  { name: 'Plin', type: PaymentMethodType.WALLET, aliases: ['plin'] },
  { name: 'Efectivo', type: PaymentMethodType.CASH, aliases: ['efectivo', 'cash'] },
  { name: 'Interbank', type: PaymentMethodType.DEBIT_CARD, aliases: ['interbank', 'ibk'], bank: 'Interbank' },
  { name: 'BCP', type: PaymentMethodType.DEBIT_CARD, aliases: ['bcp'], bank: 'BCP' },
  {
    name: 'CMR',
    type: PaymentMethodType.CREDIT_CARD,
    aliases: ['cmr', 'falabella', 'cmr falabella'],
    code: 'CMR',
    billingCloseDay: 10,
    paymentDueDay: 5,
    color: '#7C3AED',
  },
  {
    name: 'Oh Pay',
    type: PaymentMethodType.CREDIT_CARD,
    aliases: ['oh', 'ohpay', 'la oh'],
    code: 'OH',
    billingCloseDay: 10,
    paymentDueDay: 3,
    color: '#10B981',
  },
  {
    name: 'IO',
    type: PaymentMethodType.CREDIT_CARD,
    aliases: ['io', 'interbank io'],
    code: 'IO',
    isPrimary: true, // D47: bank screenshots without a visible card are IO
    billingCloseDay: 25,
    paymentDueDay: 12,
    color: '#3B82F6',
  },
  {
    name: 'AMEX',
    type: PaymentMethodType.CREDIT_CARD,
    aliases: ['amex', 'american express'],
    code: 'AMEX',
    billingCloseDay: 21,
    paymentDueDay: 15,
    color: '#F59E0B',
  },
]

// What every new user starts with (D97): ways to pay that need no data of their own, and the credit cards most people
// in Peru have, inactive ("no la tengo") and without billing days: the user turns on the ones they own and sets the
// closing and due days. Created once; later edits are never overwritten
export const BASE_PAYMENT_METHODS: PaymentMethodSeed[] = [
  { name: 'Efectivo', type: PaymentMethodType.CASH, aliases: ['efectivo', 'cash'] },
  { name: 'Yape', type: PaymentMethodType.WALLET, aliases: ['yape'] },
  { name: 'Plin', type: PaymentMethodType.WALLET, aliases: ['plin'] },
  { name: 'Interbank Débito', type: PaymentMethodType.DEBIT_CARD, aliases: ['interbank', 'ibk'], bank: 'Interbank' },
  { name: 'BCP Débito', type: PaymentMethodType.DEBIT_CARD, aliases: ['bcp'], bank: 'BCP' },
  { name: 'BBVA Débito', type: PaymentMethodType.DEBIT_CARD, aliases: ['bbva'], bank: 'BBVA' },
  {
    name: 'Scotiabank Débito',
    type: PaymentMethodType.DEBIT_CARD,
    aliases: ['scotiabank', 'scotia'],
    bank: 'Scotiabank',
  },
  {
    name: 'Interbank',
    type: PaymentMethodType.CREDIT_CARD,
    aliases: ['interbank crédito'],
    code: 'IBK',
    color: '#10B981',
  },
  { name: 'BCP', type: PaymentMethodType.CREDIT_CARD, aliases: ['bcp crédito'], code: 'BCP', color: '#F97316' },
  { name: 'BBVA', type: PaymentMethodType.CREDIT_CARD, aliases: ['bbva crédito'], code: 'BBVA', color: '#3B82F6' },
  {
    name: 'Scotiabank',
    type: PaymentMethodType.CREDIT_CARD,
    aliases: ['scotia crédito'],
    code: 'SCO',
    color: '#EF4444',
  },
  {
    name: 'CMR',
    type: PaymentMethodType.CREDIT_CARD,
    aliases: ['cmr', 'falabella', 'cmr falabella'],
    code: 'CMR',
    color: '#7C3AED',
  },
  { name: 'Oh Pay', type: PaymentMethodType.CREDIT_CARD, aliases: ['oh', 'ohpay'], code: 'OH', color: '#14B8A6' },
  {
    name: 'Ripley',
    type: PaymentMethodType.CREDIT_CARD,
    aliases: ['ripley', 'banco ripley'],
    code: 'RIP',
    color: '#8B5CF6',
  },
  {
    name: 'AMEX',
    type: PaymentMethodType.CREDIT_CARD,
    aliases: ['amex', 'american express'],
    code: 'AMEX',
    color: '#F59E0B',
  },
]

// "Relación de gastos" board: current percentages (36 / 50 / 0 / 14)
export const BUDGET_GROUPS: BudgetGroupSeed[] = [
  { name: 'Costos Fijos', emoji: '🏠', percentage: 36, order: 1 },
  { name: 'Gastos sin culpa', emoji: '🎉', percentage: 50, order: 2 },
  { name: 'Inversión', emoji: '📈', percentage: 0, order: 3 },
  { name: 'Ahorros', emoji: '💰', percentage: 14, order: 4 },
]

// "Categoria" options of Costos fijos plus the everyday ones from kogane-app
export const CATEGORIES: CategorySeed[] = [
  { name: 'Personal', color: '#8B5CF6', icon: 'user', budgetGroup: 'Gastos sin culpa' },
  { name: 'Prestamo', color: '#10B981', icon: 'banknote', budgetGroup: 'Costos Fijos' },
  { name: 'Salud', color: '#3B82F6', icon: 'heart-pulse', budgetGroup: 'Costos Fijos' },
  { name: 'Casa', color: '#6B7280', icon: 'home', budgetGroup: 'Costos Fijos' },
  { name: 'Junta', color: '#EAB308', icon: 'users', budgetGroup: 'Ahorros' },
  { name: 'Trabajo', color: '#64748B', icon: 'briefcase', budgetGroup: 'Inversión' },
  { name: 'Estudio', color: '#3B82F6', icon: 'graduation-cap', budgetGroup: 'Inversión' },
  { name: 'Comida', color: '#F97316', icon: 'utensils', budgetGroup: 'Gastos sin culpa' },
  { name: 'Transporte', color: '#06B6D4', icon: 'car', budgetGroup: 'Costos Fijos' },
  { name: 'Entretenimiento', color: '#EC4899', icon: 'gamepad-2', budgetGroup: 'Gastos sin culpa' },
  { name: 'Servicios', color: '#0EA5E9', icon: 'zap', budgetGroup: 'Costos Fijos' },
  { name: 'Ropa', color: '#A855F7', icon: 'shirt', budgetGroup: 'Gastos sin culpa' },
  { name: 'Regalos', color: '#F43F5E', icon: 'gift', budgetGroup: 'Gastos sin culpa' },
  { name: 'Mascotas', color: '#84CC16', icon: 'paw-print', budgetGroup: 'Gastos sin culpa' },
  { name: 'Viajes', color: '#14B8A6', icon: 'plane', budgetGroup: 'Gastos sin culpa' },
]
