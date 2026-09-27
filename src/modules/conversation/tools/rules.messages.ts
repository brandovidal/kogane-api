import { escapeHtml } from '../conversation.messages'

// /reglas (P18, D129): what the bot learned from your corrections

export interface RuleRow {
  id: string
  merchant: string
  category: string | null
  method: string | null
}

export const RULES_TEXTS = {
  empty:
    '🧠 Todavía no aprendí reglas. Cuando corrijas la categoría o el medio de un gasto, lo recordaré para la próxima.',
  header: (count: number) =>
    `🧠 <b>Reglas aprendidas</b> (${count}). Se aplican solas al registrar; borra las que ya no sirvan.`,
  removed: 'Regla borrada',
  gone: 'Esa regla ya no existe',
}

export const formatRules = (rules: RuleRow[]): string =>
  [
    RULES_TEXTS.header(rules.length),
    ...rules.map(
      (rule) =>
        `• <b>${escapeHtml(rule.merchant)}</b> → ${
          [rule.category, rule.method]
            .filter(Boolean)
            .map((name) => escapeHtml(name!))
            .join(' · ') || '—'
        }`,
    ),
  ].join('\n')
