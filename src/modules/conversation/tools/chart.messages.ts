import { escapeHtml, formatAmount, MONTH_NAMES } from '../conversation.messages'
import { CHART_COLORS } from './chart.helper'

// /grafico (P18, D130): the caption of the donut, which is also its legend

export interface ChartCategory {
  name: string
  total: number
}

export const CHART_TEXTS = {
  empty: (label: string) => `📈 No hay gastos registrados en ${label}.`,
}

const MAX_SLICES = CHART_COLORS.length
const pen = (amount: number) => formatAmount(amount, 'PEN')

// The biggest categories, and the rest together as the last slice (grey)
export function toSlices(categories: ChartCategory[]): ChartCategory[] {
  const sorted = [...categories].filter((category) => category.total > 0).sort((a, b) => b.total - a.total)
  if (sorted.length <= MAX_SLICES) return sorted
  const rest = sorted.slice(MAX_SLICES - 1)
  return [
    ...sorted.slice(0, MAX_SLICES - 1),
    { name: 'Otras', total: Math.round(rest.reduce((sum, category) => sum + category.total, 0) * 100) / 100 },
  ]
}

export function chartCaption(month: number, year: number, slices: ChartCategory[]): string {
  const total = slices.reduce((sum, slice) => sum + slice.total, 0)
  return [
    `📈 <b>Gastos de ${MONTH_NAMES[month - 1]} ${year}</b> · <b>${pen(total)}</b> (tu parte)`,
    ...slices.map(
      (slice, index) =>
        `${CHART_COLORS[index].emoji} ${escapeHtml(slice.name)}: ${pen(slice.total)} · ${Math.round((slice.total / total) * 100)} %`,
    ),
  ].join('\n')
}
