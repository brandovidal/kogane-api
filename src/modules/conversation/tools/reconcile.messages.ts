import { escapeHtml, formatAmount, MONTH_NAMES } from '../conversation.messages'

// /cuadre (P18): the last statement of a card against what Kogane has registered for its month

export interface ReconcileSummary {
  card: string
  month: number
  year: number
  currency: string
  totalDue: number | null
  registered: number
  newRows: number // in the statement and not in Kogane
  missing: { description: string; amount: number }[] // in Kogane and not in the statement
}

const MAX_LINES = 5
const label = (month: number, year: number) => `${MONTH_NAMES[month - 1]} ${year}`

export const RECONCILE_TEXTS = {
  askCard: (cards: string[]) =>
    `✅ ¿Qué tarjeta cuadro? Escribe el nombre${cards.length ? ` (${cards.map(escapeHtml).join(' · ')})` : ''}.`,
  unknownCard: (text: string) =>
    `No encontré la tarjeta «${escapeHtml(text)}». Prueba con el nombre como la tienes en Kogane.`,
  noStatement: (card: string) =>
    `📄 ${escapeHtml(card)} no tiene estados de cuenta cargados. Súbelo en la web (Reconocimiento ▸ Estados de cuenta) y vuelve a pedirlo.`,
  noCards: '📄 Todavía no hay estados de cuenta cargados. Súbelos en la web (Reconocimiento ▸ Estados de cuenta).',
}

export function formatReconcile(summary: ReconcileSummary): string {
  const { card, month, year, currency, totalDue, registered, newRows, missing } = summary
  const header = `✅ <b>Cuadre · ${escapeHtml(card)}</b> · ${label(month, year)}`
  if (totalDue == null)
    return `${header}\nEl estado no trae el total a pagar. Kogane tiene registrado ${formatAmount(registered, currency)}.`

  const difference = Math.round((totalDue - registered) * 100) / 100
  const balanced = difference === 0 && newRows === 0 && !missing.length
  const shown = missing.slice(0, MAX_LINES)
  return [
    header,
    `Estado: <b>${formatAmount(totalDue, currency)}</b> · Kogane: <b>${formatAmount(registered, currency)}</b>`,
    balanced
      ? 'Todo cuadra ✅'
      : difference === 0
        ? 'El total coincide, pero revisa los movimientos.'
        : `Diferencia: <b>${formatAmount(Math.abs(difference), currency)}</b> ${difference > 0 ? 'que Kogane no tiene' : 'de más en Kogane'}`,
    ...(newRows
      ? [`• ${newRows} ${newRows === 1 ? 'movimiento' : 'movimientos'} del estado sin registrar (créalos en la web)`]
      : []),
    ...(missing.length
      ? [
          `• En Kogane y no en el estado:`,
          ...shown.map(
            (expense) => `   – ${escapeHtml(expense.description)} · ${formatAmount(expense.amount, currency)}`,
          ),
          ...(missing.length > shown.length ? [`   … y ${missing.length - shown.length} más`] : []),
        ]
      : []),
  ].join('\n')
}
