import { BadRequestException, Injectable } from '@nestjs/common'
import { z } from 'zod'

import { CategoryDBRepository } from '@/db/models/category/categoryDB.repository'
import { ExpenseResource } from '@/db/models/expense-record/expenseRecordDB.repository'
import { PaymentMethodDBRepository } from '@/db/models/payment-method/paymentMethodDB.repository'
import { PersonDBRepository } from '@/db/models/person/personDB.repository'
import { DebtsService } from '@/modules/debts/debts.service'
import { createDebtSchema } from '@/modules/debts/validations/debts.validation'
import { ExpensesService } from '@/modules/expenses/expenses.service'
import { EXPENSE_SCHEMAS } from '@/modules/expenses/validations/expenses.validation'

import { parseCsv } from '../notion/notion-csv'
import { ListImportTarget, mapListRow } from './list-csv.mapper'

export interface ListImportFile {
  buffer: Buffer
  originalname?: string
}

export type ListImportRowStatus = 'ready' | 'issue' | 'created'

const RESOURCE_OF: Partial<Record<ListImportTarget, ExpenseResource>> = {
  [ListImportTarget.DAILY]: ExpenseResource.DAILY,
  [ListImportTarget.PLATFORMS]: ExpenseResource.SUBSCRIPTION,
  [ListImportTarget.RECURRING]: ExpenseResource.RECURRING,
}

const MAX_ROWS = 1000

// "Importar gastos… / plataformas… / recurrentes… / cuotas… / deudas…" of the ⋯ menu of each list. First a preview
// (nothing is written): every row with its issues in Spanish; with apply the ready rows are created like the web
// would (POST /expenses/:resource, POST /debts) and the rest are left out
@Injectable()
export class ListImportService {
  constructor(
    private readonly personDBRepository: PersonDBRepository,
    private readonly paymentMethodDBRepository: PaymentMethodDBRepository,
    private readonly categoryDBRepository: CategoryDBRepository,
    private readonly expensesService: ExpensesService,
    private readonly debtsService: DebtsService,
  ) {}

  async run(target: ListImportTarget, file: ListImportFile | undefined, apply: boolean) {
    if (!file?.buffer?.length) throw new BadRequestException('Sube el archivo CSV de la lista')
    const { rows } = parseCsv(file.buffer.toString('utf8'))
    if (!rows.length) throw new BadRequestException('El CSV no tiene filas')
    if (rows.length > MAX_ROWS) throw new BadRequestException(`Máximo ${MAX_ROWS} filas por archivo`)

    const [people, paymentMethods, categories, owner] = await Promise.all([
      this.personDBRepository.findAll(),
      this.paymentMethodDBRepository.findActive(),
      this.categoryDBRepository.findAll(),
      this.personDBRepository.findDefault(),
    ])
    const catalogs = { people, paymentMethods, categories, defaultPersonId: owner?.id ?? null }
    const schema = this.schemaOf(target)

    const result: {
      line: number
      description: string | null
      amount: number | null
      status: ListImportRowStatus
      issues: string[]
    }[] = []
    for (const row of rows) {
      const mapped = mapListRow(target, row, catalogs)
      const issues = [...mapped.issues]
      let status: ListImportRowStatus = issues.length ? 'issue' : 'ready'
      if (mapped.body) {
        const parsed = schema.safeParse(mapped.body)
        if (!parsed.success) {
          issues.push(...parsed.error.issues.map((issue) => `Dato inválido en ${issue.path.join('.') || 'la fila'}`))
          status = 'issue'
        } else if (apply) {
          try {
            await this.create(target, mapped.body)
            status = 'created'
          } catch (error) {
            issues.push(`No se pudo crear: ${(error as Error).message}`)
            status = 'issue'
          }
        }
      }
      result.push({ line: mapped.line, description: mapped.description, amount: mapped.amount, status, issues })
    }

    const count = (status: ListImportRowStatus) => result.filter((row) => row.status === status).length
    return {
      target,
      applied: apply,
      total: result.length,
      ready: count('ready'),
      created: count('created'),
      withIssues: count('issue'),
      rows: result,
    }
  }

  private schemaOf(target: ListImportTarget): z.ZodType {
    const resource = RESOURCE_OF[target]
    return resource ? EXPENSE_SCHEMAS[resource] : createDebtSchema
  }

  private async create(target: ListImportTarget, body: Record<string, unknown>) {
    const resource = RESOURCE_OF[target]
    if (resource) return this.expensesService.create(resource, body)
    const { installment, ...debt } = body
    const [created] = await this.debtsService.create(createDebtSchema.parse(debt))
    if (installment && created) await this.debtsService.update(created.id, { installment: installment as string })
    return created
  }
}
