import { DebtDirection } from '@/commons/constants/debt.constant'
import { RecurringTargetType, SubscriptionKind } from '@/commons/constants/expense.constant'
import { normalizeText } from '@/modules/expense-extraction/expense-extraction.catalog'

import { CsvRow } from '../notion/notion-csv'
import { currencyOf, dateOf, installmentOf, moneyOf, monthYearOf, periodOf } from '../notion/notion.values'

// "Importar gastos… / plataformas… / recurrentes… / cuotas… / deudas…" of the ⋯ menu of each list: a CSV with the
// columns of "Exportar lista (CSV)" (Spanish or English headers). Pure: names are resolved with the catalogs given
export enum ListImportTarget {
  DAILY = 'daily-expenses',
  PLATFORMS = 'platforms',
  RECURRING = 'recurring-expenses',
  RECEIVABLES = 'receivables', // Cobros: cuotas que me deben
  PAYABLES = 'payables', // Deudas: lo que debo
}

export interface CatalogItem {
  id: string
  name: string
  aliases?: string[]
}

export interface ListImportCatalogs {
  people: CatalogItem[]
  paymentMethods: CatalogItem[]
  categories: CatalogItem[]
  defaultPersonId: string | null
}

export interface MappedListRow {
  line: number
  description: string | null
  amount: number | null
  issues: string[] // Spanish, shown in the preview
  body: Record<string, unknown> | null // what POST /expenses/:resource or /debts receives; null with issues
}

const COLUMNS = {
  description: ['descripcion', 'description', 'concepto', 'nombre'],
  amount: ['monto', 'amount', 'importe'],
  currency: ['moneda', 'currency'],
  date: ['fecha', 'date'],
  month: ['mes de pago', 'mes', 'payment month', 'month'],
  person: ['persona', 'person', 'quien'],
  method: ['medio de pago', 'payment method', 'tarjeta', 'cuenta'],
  category: ['categoria', 'category'],
  installment: ['cuota', 'installment', 'cuotas'],
  day: ['dia de cobro', 'dia', 'day'],
  period: ['frecuencia', 'periodo', 'period'],
  notes: ['nota', 'notas', 'notes'],
} as const

type Column = keyof typeof COLUMNS

const valueOf = (row: CsvRow, column: Column): string => {
  const wanted = COLUMNS[column] as readonly string[]
  const header = Object.keys(row.values).find((key) => wanted.includes(normalizeText(key)))
  return header ? row.values[header].trim() : ''
}

const findByName = (items: CatalogItem[], name: string): CatalogItem | null => {
  const target = normalizeText(name)
  if (!target) return null
  return (
    items.find((item) => [item.name, ...(item.aliases ?? [])].some((term) => normalizeText(term) === target)) ?? null
  )
}

// "Octubre 2026", "10/2026", "2026-10" → { month, year }
export function paymentMonthOf(text: string): { month: number; year: number } | null {
  const numeric = /^(\d{1,2})\/(\d{4})$/.exec(text.trim()) ?? /^(\d{4})-(\d{1,2})$/.exec(text.trim())
  if (numeric) {
    const [first, second] = [Number(numeric[1]), Number(numeric[2])]
    const [month, year] = first > 12 ? [second, first] : [first, second]
    return month >= 1 && month <= 12 ? { month, year } : null
  }
  return monthYearOf(text)
}

export function mapListRow(target: ListImportTarget, row: CsvRow, catalogs: ListImportCatalogs): MappedListRow {
  const issues: string[] = []
  const description = valueOf(row, 'description') || null
  const amount = moneyOf(valueOf(row, 'amount'))
  if (!description) issues.push('Falta la descripción')
  if (amount == null || amount <= 0) issues.push('Falta el monto o no es mayor a 0')

  const personName = valueOf(row, 'person')
  const person = personName ? findByName(catalogs.people, personName) : null
  if (personName && !person) issues.push(`No existe la persona «${personName}»`)
  const isDebt = target === ListImportTarget.RECEIVABLES || target === ListImportTarget.PAYABLES
  const personId = person?.id ?? (isDebt ? null : catalogs.defaultPersonId)
  if (!personId && !(personName && !person)) issues.push('Falta la persona')

  const methodName = valueOf(row, 'method')
  const method = methodName ? findByName(catalogs.paymentMethods, methodName) : null
  if (methodName && !method) issues.push(`No existe el medio de pago «${methodName}»`)

  const categoryName = valueOf(row, 'category')
  const category = categoryName ? findByName(catalogs.categories, categoryName) : null
  if (categoryName && !category) issues.push(`No existe la categoría «${categoryName}»`)

  const notes = valueOf(row, 'notes') || null
  const common = {
    description,
    amount,
    currency: currencyOf(valueOf(row, 'currency')),
    personId,
    notes,
  }

  let body: Record<string, unknown> | null = null
  switch (target) {
    case ListImportTarget.DAILY: {
      const spentAt = dateOf(valueOf(row, 'date'))
      if (!spentAt) issues.push('Falta la fecha (DD/MM/AAAA o AAAA-MM-DD)')
      if (!method) issues.push('Falta el medio de pago')
      body = { ...common, spentAt, paymentMethodId: method?.id, categoryId: category?.id ?? null }
      break
    }
    case ListImportTarget.PLATFORMS: {
      const period = paymentMonthOf(valueOf(row, 'month'))
      if (!period) issues.push('Falta el mes de pago (Octubre 2026, 10/2026 o 2026-10)')
      body = {
        ...common,
        paymentMonth: period?.month,
        paymentYear: period?.year,
        period: periodOf(valueOf(row, 'period')),
        kind: SubscriptionKind.PLATFORM,
        paymentMethodId: method?.id ?? null,
        categoryId: category?.id ?? null,
      }
      break
    }
    case ListImportTarget.RECURRING: {
      const day = Number(valueOf(row, 'day') || 1)
      if (!Number.isInteger(day) || day < 1 || day > 31) issues.push('El día de cobro va de 1 a 31')
      body = {
        ...common,
        targetType: RecurringTargetType.SUBSCRIPTION,
        kind: SubscriptionKind.SERVICE,
        period: periodOf(valueOf(row, 'period')),
        dayOfMonth: day,
        paymentMethodId: method?.id ?? null,
        categoryId: category?.id ?? null,
      }
      break
    }
    case ListImportTarget.RECEIVABLES:
    case ListImportTarget.PAYABLES: {
      const period = paymentMonthOf(valueOf(row, 'month'))
      if (!period) issues.push('Falta el mes de pago (Octubre 2026, 10/2026 o 2026-10)')
      const installmentText = valueOf(row, 'installment')
      const installment = installmentText ? installmentOf(installmentText) : null
      if (installmentText && !installment) issues.push('La cuota va como n/m (ej. 2/3)')
      body = {
        ...common,
        direction: target === ListImportTarget.RECEIVABLES ? DebtDirection.OWED_TO_ME : DebtDirection.I_OWE,
        paymentMonth: period?.month,
        paymentYear: period?.year,
        paymentMethodId: method?.id ?? null,
        installment,
      }
      break
    }
  }
  return { line: row.line, description, amount, issues, body: issues.length ? null : body }
}
