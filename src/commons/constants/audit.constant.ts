// Historial de cambios (P29, D103, D122)

// Who was writing (aud_context.source). `import` makes the triggers skip: an import leaves a single event
export enum AuditSource {
  WEB = 'web',
  BOT = 'bot',
  IMPORT = 'import',
  SCHEDULER = 'scheduler',
  CLI = 'cli',
}

export enum AuditAction {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  RESTORE = 'restore', // reserved: undo is out of scope for now
}

// The tables the triggers watch: expenses, debts, budget, catalogs, settings and commitments. Not audited: what is a
// record in itself (drafts, notifications, AI logs, imp_*) and the files
export const AUDITED_TABLES = [
  'exp_daily_expenses',
  'exp_fixed_costs',
  'exp_subscriptions',
  'exp_credit_card_expenses',
  'exp_recurring_expenses',
  'exp_debts',
  'exp_debt_payments',
  'exp_commitments',
  'exp_contributions',
  'exp_person_summaries',
  'bud_monthly_budgets',
  'bud_budget_groups',
  'bud_category_budgets',
  'bud_incomes',
  'bud_settings',
  'cat_people',
  'cat_payment_methods',
  'cat_card_holders',
  'cat_categories',
  'ntf_settings',
] as const

// The tables whose primary key is not "id" (the entityId of their events)
export const AUDIT_ID_COLUMN: Record<string, string> = { ntf_settings: 'kind' }

// Recorded as "changed", never in the clear (D94): the value is replaced by MASKED_VALUE (null stays null)
export const SENSITIVE_COLUMNS: Record<string, string[]> = {
  cat_people: ['documentNumber'],
  cat_payment_methods: ['statementPassword'],
}
export const MASKED_VALUE = '•••'

// Touched by every update: not a change by itself
export const UNTRACKED_COLUMNS = ['updatedAt']

// What names a row in the lists of the history (a table without one shows its id)
export const AUDIT_TITLE_COLUMN: Record<string, string> = {
  exp_daily_expenses: 'description',
  exp_fixed_costs: 'description',
  exp_subscriptions: 'description',
  exp_credit_card_expenses: 'description',
  exp_recurring_expenses: 'description',
  exp_debts: 'description',
  exp_commitments: 'name',
  bud_budget_groups: 'name',
  bud_incomes: 'description',
  cat_people: 'name',
  cat_payment_methods: 'name',
  cat_categories: 'name',
}

export const HISTORY_PAGE_SIZE = 30
