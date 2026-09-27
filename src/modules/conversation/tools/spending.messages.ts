import { escapeHtml, formatAmount, MONTH_NAMES } from '../conversation.messages'

// /hoy, /semana and /tarjetas (P18): read-only texts. Your part of each expense (D73) in soles; a card shows what the
// bank charges

export interface SpendingRow {
  description: string
  amount: number
  currency: string
  own: number // your part in soles
  date: string // YYYY-MM-DD
  method: string | null
  category: string | null
}

const pen = (amount: number) => formatAmount(amount, 'PEN')
const sum = (rows: SpendingRow[]) => Math.round(rows.reduce((total, row) => total + row.own, 0) * 100) / 100

const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']
const dayLabel = (iso: string) => {
  const [year, month, day] = iso.split('-')
  return `${WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()]} ${day}/${month}` + (year ? '' : '')
}

const line = (row: SpendingRow) =>
  `• ${escapeHtml(row.description)} — ${formatAmount(row.amount, row.currency)}${row.method ? ` · ${escapeHtml(row.method)}` : ''}`

const MAX_LINES = 15

export function formatToday(rows: SpendingRow[], today: string): string {
  if (!rows.length) return `📅 <b>Hoy · ${dayLabel(today)}</b>\nNo registraste gastos.`
  const shown = rows.slice(0, MAX_LINES)
  const rest = rows.length - shown.length
  return [
    `📅 <b>Hoy · ${dayLabel(today)}</b>`,
    ...shown.map(line),
    ...(rest > 0 ? [`… y ${rest} más`] : []),
    `Total: <b>${pen(sum(rows))}</b> (tu parte)`,
  ].join('\n')
}

// The last 7 days: by day and by category
export function formatWeek(rows: SpendingRow[], from: string, to: string): string {
  const header = `🗓️ <b>Últimos 7 días</b> · ${dayLabel(from)} al ${dayLabel(to)}`
  if (!rows.length) return `${header}\nNo registraste gastos.`

  const days = new Map<string, SpendingRow[]>()
  for (const row of rows) days.set(row.date, [...(days.get(row.date) ?? []), row])
  const byDay = [...days]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => `• ${dayLabel(date)}: ${pen(sum(list))}`)

  const categories = new Map<string, SpendingRow[]>()
  for (const row of rows)
    categories.set(row.category ?? 'Sin categoría', [...(categories.get(row.category ?? 'Sin categoría') ?? []), row])
  const byCategory = [...categories]
    .map(([name, list]) => ({ name, total: sum(list) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5)
    .map(({ name, total }) => `• ${escapeHtml(name)}: ${pen(total)}`)

  return [
    header,
    '<b>Por día</b>',
    ...byDay,
    '<b>Por categoría</b>',
    ...byCategory,
    `Total: <b>${pen(sum(rows))}</b> (tu parte)`,
  ].join('\n')
}

export interface CardCycleRow {
  name: string
  total: number
  installments: number
  closeDate: string // YYYY-MM-DD
  dueDate: string
}

const shortDate = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7)

// The cycle each card is in: what its next statement will charge, split in installments and not
export function formatCards(cards: CardCycleRow[]): string {
  if (!cards.length)
    return '💳 No hay tarjetas de crédito con cierre y pago configurados. Agrégalas en la web (Configuración ▸ Cuentas y tarjetas).'
  const total = Math.round(cards.reduce((sum, card) => sum + card.total, 0) * 100) / 100
  return [
    '💳 <b>Tarjetas · ciclo actual</b>',
    ...cards.map(
      (card) =>
        `• <b>${escapeHtml(card.name)}</b>: ${pen(card.total)}` +
        (card.installments
          ? ` (en cuotas ${pen(card.installments)} · sin cuotas ${pen(Math.round((card.total - card.installments) * 100) / 100)})`
          : '') +
        `\n  cierra ${shortDate(card.closeDate)} · paga ${shortDate(card.dueDate)}`,
    ),
    ...(cards.length > 1 ? [`Total de las tarjetas: <b>${pen(total)}</b>`] : []),
  ].join('\n')
}

// "/exportar" and "/grafico" take a month like /presupuesto: alone is this one
export const monthUsage = (emoji: string, command: string) =>
  `${emoji} Dime el mes: <i>/${command}</i> (este mes), <i>/${command} agosto</i> o <i>/${command} 8 2026</i>.`
export const monthLabel = (month: number, year: number) => `${MONTH_NAMES[month - 1]} ${year}`

export const EXPORT_TEXTS = {
  usage: monthUsage('📥', 'exportar'),
  choose: (label: string, count: number) =>
    `📥 <b>Gastos de ${label}</b> · ${count} ${count === 1 ? 'movimiento' : 'movimientos'} (tu parte). ¿En qué formato?`,
  empty: (label: string) => `📥 No hay gastos registrados en ${label}.`,
  sent: 'Archivo enviado',
}
