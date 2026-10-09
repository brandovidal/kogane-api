import { Test, TestingModule } from '@nestjs/testing'
import { vi } from 'vitest'

import { AttachmentKind, AttachmentRefType, MAX_ATTACHMENT_BYTES } from '@/commons/constants/commitment.constant'
import { AttachmentInvalidException } from '@/commons/exceptions/commitment/attachment-invalid.exception'
import { AttachmentNotFoundException } from '@/commons/exceptions/commitment/attachment-not-found.exception'
import { DebtNotFoundException } from '@/commons/exceptions/debt/debt-not-found.exception'
import { ExpenseNotFoundException } from '@/commons/exceptions/expense/expense-not-found.exception'
import { AttachmentDBRepository } from '@/db/models/attachment/attachmentDB.repository'
import { DebtDBRepository } from '@/db/models/debt/debtDB.repository'
import { CommitmentDBRepository } from '@/db/models/commitment/commitmentDB.repository'
import { ExpenseRecordDBRepository, ExpenseResource } from '@/db/models/expense-record/expenseRecordDB.repository'
import { StoredFilesService } from '@/modules/stored-files/stored-files.service'

import { AttachmentsService } from './attachments.service'

const mockAttachments = {
  create: vi.fn(),
  findById: vi.fn(),
  findByRef: vi.fn(),
  countByRefs: vi.fn(),
  delete: vi.fn(),
  deleteByRefs: vi.fn(),
}
const mockCommitments = { findById: vi.fn(), findContribution: vi.fn() }
const mockExpenses = { exists: vi.fn() }
const mockDebts = { findPayment: vi.fn() }
const mockStoredFiles = { storeAttachment: vi.fn(), release: vi.fn(), signedUrl: vi.fn() }

const PDF = { buffer: Buffer.from('pdf'), mimetype: 'application/pdf', originalname: 'recibo-03.pdf' }
const stored = { id: 'file-1', contentType: 'application/pdf', sizeBytes: 3 }

describe('AttachmentsService', () => {
  let service: AttachmentsService

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttachmentsService,
        { provide: AttachmentDBRepository, useValue: mockAttachments },
        { provide: CommitmentDBRepository, useValue: mockCommitments },
        { provide: DebtDBRepository, useValue: mockDebts },
        { provide: ExpenseRecordDBRepository, useValue: mockExpenses },
        { provide: StoredFilesService, useValue: mockStoredFiles },
      ],
    }).compile()
    service = module.get(AttachmentsService)

    mockCommitments.findById.mockResolvedValue({ id: 'c1' })
    mockStoredFiles.storeAttachment.mockResolvedValue(stored)
    mockStoredFiles.signedUrl.mockResolvedValue('https://signed')
    mockAttachments.create.mockImplementation(async (data) => ({
      ...data,
      id: 'a1',
      file: stored,
      createdAt: new Date('2026-09-26T00:00:00.000Z'),
    }))
  })

  afterEach(() => vi.resetAllMocks())

  describe('upload', () => {
    it('should store the file in the folder of its area and answer with a signed link', async () => {
      const view = await service.upload({ refType: AttachmentRefType.COMMITMENT, refId: 'c1', kind: 'recibo' }, PDF)

      expect(mockStoredFiles.storeAttachment).toHaveBeenCalledWith('commitments', PDF.buffer, 'application/pdf')
      expect(mockAttachments.create).toHaveBeenCalledWith({
        fileId: 'file-1',
        refType: 'commitment',
        refId: 'c1',
        kind: 'recibo',
        name: 'recibo-03.pdf',
      })
      expect(view).toEqual(expect.objectContaining({ id: 'a1', url: 'https://signed', kind: 'recibo' }))
    })

    it('should reject a type that is not an image or a document, a file that is too big and an empty one', async () => {
      const body = { refType: AttachmentRefType.COMMITMENT, refId: 'c1' } as const

      await expect(service.upload(body, { ...PDF, mimetype: 'application/zip' })).rejects.toMatchObject({
        response: expect.objectContaining({ details: { reason: 'type', contentType: 'application/zip' } }),
      })
      await expect(service.upload(body, { ...PDF, buffer: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) })).rejects.toThrow(
        AttachmentInvalidException,
      )
      await expect(service.upload(body, { ...PDF, buffer: Buffer.alloc(0) })).rejects.toThrow(
        AttachmentInvalidException,
      )
      expect(mockStoredFiles.storeAttachment).not.toHaveBeenCalled()
    })

    it('should not attach to a record that does not exist', async () => {
      mockExpenses.exists.mockResolvedValue(false)

      await expect(service.upload({ refType: AttachmentRefType.EXPENSE, refId: 'nope' }, PDF)).rejects.toThrow(
        ExpenseNotFoundException,
      )
      expect(mockStoredFiles.storeAttachment).not.toHaveBeenCalled()
    })

    it('should look for an installment only among the fixed costs and for an expense in every expense table', async () => {
      mockExpenses.exists.mockResolvedValue(true)
      await service.upload({ refType: AttachmentRefType.FIXED_COST, refId: 'f1' }, PDF)
      expect(mockExpenses.exists.mock.calls).toEqual([[ExpenseResource.FIXED_COST, 'f1']])

      mockExpenses.exists.mockReset().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
      await service.upload({ refType: AttachmentRefType.EXPENSE, refId: 'e1' }, PDF)
      expect(mockExpenses.exists).toHaveBeenCalledTimes(2)
    })
  })

  describe('debt payment Comprobante', () => {
    it('should keep the Comprobante of a cobro or debt payment in debts/ as a factura or any kind', async () => {
      mockDebts.findPayment.mockResolvedValue({ id: 'pay1' })
      await service.upload(
        { refType: AttachmentRefType.DEBT_PAYMENT, refId: 'pay1', kind: AttachmentKind.INVOICE },
        PDF,
      )

      expect(mockStoredFiles.storeAttachment).toHaveBeenCalledWith('debts', PDF.buffer, 'application/pdf')
      expect(mockAttachments.create).toHaveBeenCalledWith(
        expect.objectContaining({ refType: 'debt_payment', refId: 'pay1', kind: 'factura' }),
      )
    })

    it('should not attach to a payment that does not exist', async () => {
      mockDebts.findPayment.mockResolvedValue(null)
      await expect(service.upload({ refType: AttachmentRefType.DEBT_PAYMENT, refId: 'nope' }, PDF)).rejects.toThrow(
        DebtNotFoundException,
      )
      expect(mockStoredFiles.storeAttachment).not.toHaveBeenCalled()
    })
  })

  describe('delete', () => {
    it('should delete the attachment and release its file', async () => {
      mockAttachments.findById.mockResolvedValue({ id: 'a1', fileId: 'file-1' })

      await service.delete('a1')

      expect(mockAttachments.delete).toHaveBeenCalledWith('a1')
      expect(mockStoredFiles.release).toHaveBeenCalledWith('file-1')
    })

    it('should fail when the attachment does not exist', async () => {
      mockAttachments.findById.mockResolvedValue(null)

      await expect(service.delete('nope')).rejects.toThrow(AttachmentNotFoundException)
    })
  })

  describe('removeOf', () => {
    it('should release every file of a deleted record, even if one fails', async () => {
      mockAttachments.deleteByRefs.mockResolvedValue(['f1', 'f2'])
      mockStoredFiles.release.mockRejectedValueOnce(new Error('R2 down')).mockResolvedValueOnce(true)

      await service.removeOf([AttachmentRefType.COMMITMENT], 'c1')

      expect(mockAttachments.deleteByRefs).toHaveBeenCalledWith(['commitment'], 'c1')
      expect(mockStoredFiles.release).toHaveBeenCalledTimes(2)
    })
  })
})
