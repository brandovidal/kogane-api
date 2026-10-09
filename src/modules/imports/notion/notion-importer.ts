import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { PrismaService } from '@/db/prisma/prisma.service'
import { runAsImport } from '@/db/audit/audit-context'
import { requireUserId } from '@/db/tenant/tenant-context'
import { AuditAction } from '@/commons/constants/audit.constant'
import { DebtDBRepository } from '@/db/models/debt/debtDB.repository'
import { Currency } from '@/commons/constants/expense.constant'
import { toCents } from '@/commons/constants/debt.constant'
import { ImportBatchStatus, ImportRowKind, ImportRowStatus } from '@/commons/constants/import.constant'
import { ImportNotPreviewException } from '@/commons/exceptions/import/import-not-preview.exception'
import { MONTH_NAMES } from '@/modules/conversation/conversation.messages'
import { buildExtractionCatalog, normalizeText } from '@/modules/expense-extraction/expense-extraction.catalog'
import { PersonDbDto } from '@/db/models/person/personDB.dto'
import { PaymentMethodDbDto } from '@/db/models/payment-method/paymentMethodDB.dto'
import { convertRow, MovableTable } from '@/commons/helpers/expense-move.helper'

import { parseCsv } from './notion-csv'
import {
  BaseFile,
  detectBase,
  ExpenseImport,
  GroupImport,
  ImportIssue,
  ImportTable,
  mapRow,
  MapContext,
  MonthlyBudgetImport,
  NotionBase,
} from './notion.mapper'

export interface MonthTotal {
  month: number
  year: number
  spent: number // PEN, fixed costs + cards of the payment month, everyone's (D46: no platforms)
  salary: number | null
  surplus: number | null // salary − spent (D65)
  linked: number // fixed costs + cards linked to the Resumen page of the month, as Notion adds them (any currency)
  notionSpent: number | null // "Gastos" of that Resumen page: equal to linked when every row came through
}

export interface NotionFile {
  name: string // file name (the folder inside a ZIP does not matter)
  content: string
}

export interface ImportPlan {
  source: string // folder or uploaded file names
  files: { file: string; base: BaseFile | null; rows: number }[]
  expenses: PlannedExpense[]
  groups: (GroupImport & PlannedSource)[]
  budgets: (MonthlyBudgetImport & PlannedSource)[]
  issues: (ImportIssue & { raw: string })[]
  months: MonthTotal[]
}

interface PlannedSource {
  file: string
  line: number
  raw: string // JSON of the CSV row, kept in imp_rows
}

export type PlannedExpense = ExpenseImport & {
  importKey: string
  status: ImportRowStatus.NEW | ImportRowStatus.CHANGED | ImportRowStatus.UNCHANGED
  targetId: string | null // the Kogane row it updates, or the id it will be created with
  currentTable?: ImportTable // where that row lives now, when "Pasar a…" moved it (D106)
  base: NotionBase
  destination: string // "Tarjetas ▸ IO · Setiembre 2026"
  raw: string
}

export interface ApplyResult {
  batchId: string
  created: number
  updated: number
  unchanged: number
  payments: number
  groups: number
  budgets: number
}

const TABLES: ImportTable[] = ['creditCardExpense', 'fixedCost', 'subscription', 'debt']
const CHUNK = 200

type Delegate = {
  findMany(args: unknown): Promise<{ id: string; importKey: string | null }[]>
  createMany(args: unknown): Promise<{ count: number }>
  update(args: unknown): Promise<{ id: string }>
  deleteMany(args: unknown): Promise<{ count: number }>
}

const hash = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 20)
const monthLabel = (month: number, year: number) =>
  `${MONTH_NAMES[month - 1].charAt(0).toUpperCase()}${MONTH_NAMES[month - 1].slice(1)} ${year}`

// Notion exports each board twice: "X.csv" (the current view, filtered) and "X_all.csv" (every row); keep the full one
export function pickFullExports(files: NotionFile[]): NotionFile[] {
  const csv = files
    .map((file) => ({ ...file, name: basename(file.name) }))
    .filter((file) => file.name.toLowerCase().endsWith('.csv'))
  const full = new Set(
    csv.filter((file) => /_all\.csv$/i.test(file.name)).map((file) => file.name.replace(/_all\.csv$/i, '.csv')),
  )
  return csv.filter((file) => !full.has(file.name)).sort((a, b) => a.name.localeCompare(b.name))
}

export async function readNotionDir(dir: string): Promise<NotionFile[]> {
  const names = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith('.csv'))
  return Promise.all(names.map(async (name) => ({ name, content: await readFile(join(dir, name), 'utf8') })))
}

// Notion → Kogane once in production, many times in dev (P14, D90, D104). Every row carries an importKey (a
// fingerprint of the row plus its occurrence), so importing again updates instead of duplicating. An import is first a
// preview (imp_batches + imp_rows, nothing written in the expenses) and is applied or discarded from the web; RESET
// deletes only what came from Notion.
export class NotionImporter {
  private readonly debts: DebtDBRepository

  constructor(private readonly prisma: PrismaService) {
    this.debts = new DebtDBRepository(prisma)
  }

  async plan(files: NotionFile[], source: string): Promise<ImportPlan> {
    const context = await this.context()
    const plan: ImportPlan = { source, files: [], expenses: [], groups: [], budgets: [], issues: [], months: [] }
    const occurrences = new Map<string, number>()

    for (const { name: file, content } of pickFullExports(files)) {
      const { headers, rows } = parseCsv(content)
      const base = detectBase(file, headers)
      plan.files.push({ file, base, rows: rows.length })
      if (!base) {
        // Other pages of the export ("Pago de Prestamos", "Pago de Terreno": P27) are left out
        plan.issues.push({
          file,
          line: 1,
          message: 'no es una de las 9 bases de Seguimiento financiero: se ignora',
          blocking: false,
          raw: '{}',
        })
        continue
      }
      for (const row of rows) {
        const raw = JSON.stringify(row.values)
        for (const mapped of mapRow(base, file, row, context.map)) {
          if (mapped.kind === 'issue') plan.issues.push({ ...mapped.value, raw })
          if (mapped.kind === 'group') plan.groups.push({ ...mapped.value, file, line: row.line, raw })
          if (mapped.kind === 'budget') plan.budgets.push({ ...mapped.value, file, line: row.line, raw })
          if (mapped.kind === 'expense') {
            const occurrence = (occurrences.get(mapped.value.fingerprint) ?? 0) + 1
            occurrences.set(mapped.value.fingerprint, occurrence)
            plan.expenses.push({
              ...mapped.value,
              importKey: `notion:${hash(mapped.value.fingerprint)}#${occurrence}`,
              status: ImportRowStatus.NEW,
              targetId: null,
              base: base.base,
              destination: `${this.target(mapped.value, base, context.names)} · ${monthLabel(mapped.value.month, mapped.value.year)}`,
              raw,
            })
          }
        }
      }
    }

    await this.compare(plan.expenses)
    plan.months = monthTotals(plan.expenses, plan.budgets)
    return plan
  }

  // Saves the plan as a preview: every row with where it goes; nothing is written in the expenses
  async preview(plan: ImportPlan): Promise<string> {
    const count = (status: ImportRowStatus) => plan.expenses.filter((expense) => expense.status === status).length
    const batch = await this.prisma.importBatch.create({
      data: {
        sourceDir: plan.source,
        status: ImportBatchStatus.PREVIEW,
        files: plan.files.length,
        created: count(ImportRowStatus.NEW),
        updated: count(ImportRowStatus.CHANGED),
        unchanged: count(ImportRowStatus.UNCHANGED),
        summary: JSON.stringify({
          files: plan.files.map(({ file, base, rows }) => ({ file, base: baseLabel(base), rows })),
          months: plan.months,
        }),
      },
    })
    const rows = [
      ...plan.expenses.map((expense) => ({
        importKey: expense.importKey,
        kind: ImportRowKind.EXPENSE,
        status: expense.status,
        file: expense.file,
        line: expense.line,
        base: expense.base,
        targetTable: expense.table,
        targetId: expense.targetId,
        destination: expense.destination,
        description: String(expense.data.description ?? ''),
        amount: expense.amount,
        currency: expense.currency,
        month: expense.month,
        year: expense.year,
        data: JSON.stringify(expense.data),
        paidAt: expense.paidInFull?.paidAt ?? null,
        raw: expense.raw,
      })),
      ...plan.groups.map((group) => ({
        kind: ImportRowKind.GROUP,
        file: group.file,
        line: group.line,
        base: NotionBase.BUDGET_GROUP,
        targetTable: 'budgetGroup',
        destination: 'Presupuesto ▸ Grupos',
        description: group.name,
        amount: group.percentage,
        data: JSON.stringify({ name: group.name, percentage: group.percentage }),
        raw: group.raw,
      })),
      ...plan.budgets.map((budget) => ({
        kind: ImportRowKind.BUDGET,
        file: budget.file,
        line: budget.line,
        base: NotionBase.SUMMARY,
        targetTable: 'monthlyBudget',
        destination: `Presupuesto ▸ Sueldo · ${monthLabel(budget.month, budget.year)}`,
        description: `Sueldo ${monthLabel(budget.month, budget.year)} (${budget.limitPercent} %)`,
        amount: budget.salary,
        currency: Currency.PEN,
        month: budget.month,
        year: budget.year,
        data: JSON.stringify({
          month: budget.month,
          year: budget.year,
          salary: budget.salary,
          limitPercent: budget.limitPercent,
        }),
        raw: budget.raw,
      })),
      ...plan.issues.map((issue) => ({
        kind: ImportRowKind.ISSUE,
        status: issue.blocking ? ImportRowStatus.BLOCKED : ImportRowStatus.WARNING,
        message: issue.message,
        file: issue.file,
        line: issue.line,
        raw: issue.raw,
      })),
    ]
    for (let start = 0; start < rows.length; start += CHUNK * 5) {
      await this.prisma.importRow.createMany({
        data: rows.slice(start, start + CHUNK * 5).map((row) => ({ ...row, batchId: batch.id })),
      })
    }
    return batch.id
  }

  // Writes a preview: new rows in chunks, changed ones one by one, unchanged ones untouched (the status is checked
  // again, another import may have been applied since the preview); then the groups, the salaries and the payments
  // of the debts paid in Notion (only once)
  async apply(batchId: string, onProgress?: (done: number, total: number) => void): Promise<ApplyResult> {
    // The history gets one event for the whole import, not a row per record (P29, D103)
    return runAsImport(this.prisma, { entity: 'imp_batches', entityId: batchId, action: AuditAction.CREATE }, () =>
      this.applyBatch(batchId, onProgress),
    )
  }

  private async applyBatch(batchId: string, onProgress?: (done: number, total: number) => void): Promise<ApplyResult> {
    const batch = await this.prisma.importBatch.findUnique({ where: { id: batchId } })
    if (!batch || batch.status !== ImportBatchStatus.PREVIEW) {
      throw new ImportNotPreviewException({ batchId, status: batch?.status ?? null })
    }
    const rows = await this.prisma.importRow.findMany({
      where: { batchId, kind: { not: ImportRowKind.ISSUE } },
      orderBy: [{ file: 'asc' }, { line: 'asc' }],
    })
    const expenses = rows
      .filter((row) => row.kind === ImportRowKind.EXPENSE)
      .map((row) => ({
        id: row.id,
        importKey: row.importKey!,
        table: row.targetTable as ImportTable,
        data: JSON.parse(row.data) as Record<string, unknown>,
        paidAt: row.paidAt,
        raw: row.raw,
        status: ImportRowStatus.NEW as PlannedExpense['status'],
        targetId: null as string | null,
        previewStatus: row.status,
        previewTargetId: row.targetId,
        currentTable: undefined as ImportTable | undefined,
      }))
    await this.compare(expenses)

    const result: ApplyResult = {
      batchId,
      created: 0,
      updated: 0,
      unchanged: expenses.filter((expense) => expense.status === ImportRowStatus.UNCHANGED).length,
      payments: 0,
      groups: 0,
      budgets: 0,
    }
    const pending = expenses.filter((expense) => expense.status !== ImportRowStatus.UNCHANGED)
    let done = 0

    // New rows in chunks with the ids chosen here, so imp_rows points to them without reading them back
    for (const table of TABLES) {
      const fresh = pending.filter((expense) => expense.status === ImportRowStatus.NEW && expense.table === table)
      for (let start = 0; start < fresh.length; start += CHUNK) {
        const chunk = fresh.slice(start, start + CHUNK)
        chunk.forEach((expense) => (expense.targetId = randomUUID()))
        await this.delegate(table).createMany({
          data: chunk.map((expense) => ({ ...expense.data, id: expense.targetId, importKey: expense.importKey })),
        })
        for (const expense of chunk) {
          if (expense.paidAt && (await this.payOnce(expense.targetId!, expense.paidAt))) result.payments++
        }
        result.created += chunk.length
        onProgress?.((done += chunk.length), pending.length)
      }
    }

    // Rows that changed in Notion, one by one (few after the first import)
    for (const expense of pending.filter((candidate) => candidate.status === ImportRowStatus.CHANGED)) {
      const table = expense.currentTable ?? expense.table
      const data =
        table === expense.table
          ? expense.data
          : convertRow(expense.data, expense.table as MovableTable, table as MovableTable)
      await this.delegate(table).update({ where: { id: expense.targetId }, data })
      if (expense.paidAt && (await this.payOnce(expense.targetId!, expense.paidAt))) result.payments++
      result.updated++
      onProgress?.(++done, pending.length)
    }

    // imp_rows keeps what each row finally was and the Kogane row it points to
    for (const expense of expenses) {
      if (expense.status !== expense.previewStatus || expense.targetId !== expense.previewTargetId) {
        await this.prisma.importRow.update({
          where: { id: expense.id },
          data: { status: expense.status, targetId: expense.targetId },
        })
      }
    }

    const groups = await this.prisma.budgetGroup.findMany()
    for (const row of rows.filter((candidate) => candidate.kind === ImportRowKind.GROUP)) {
      const group = JSON.parse(row.data) as GroupImport
      const match = groups.find((candidate) => normalizeText(candidate.name) === normalizeText(group.name))
      const saved = match
        ? await this.prisma.budgetGroup.update({ where: { id: match.id }, data: { percentage: group.percentage } })
        : await this.prisma.budgetGroup.create({ data: { name: group.name, percentage: group.percentage } })
      await this.prisma.importRow.update({ where: { id: row.id }, data: { targetId: saved.id } })
      result.groups++
    }

    for (const row of rows.filter((candidate) => candidate.kind === ImportRowKind.BUDGET)) {
      const budget = JSON.parse(row.data) as Omit<MonthlyBudgetImport, 'notionSpent'>
      const saved = await this.prisma.monthlyBudget.upsert({
        where: { userId_month_year: { userId: requireUserId(), month: budget.month, year: budget.year } },
        create: { ...budget, userId: requireUserId() },
        update: { salary: budget.salary, limitPercent: budget.limitPercent },
      })
      await this.prisma.importRow.update({ where: { id: row.id }, data: { targetId: saved.id } })
      result.budgets++
    }

    await this.prisma.importBatch.update({
      where: { id: batchId },
      data: {
        status: ImportBatchStatus.APPLIED,
        appliedAt: new Date(),
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
      },
    })
    return result
  }

  // A preview that will not be applied: gone with its rows
  async discard(batchId: string): Promise<void> {
    const batch = await this.prisma.importBatch.findUnique({ where: { id: batchId } })
    if (!batch || batch.status !== ImportBatchStatus.PREVIEW) {
      throw new ImportNotPreviewException({ batchId, status: batch?.status ?? null })
    }
    await this.prisma.importBatch.delete({ where: { id: batchId } })
  }

  // A debt marked Pagado or Amortizado in Notion gets one payment of its whole amount, only the first time
  private async payOnce(debtId: string, paidAt: Date): Promise<boolean> {
    const debt = await this.prisma.debt.findUnique({ where: { id: debtId }, include: { payments: true } })
    if (!debt || debt.payments.length) return false
    await this.debts.addPayment({
      debtId,
      amount: debt.amount,
      paidAt,
      paymentMethodId: null,
      notes: 'Pagado en Notion',
    })
    return true
  }

  // RESET: deletes every row that came from Notion (the payments of the debts go with them) and the import history
  async reset(): Promise<Record<ImportTable | 'batches', number>> {
    return runAsImport(this.prisma, { entity: 'imp_batches', entityId: 'reset', action: AuditAction.DELETE }, () =>
      this.resetRows(),
    )
  }

  private async resetRows(): Promise<Record<ImportTable | 'batches', number>> {
    const deleted = {} as Record<ImportTable | 'batches', number>
    for (const table of TABLES) {
      deleted[table] = (await this.delegate(table).deleteMany({ where: { importKey: { not: null } } })).count
    }
    deleted.batches = (await this.prisma.importBatch.deleteMany({ where: { source: 'notion' } })).count
    return deleted
  }

  // new: not in Kogane · unchanged: same CSV row as the last applied import · changed: in Kogane with another row.
  // currentTable: where the row lives now, which differs from the Notion board after "Pasar a…" (D106)
  private async compare(
    expenses: {
      importKey: string
      raw: string
      status: PlannedExpense['status']
      targetId: string | null
      currentTable?: ImportTable
    }[],
  ) {
    const lastApplied = new Map<string, string>()
    const applied = await this.prisma.importRow.findMany({
      where: { kind: ImportRowKind.EXPENSE, batch: { status: ImportBatchStatus.APPLIED } },
      select: { importKey: true, raw: true },
      orderBy: { batch: { appliedAt: 'asc' } },
    })
    applied.forEach((row) => row.importKey && lastApplied.set(row.importKey, row.raw))
    const existing = new Map<string, { id: string; table: ImportTable }>()
    for (const table of TABLES) {
      const rows = await this.delegate(table).findMany({
        where: { importKey: { not: null } },
        select: { id: true, importKey: true },
      })
      rows.forEach((row) => existing.set(row.importKey!, { id: row.id, table }))
    }
    for (const expense of expenses) {
      const found = existing.get(expense.importKey)
      expense.targetId = found?.id ?? null
      expense.currentTable = found?.table
      expense.status = !expense.targetId
        ? ImportRowStatus.NEW
        : lastApplied.get(expense.importKey) === expense.raw
          ? ImportRowStatus.UNCHANGED
          : ImportRowStatus.CHANGED
    }
  }

  private target(expense: ExpenseImport, base: BaseFile, names: Map<string, string>): string {
    if (expense.table === 'creditCardExpense') return `Tarjetas ▸ ${base.card}`
    if (expense.table === 'fixedCost') return 'Costos fijos'
    if (expense.table === 'subscription') return 'Plataformas'
    const person = names.get(String(expense.data.personId ?? ''))
    return person ? `Deudas ▸ ${person}` : 'Deudas'
  }

  private async context(): Promise<{ map: MapContext; names: Map<string, string> }> {
    const [people, paymentMethods, categories] = await Promise.all([
      this.prisma.person.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.paymentMethod.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.category.findMany({ orderBy: { name: 'asc' } }),
    ])
    const aliases = (value: string) => {
      try {
        return JSON.parse(value) as string[]
      } catch {
        return []
      }
    }
    const catalog = buildExtractionCatalog({
      people: people.map((person) => ({ ...person, aliases: aliases(person.aliases) })) as PersonDbDto[],
      paymentMethods: paymentMethods.map(({ statementPassword, ...method }) => ({
        ...method,
        aliases: aliases(method.aliases),
        hasStatementPassword: !!statementPassword,
      })) as PaymentMethodDbDto[],
      categories,
    })
    const owner = people.find((person) => person.isDefault)
    if (!owner) throw new Error('No default person in the catalog: run make seed first')
    return {
      map: {
        catalog,
        defaultPersonId: owner.id,
        defaultCategoryId: categories.find((category) => category.isDefault)?.id ?? null,
      },
      names: new Map(people.map((person) => [person.id, person.name])),
    }
  }

  private delegate(table: ImportTable): Delegate {
    return this.prisma[table] as unknown as Delegate
  }
}

// Totals per payment month, as the Notion Resumen adds them, to compare month by month before saving
export function monthTotals(expenses: ExpenseImport[], budgets: MonthlyBudgetImport[]): MonthTotal[] {
  const totals = new Map<string, MonthTotal>()
  const keyOf = (month: number, year: number) => `${year}-${String(month).padStart(2, '0')}`
  const entry = (month: number, year: number) => {
    const key = keyOf(month, year)
    const current = totals.get(key) ?? {
      month,
      year,
      spent: 0,
      salary: null,
      surplus: null,
      linked: 0,
      notionSpent: null,
    }
    totals.set(key, current)
    return current
  }

  for (const expense of expenses) {
    if (expense.table !== 'fixedCost' && expense.table !== 'creditCardExpense') continue
    for (const summary of expense.summaries) {
      const linked = entry(summary.month, summary.year)
      linked.linked = toCents(linked.linked + expense.amount)
    }
    if (expense.currency !== Currency.PEN) continue
    const total = entry(expense.month, expense.year)
    total.spent = toCents(total.spent + expense.amount)
  }
  for (const budget of budgets) {
    const total = entry(budget.month, budget.year)
    total.salary = budget.salary
    total.notionSpent = budget.notionSpent
  }
  for (const total of totals.values()) {
    total.surplus = total.salary == null ? null : toCents(total.salary - total.spent)
  }
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, total]) => total)
}

export const baseLabel = (base: BaseFile | null) =>
  !base
    ? '¿?'
    : base.base === NotionBase.CARD
      ? `tarjeta ${base.card}`
      : {
          [NotionBase.FIXED_COST]: 'costos fijos',
          [NotionBase.SUBSCRIPTION]: 'plataformas',
          [NotionBase.DEBT]: 'cuentas (deudas)',
          [NotionBase.BUDGET_GROUP]: 'relación de gastos',
          [NotionBase.SUMMARY]: 'resumen',
          [NotionBase.CARD]: 'tarjeta',
        }[base.base]
