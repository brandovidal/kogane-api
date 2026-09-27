import { Injectable, Logger } from '@nestjs/common'

import {
  ATTACHMENT_FOLDERS,
  ATTACHMENT_MIME_TYPES,
  AttachmentKind,
  AttachmentRefType,
  MAX_ATTACHMENT_BYTES,
} from '@/commons/constants/commitment.constant'
import { AttachmentInvalidException } from '@/commons/exceptions/commitment/attachment-invalid.exception'
import { AttachmentNotFoundException } from '@/commons/exceptions/commitment/attachment-not-found.exception'
import { ExpenseNotFoundException } from '@/commons/exceptions/expense/expense-not-found.exception'
import { AttachmentDBRepository, AttachmentWithFile } from '@/db/models/attachment/attachmentDB.repository'
import { CommitmentDBRepository } from '@/db/models/commitment/commitmentDB.repository'
import { ExpenseRecordDBRepository, ExpenseResource } from '@/db/models/expense-record/expenseRecordDB.repository'
import { StoredFilesService } from '@/modules/stored-files/stored-files.service'

import { UploadAttachmentDto } from './dto/request/attachments.dto'

export interface UploadedAttachment {
  buffer: Buffer
  mimetype: string
  originalname?: string
}

// Tables where an "expense" attachment can point
const EXPENSE_TABLES = [
  ExpenseResource.DAILY,
  ExpenseResource.CREDIT_CARD,
  ExpenseResource.SUBSCRIPTION,
  ExpenseResource.FIXED_COST,
]

// Boletas, recibos and contracts of loans, investments and expenses (P27, D100): R2 keeps the file, exp_attachments
// says whose it is
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name)

  constructor(
    private readonly attachmentDBRepository: AttachmentDBRepository,
    private readonly commitmentDBRepository: CommitmentDBRepository,
    private readonly expenseRecordDBRepository: ExpenseRecordDBRepository,
    private readonly storedFilesService: StoredFilesService,
  ) {}

  async upload(body: UploadAttachmentDto, file: UploadedAttachment) {
    const contentType = file.mimetype.split(';')[0]
    if (!file.buffer.length) throw new AttachmentInvalidException({ reason: 'empty' })
    if (file.buffer.length > MAX_ATTACHMENT_BYTES) throw new AttachmentInvalidException({ reason: 'size' })
    if (!(ATTACHMENT_MIME_TYPES as readonly string[]).includes(contentType)) {
      throw new AttachmentInvalidException({ reason: 'type', contentType })
    }
    const resource = await this.assertRefExists(body.refType, body.refId)

    const stored = await this.storedFilesService.storeAttachment(
      ATTACHMENT_FOLDERS[body.refType],
      file.buffer,
      contentType,
    )
    const created = await this.attachmentDBRepository.create(
      {
        fileId: stored.id,
        refType: body.refType,
        refId: body.refId,
        kind: body.kind ?? AttachmentKind.OTHER,
        name: body.name ?? file.originalname?.trim().slice(0, 120) ?? 'archivo',
      },
      body.kind === AttachmentKind.BOLETA && resource === ExpenseResource.FIXED_COST,
    )
    return this.toView(created)
  }

  async list(refType: AttachmentRefType, refId: string) {
    const rows = await this.attachmentDBRepository.findByRef(refType, refId)
    return Promise.all(rows.map((row) => this.toView(row)))
  }

  // How many files each record has, for the badge of the lists
  counts(refType: AttachmentRefType, refIds: string[]): Promise<Map<string, number>> {
    return this.attachmentDBRepository.countByRefs(refType, refIds)
  }

  async delete(id: string): Promise<void> {
    const attachment = await this.attachmentDBRepository.findById(id)
    if (!attachment) throw new AttachmentNotFoundException({ id })
    await this.attachmentDBRepository.delete(id)
    await this.release([attachment.fileId])
  }

  // The record was deleted: its files leave the bucket too (unless another draft or attachment still uses them)
  async removeOf(refTypes: AttachmentRefType[], refId: string): Promise<void> {
    await this.release(await this.attachmentDBRepository.deleteByRefs(refTypes, refId))
  }

  private async release(fileIds: string[]): Promise<void> {
    for (const fileId of fileIds) {
      try {
        await this.storedFilesService.release(fileId)
      } catch (error) {
        this.logger.warn(`[release] file ${fileId} not released: ${(error as Error).message}`)
      }
    }
  }

  private async assertRefExists(refType: AttachmentRefType, refId: string): Promise<ExpenseResource | undefined> {
    if (refType === AttachmentRefType.COMMITMENT) {
      await this.commitmentDBRepository.findById(refId)
      return
    }
    if (refType === AttachmentRefType.CONTRIBUTION) {
      await this.commitmentDBRepository.findContribution(refId)
      return
    }
    const tables = refType === AttachmentRefType.FIXED_COST ? [ExpenseResource.FIXED_COST] : EXPENSE_TABLES
    for (const table of tables) {
      if (await this.expenseRecordDBRepository.exists(table, refId)) return table
    }
    throw new ExpenseNotFoundException({ refType, refId })
  }

  private async toView(row: AttachmentWithFile) {
    return {
      id: row.id,
      refType: row.refType as AttachmentRefType,
      refId: row.refId,
      kind: row.kind as AttachmentKind,
      name: row.name,
      contentType: row.file.contentType,
      sizeBytes: row.file.sizeBytes,
      url: await this.storedFilesService.signedUrl(row.fileId),
      createdAt: row.createdAt,
    }
  }
}
