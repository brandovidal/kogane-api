import { RecurringTemplateExistsException } from '@/commons/exceptions/expense/recurring-template-exists.exception'
import { templateFromRow } from '@/commons/helpers/recurring.helper'
import { Injectable, Logger } from '@nestjs/common'
import { ZodValidationException } from 'nestjs-zod'

import { AttachmentRefType } from '@/commons/constants/commitment.constant'
import { Currency, PaymentStatus } from '@/commons/constants/expense.constant'
import { JsonHelper } from '@/commons/helpers/json.helper'
import { ExpenseRecordDBRepository, ExpenseResource } from '@/db/models/expense-record/expenseRecordDB.repository'
import { AttachmentsService } from '@/modules/attachments/attachments.service'
import { StoredFilesService } from '@/modules/stored-files/stored-files.service'

import { ExpenseListQueryDto } from './dto/request/expenses.dto'
import { EXPENSE_SCHEMAS } from './validations/expenses.validation'

// Tables with a payment status (day to day has none; templates are not expenses)
const RESOURCES_WITH_STATUS: ExpenseResource[] = [
  ExpenseResource.FIXED_COST,
  ExpenseResource.SUBSCRIPTION,
  ExpenseResource.CREDIT_CARD,
]

// CRUD of the expense tables for kogane-app (P7). The bot keeps saving through ExpenseSaverService (drafts).
@Injectable()
export class ExpensesService {
  private readonly logger = new Logger(ExpensesService.name)

  constructor(
    private readonly expenseRecordDBRepository: ExpenseRecordDBRepository,
    private readonly storedFilesService: StoredFilesService,
    private readonly attachmentsService: AttachmentsService,
  ) {}

  async findMany(resource: ExpenseResource, query: ExpenseListQueryDto) {
    return (await this.expenseRecordDBRepository.findMany(resource, query)).map((row) => this.toView(resource, row))
  }

  async findById(resource: ExpenseResource, id: string) {
    return this.toView(resource, await this.expenseRecordDBRepository.findById(resource, id))
  }

  async create(resource: ExpenseResource, body: unknown) {
    const data = this.parse(resource, body, false)
    // Every new row starts "No iniciado"; exp_credit_card_expenses still defaults to pending in the database
    if (RESOURCES_WITH_STATUS.includes(resource) && data.paymentStatus === undefined) {
      data.paymentStatus = PaymentStatus.NOT_STARTED
    }
    return this.toView(
      resource,
      await this.expenseRecordDBRepository.create(resource, this.toColumns(this.withAmountInPen(resource, data))),
    )
  }

  async update(resource: ExpenseResource, id: string, body: unknown) {
    return this.toView(
      resource,
      await this.expenseRecordDBRepository.update(
        resource,
        id,
        this.toColumns(this.withAmountInPen(resource, this.parse(resource, body, true))),
      ),
    )
  }

  // The split of a template is a JSON column (SQLite): written as text, answered as an object
  private toColumns(data: Record<string, unknown>) {
    return data.sharedWith === undefined
      ? data
      : { ...data, sharedWith: data.sharedWith ? JsonHelper.stringify(data.sharedWith) : null }
  }

  // "Pasar desde Costos fijos… / Plataformas…" of Recurrentes: a template that repeats the series of a row every
  // month, from its latest row (409 RECURRING_TEMPLATE_EXISTS when the series already has one)
  async recurringFromSeries(resource: ExpenseResource.FIXED_COST | ExpenseResource.SUBSCRIPTION, id: string) {
    const series = await this.expenseRecordDBRepository.findSeries(resource, id)
    if (series.templates) throw new RecurringTemplateExistsException({ resource, id })
    const latest = series.rows[series.rows.length - 1]
    const row = (await this.expenseRecordDBRepository.findById(resource, latest?.id ?? id)) as Record<string, unknown>
    const from = resource === ExpenseResource.FIXED_COST ? 'fixed_cost' : 'subscription'
    return this.toView(
      ExpenseResource.RECURRING,
      await this.expenseRecordDBRepository.create(ExpenseResource.RECURRING, templateFromRow(row, from)),
    )
  }

  private toView(resource: ExpenseResource, row: unknown) {
    if (resource !== ExpenseResource.RECURRING || !row) return row
    const record = row as Record<string, unknown>
    const shared = JsonHelper.parseObject<{ shares?: unknown[] }>(record.sharedWith as string | null)
    return { ...record, sharedWith: shared.shares?.length ? shared : null }
  }

  async delete(resource: ExpenseResource, id: string): Promise<void> {
    const { fileId } = await this.expenseRecordDBRepository.delete(resource, id)
    // Boletas and receipts attached to it (P27, D100) go with it
    await this.attachmentsService.removeOf([AttachmentRefType.EXPENSE, AttachmentRefType.FIXED_COST], id)
    if (!fileId) return
    try {
      await this.storedFilesService.release(fileId)
    } catch (error) {
      this.logger.warn(`[delete] file ${fileId} not released: ${(error as Error).message}`)
    }
  }

  private parse(resource: ExpenseResource, body: unknown, partial: boolean): Record<string, unknown> {
    const schema = partial ? EXPENSE_SCHEMAS[resource].partial() : EXPENSE_SCHEMAS[resource]
    const parsed = schema.safeParse(body)
    if (!parsed.success) throw new ZodValidationException(parsed.error)
    const data = parsed.data as Record<string, unknown>
    // Zod keeps the defaults of .partial() (currency: PEN): an edit only carries the fields it sent, or changing the
    // status of a dollar expense would turn it into soles
    if (!partial || !body || typeof body !== 'object') return data
    return Object.fromEntries(Object.entries(data).filter(([key]) => key in body))
  }

  // Recurring templates have no amountInPen: only the rows they generate do
  private withAmountInPen(resource: ExpenseResource, data: Record<string, unknown>) {
    if (resource === ExpenseResource.RECURRING) return data
    if (data.currency === Currency.PEN && typeof data.amount === 'number') return { ...data, amountInPen: data.amount }
    return data
  }
}
