import { escapeHtml, formatAmount } from '../conversation.messages'

// /viaje and /fin (P18): the messages of a trip, in Spanish

export interface TripSummary {
  name: string
  startedAt: Date
  endedAt: Date | null
  total: number
  count: number
  byCategory: { name: string; total: number }[]
}

const DAY_MS = 24 * 60 * 60_000
// Calendar days the trip covers, counting the first and the last
export const tripDays = (startedAt: Date, endedAt: Date | null): number =>
  Math.max(1, Math.ceil(((endedAt ?? new Date()).getTime() - startedAt.getTime()) / DAY_MS))

const breakdown = (summary: TripSummary) =>
  summary.byCategory.length
    ? summary.byCategory
        .sort((a, b) => b.total - a.total)
        .slice(0, 6)
        .map((category) => `• ${escapeHtml(category.name)}: ${formatAmount(category.total, 'PEN')}`)
    : []

export const TRIP_TEXTS = {
  askName: '✈️ ¿Cómo se llama el viaje? Escribe el nombre (por ejemplo <i>Lima</i> o <i>Cusco 2026</i>).',
  started: (name: string, previous: string | null) =>
    `✈️ Viaje <b>${escapeHtml(name)}</b> abierto. Todo lo que guardes (día a día y tarjeta) queda etiquetado hasta /fin.${previous ? `\n(Cerré «${escapeHtml(previous)}».)` : ''}`,
  none: '🏁 No hay un viaje abierto. Empieza uno con <i>/viaje Lima</i>.',
  open: (summary: TripSummary) =>
    [
      `✈️ Viaje abierto: <b>${escapeHtml(summary.name)}</b> · ${tripDays(summary.startedAt, null)} ${tripDays(summary.startedAt, null) === 1 ? 'día' : 'días'}`,
      `Llevas ${summary.count} ${summary.count === 1 ? 'gasto' : 'gastos'}: <b>${formatAmount(summary.total, 'PEN')}</b> (tu parte).`,
      ...breakdown(summary),
    ].join('\n'),
  closed: (summary: TripSummary) => {
    const days = tripDays(summary.startedAt, summary.endedAt)
    return [
      `🏁 Viaje <b>${escapeHtml(summary.name)}</b> cerrado · ${days} ${days === 1 ? 'día' : 'días'}`,
      summary.count
        ? `${summary.count} ${summary.count === 1 ? 'gasto' : 'gastos'}: <b>${formatAmount(summary.total, 'PEN')}</b> (tu parte).`
        : 'No guardaste gastos durante el viaje.',
      ...breakdown(summary),
    ].join('\n')
  },
  label: (name: string) => `✈️ ${escapeHtml(name)}`,
}
