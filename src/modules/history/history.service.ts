import { Injectable } from '@nestjs/common'

import { AuditChange } from '@/generated/prisma/client'
import {
  AUDIT_ID_COLUMN,
  AUDIT_TITLE_COLUMN,
  AuditAction,
  AuditSource,
  HISTORY_PAGE_SIZE,
} from '@/commons/constants/audit.constant'
import { AuditChangeDBRepository } from '@/db/models/audit/auditChangeDB.repository'

import { HistoryQueryDto } from './dto/request/history.dto'

const MODULE_ENTITIES = {
  expenses: [
    'exp_daily_expenses',
    'exp_fixed_costs',
    'exp_subscriptions',
    'exp_credit_card_expenses',
    'exp_recurring_expenses',
    'exp_payments',
  ],
  debts: ['exp_debts', 'exp_debt_payments'],
  commitments: ['exp_commitments', 'exp_contributions'],
  budget: ['bud_monthly_budgets', 'bud_budget_groups', 'bud_category_budgets', 'bud_incomes', 'bud_settings'],
  settings: ['cat_people', 'cat_payment_methods', 'cat_accounts', 'cat_card_holders', 'cat_categories', 'ntf_settings'],
  imports: ['imp_batches', 'imp_statements'],
} as const

type Fields = { field: string; before: unknown; after: unknown }[]

// Which catalog names each id column of a change points to
const LABELS = {
  personId: 'person',
  categoryId: 'category',
  paymentMethodId: 'paymentMethod',
  budgetGroupId: 'budgetGroup',
  commitmentId: 'commitment',
  accountId: 'account',
} as const

// Historial de cambios (P29): what the triggers wrote, read as a list or as the timeline of one record
@Injectable()
export class HistoryService {
  constructor(private readonly auditChangeDBRepository: AuditChangeDBRepository) {}

  async list(query: HistoryQueryDto) {
    const { rows, total } = await this.auditChangeDBRepository.findPage(
      {
        entity: query.entity,
        entities: query.module ? [...MODULE_ENTITIES[query.module]] : undefined,
        entityId: query.id,
        source: query.source,
        from: query.from,
        to: query.to,
      },
      query.page,
      HISTORY_PAGE_SIZE,
    )
    const parsed = rows.map((row) => ({ row, changes: this.fieldsOf(row) }))
    const [titles, labels] = await Promise.all([
      this.titlesOf(parsed),
      this.labelsOf(parsed.flatMap((item) => item.changes)),
    ])

    return {
      items: parsed.map(({ row, changes }) => ({
        id: row.id,
        entity: row.entity,
        entityId: row.entityId,
        action: row.action as AuditAction,
        source: row.source as AuditSource,
        actorId: row.actorId,
        batchId: row.batchId,
        createdAt: row.createdAt,
        title: titles.get(`${row.entity}:${row.entityId}`) ?? this.snapshotTitle(row, changes),
        changes,
      })),
      total,
      page: query.page,
      pageSize: HISTORY_PAGE_SIZE,
      labels,
    }
  }

  // Timeline of one record, newest first
  timeline(entity: string, id: string, page = 1) {
    return this.list({ entity, id, page })
  }

  // {field: [before, after]} for an update, {field: value} for a create or a delete (or a summary: an import)
  private fieldsOf(row: AuditChange): Fields {
    let data: Record<string, unknown>
    try {
      data = JSON.parse(row.changes) as Record<string, unknown>
    } catch {
      return []
    }
    return Object.entries(data).map(([field, value]) => {
      if (row.action === AuditAction.UPDATE && Array.isArray(value))
        return { field, before: value[0] ?? null, after: value[1] ?? null }
      if (row.action === AuditAction.DELETE) return { field, before: value ?? null, after: null }
      return { field, before: null, after: value ?? null }
    })
  }

  // A row that was deleted keeps its name in the change; one that exists is asked for
  private snapshotTitle(row: AuditChange, changes: Fields): string | null {
    const column = AUDIT_TITLE_COLUMN[row.entity]
    const value = column ? changes.find((change) => change.field === column) : undefined
    const title = value ? (row.action === AuditAction.DELETE ? value.before : value.after) : null
    return typeof title === 'string' ? title : null
  }

  private async titlesOf(parsed: { row: AuditChange }[]): Promise<Map<string, string>> {
    const idsByTable = new Map<string, Set<string>>()
    for (const { row } of parsed) {
      if (!AUDIT_TITLE_COLUMN[row.entity]) continue
      idsByTable.set(row.entity, (idsByTable.get(row.entity) ?? new Set()).add(row.entityId))
    }
    const titles = new Map<string, string>()
    for (const [table, ids] of idsByTable) {
      const rows = await this.auditChangeDBRepository.titlesOf(
        table,
        AUDIT_TITLE_COLUMN[table],
        AUDIT_ID_COLUMN[table] ?? 'id',
        [...ids],
      )
      rows.forEach((row) => row.title && titles.set(`${table}:${row.id}`, row.title))
    }
    return titles
  }

  private async labelsOf(changes: Fields): Promise<Record<string, string>> {
    const idsByModel = new Map<(typeof LABELS)[keyof typeof LABELS], Set<string>>()
    for (const change of changes) {
      const model = LABELS[change.field as keyof typeof LABELS]
      if (!model) continue
      for (const value of [change.before, change.after]) {
        if (typeof value === 'string') idsByModel.set(model, (idsByModel.get(model) ?? new Set()).add(value))
      }
    }
    const labels: Record<string, string> = {}
    for (const [model, ids] of idsByModel) {
      for (const row of await this.auditChangeDBRepository.namesOf(model, [...ids])) labels[row.id] = row.name
    }
    return labels
  }
}
