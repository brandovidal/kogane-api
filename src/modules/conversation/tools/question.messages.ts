import { escapeHtml, formatAmount, MONTH_NAMES } from '../conversation.messages'
import { QuestionQuery } from './question.prompt'
import { SpendingRow } from './spending.messages'

export interface QuestionPeriod {
  month: number
  year: number
}

export const QUESTION_TEXTS = {
  ask: '❓ Pregúntame por tus gastos: <i>¿cuánto gasté en comida en agosto?</i> · <i>¿en qué gasté más este mes?</i> · <i>¿cuál fue mi gasto más grande?</i>',
  failed: '⚠️ No pude entender la pregunta ahora. Prueba otra vez en un rato o usa /consultar.',
  unknown:
    '🤔 Solo puedo responder sobre tus gastos: totales, en qué gastas más, el gasto más grande o cómo vas frente al mes anterior.',
  unknownFilter: (kind: string, name: string) => `No conozco ${kind} «${escapeHtml(name)}» en tu catálogo.`,
}

const pen = (amount: number) => formatAmount(amount, 'PEN')
const sum = (rows: SpendingRow[]) => Math.round(rows.reduce((total, row) => total + row.own, 0) * 100) / 100
const label = ({ month, year }: QuestionPeriod) => `${MONTH_NAMES[month - 1]} ${year}`
const count = (rows: SpendingRow[]) => `${rows.length} ${rows.length === 1 ? 'movimiento' : 'movimientos'}`

// "en Comida · con Yape · «uber»"
export const describeFilters = (query: Pick<QuestionQuery, 'text'>, category: string | null, method: string | null) =>
  [
    category ? `en ${escapeHtml(category)}` : null,
    method ? `con ${escapeHtml(method)}` : null,
    query.text ? `«${escapeHtml(query.text)}»` : null,
  ]
    .filter(Boolean)
    .join(' · ')

const GROUP_LABELS = { category: 'categoría', method: 'medio de pago', day: 'día' } as const
const groupKey = (row: SpendingRow, by: keyof typeof GROUP_LABELS) =>
  by === 'category' ? (row.category ?? 'Sin categoría') : by === 'method' ? (row.method ?? 'Sin medio') : row.date

// The answer, computed from the rows (already filtered). Your part in soles (D73)
export function answerQuestion(
  query: QuestionQuery,
  period: QuestionPeriod,
  rows: SpendingRow[],
  previousPeriod: QuestionPeriod,
  previousRows: SpendingRow[],
  filters: string,
): string {
  const header = `💬 <b>${label(period)}</b>${filters ? ` · ${filters}` : ''}`
  if (!rows.length && query.kind !== 'compare') return `${header}\nNo encontré gastos.`

  switch (query.kind) {
    case 'top': {
      const by = query.groupBy ?? 'category'
      const groups = new Map<string, SpendingRow[]>()
      for (const row of rows) groups.set(groupKey(row, by), [...(groups.get(groupKey(row, by)) ?? []), row])
      const lines = [...groups]
        .map(([name, list]) => ({ name, total: sum(list) }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 5)
        .map(({ name, total }, index) => `${index + 1}. ${escapeHtml(name)}: ${pen(total)}`)
      return [header, `Por ${GROUP_LABELS[by]}:`, ...lines, `Total: <b>${pen(sum(rows))}</b>`].join('\n')
    }
    case 'biggest': {
      const lines = [...rows]
        .sort((a, b) => b.own - a.own)
        .slice(0, 3)
        .map(
          (row) =>
            `• ${escapeHtml(row.description)} — <b>${pen(row.own)}</b> · ${row.date.slice(8, 10)}/${row.date.slice(5, 7)}`,
        )
      return [header, 'Los más grandes:', ...lines].join('\n')
    }
    case 'compare': {
      const now = sum(rows)
      const before = sum(previousRows)
      const diff = Math.round((now - before) * 100) / 100
      const trend =
        diff === 0
          ? 'igual'
          : `${diff > 0 ? '⬆️ ' : '⬇️ '}${pen(Math.abs(diff))}${before ? ` (${Math.round((Math.abs(diff) / before) * 100)} %)` : ''}`
      return [
        header,
        `${label(period)}: <b>${pen(now)}</b>`,
        `${label(previousPeriod)}: <b>${pen(before)}</b>`,
        `Diferencia: ${trend}`,
      ].join('\n')
    }
    default:
      return [header, `Gastaste <b>${pen(sum(rows))}</b> en ${count(rows)} (tu parte).`].join('\n')
  }
}
