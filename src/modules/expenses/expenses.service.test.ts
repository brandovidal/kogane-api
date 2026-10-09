import { Logger } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { ZodValidationException } from 'nestjs-zod'
import { vi } from 'vitest'

import { ExpenseNotFoundException } from '@/commons/exceptions/expense/expense-not-found.exception'
import { ExpenseRecordDBRepository, ExpenseResource } from '@/db/models/expense-record/expenseRecordDB.repository'
import { AttachmentsService } from '@/modules/attachments/attachments.service'
import { StoredFilesService } from '@/modules/stored-files/stored-files.service'

import { RecurringTemplateExistsException } from '@/commons/exceptions/expense/recurring-template-exists.exception'
import { ExpensesService } from './expenses.service'

const mockExpenseRecordDB = {
  delete: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  findMany: vi.fn(),
  findSeries: vi.fn(),
  findById: vi.fn(),
}
const mockStoredFiles = { release: vi.fn() }
const mockAttachments = { removeOf: vi.fn() }

describe('ExpensesService', () => {
  let service: ExpensesService

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExpensesService,
        { provide: ExpenseRecordDBRepository, useValue: mockExpenseRecordDB },
        { provide: StoredFilesService, useValue: mockStoredFiles },
        { provide: AttachmentsService, useValue: mockAttachments },
      ],
    }).compile()

    service = module.get(ExpensesService)
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  // D58: the screenshot goes with the expense, unless something else still uses it (checked by release)
  describe('delete', () => {
    it('should remove the files attached to the deleted expense', async () => {
      mockExpenseRecordDB.delete.mockResolvedValue({ fileId: null })

      await service.delete(ExpenseResource.CREDIT_CARD, 'expense-1')

      expect(mockAttachments.removeOf).toHaveBeenCalledWith(['expense', 'fixed_cost'], 'expense-1')
    })

    it('should release the file of the deleted expense', async () => {
      mockExpenseRecordDB.delete.mockResolvedValue({ fileId: 'stored-1' })

      await service.delete(ExpenseResource.DAILY, 'expense-1')

      expect(mockExpenseRecordDB.delete).toHaveBeenCalledWith(ExpenseResource.DAILY, 'expense-1')
      expect(mockStoredFiles.release).toHaveBeenCalledWith('stored-1')
    })

    it('should not touch storage for an expense without a file', async () => {
      mockExpenseRecordDB.delete.mockResolvedValue({ fileId: null })

      await service.delete(ExpenseResource.FIXED_COST, 'expense-1')

      expect(mockStoredFiles.release).not.toHaveBeenCalled()
    })

    it('should keep the expense deleted when the file cannot be released', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
      mockExpenseRecordDB.delete.mockResolvedValue({ fileId: 'stored-1' })
      mockStoredFiles.release.mockRejectedValue(new Error('R2 down'))

      await expect(service.delete(ExpenseResource.DAILY, 'expense-1')).resolves.toBeUndefined()
    })

    it('should not release anything when the expense does not exist', async () => {
      mockExpenseRecordDB.delete.mockRejectedValue(
        new ExpenseNotFoundException({ resource: ExpenseResource.DAILY, id: 'x' }),
      )

      await expect(service.delete(ExpenseResource.DAILY, 'x')).rejects.toThrow(ExpenseNotFoundException)
      expect(mockStoredFiles.release).not.toHaveBeenCalled()
    })
  })

  // P7: the body is validated per table, and a PEN amount is also its amount in soles
  describe('create and update', () => {
    beforeEach(() => {
      mockExpenseRecordDB.findMany.mockResolvedValue([])
      mockExpenseRecordDB.create.mockImplementation(async (_resource, data) => ({ id: 'new', ...data }))
      mockExpenseRecordDB.update.mockImplementation(async (_resource, id, data) => ({ id, ...data }))
    })

    it('should not turn a dollar expense into soles when an edit does not send the currency', async () => {
      await service.update(ExpenseResource.CREDIT_CARD, 'cc-1', { paymentStatus: 'paid' })

      expect(mockExpenseRecordDB.update.mock.calls[0][2]).toEqual({ paymentStatus: 'paid' })
    })

    it('should keep the split of a recurring template as JSON and answer it as an object (P30)', async () => {
      const sharedWith = { shares: [{ personId: 'brenda', ratio: 0.5 }] }
      const created = await service.create(ExpenseResource.RECURRING, {
        description: 'Netflix',
        amount: 52.9,
        currency: 'PEN',
        personId: 'person-1',
        targetType: 'subscription',
        dayOfMonth: 5,
        sharedWith,
      })

      expect(mockExpenseRecordDB.create.mock.calls[0][1].sharedWith).toBe(JSON.stringify(sharedWith))
      expect(created).toEqual(expect.objectContaining({ sharedWith }))
      await service.update(ExpenseResource.RECURRING, 'rec-1', { sharedWith: null })
      expect(mockExpenseRecordDB.update.mock.calls[0][2]).toEqual({ sharedWith: null })
    })

    const daily = {
      description: 'Almuerzo',
      amount: 25,
      personId: 'person-1',
      paymentMethodId: 'method-1',
      spentAt: '2026-09-22',
    }

    it('should validate the body of the table and fill amountInPen for soles', async () => {
      await service.create(ExpenseResource.DAILY, daily)

      expect(mockExpenseRecordDB.create).toHaveBeenCalledWith(
        ExpenseResource.DAILY,
        expect.objectContaining({ description: 'Almuerzo', currency: 'PEN', amountInPen: 25 }),
      )
    })

    it('should not give a recurring template amountInPen: the table has no such column', async () => {
      const template = {
        description: 'bono 1',
        amount: 10,
        currency: 'PEN',
        personId: 'person-1',
        targetType: 'fixed_cost',
        dayOfMonth: 1,
      }
      await service.create(ExpenseResource.RECURRING, template)
      await service.update(ExpenseResource.RECURRING, 'rec-1', { amount: 12, currency: 'PEN' })

      expect(mockExpenseRecordDB.create.mock.calls[0][1]).not.toHaveProperty('amountInPen')
      expect(mockExpenseRecordDB.update).toHaveBeenCalledWith(ExpenseResource.RECURRING, 'rec-1', {
        amount: 12,
        currency: 'PEN',
      })
    })

    it('should create every new fixed cost, subscription and card charge as "No iniciado", and never touch it on edit', async () => {
      const card = {
        description: 'Zapatillas',
        amount: 199,
        currency: 'PEN',
        personId: 'person-1',
        paymentMethodId: 'card-io',
        paymentMonth: 10,
        paymentYear: 2026,
      }
      await service.create(ExpenseResource.CREDIT_CARD, card)
      await service.create(ExpenseResource.CREDIT_CARD, { ...card, paymentStatus: 'paid' })
      await service.update(ExpenseResource.CREDIT_CARD, 'cc-1', { amount: 200 })

      expect(mockExpenseRecordDB.create.mock.calls[0][1]).toEqual(
        expect.objectContaining({ paymentStatus: 'not_started' }),
      )
      expect(mockExpenseRecordDB.create.mock.calls[1][1]).toEqual(expect.objectContaining({ paymentStatus: 'paid' }))
      expect(mockExpenseRecordDB.update.mock.calls[0][2]).not.toHaveProperty('paymentStatus')
    })

    it('should reject a body that does not fit the table', async () => {
      await expect(service.create(ExpenseResource.DAILY, { ...daily, amount: -5 })).rejects.toThrow(
        ZodValidationException,
      )
      expect(mockExpenseRecordDB.create).not.toHaveBeenCalled()
    })

    it('should update only the given columns', async () => {
      await service.update(ExpenseResource.DAILY, 'expense-1', { amount: 30, currency: 'PEN' })

      expect(mockExpenseRecordDB.update).toHaveBeenCalledWith(ExpenseResource.DAILY, 'expense-1', {
        amount: 30,
        currency: 'PEN',
        amountInPen: 30,
      })
    })

    it('should list with the filters of the query', async () => {
      await service.findMany(ExpenseResource.FIXED_COST, { month: 9, year: 2026, personId: 'person-1' })

      expect(mockExpenseRecordDB.findMany).toHaveBeenCalledWith(ExpenseResource.FIXED_COST, {
        month: 9,
        year: 2026,
        personId: 'person-1',
      })
    })
  })

  describe('recurringFromSeries', () => {
    it('should repeat the latest row of the series as a monthly template', async () => {
      mockExpenseRecordDB.findSeries.mockResolvedValue({
        rows: [{ id: 'f1' }, { id: 'f2' }],
        templates: 0,
        blockedIds: [],
      })
      mockExpenseRecordDB.findById.mockResolvedValue({
        id: 'f2',
        description: 'Internet',
        amount: 99,
        personId: 'me',
        categoryId: 'cat1',
        paymentMonth: 10,
        paymentYear: 2026,
        dueDate: new Date('2026-10-12T00:00:00Z'),
      })
      mockExpenseRecordDB.create.mockImplementation(async (_resource, data) => ({
        id: 'r1',
        ...data,
        sharedWith: null,
      }))

      const template = (await service.recurringFromSeries(ExpenseResource.FIXED_COST, 'f1')) as Record<string, unknown>

      expect(mockExpenseRecordDB.findById).toHaveBeenCalledWith(ExpenseResource.FIXED_COST, 'f2')
      expect(mockExpenseRecordDB.create).toHaveBeenCalledWith(
        ExpenseResource.RECURRING,
        expect.objectContaining({ description: 'Internet', targetType: 'fixed_cost', dayOfMonth: 12 }),
      )
      expect(template.id).toBe('r1')
    })

    it('should refuse a series that already has a template', async () => {
      mockExpenseRecordDB.findSeries.mockResolvedValue({ rows: [{ id: 'f1' }], templates: 1, blockedIds: [] })
      await expect(service.recurringFromSeries(ExpenseResource.FIXED_COST, 'f1')).rejects.toBeInstanceOf(
        RecurringTemplateExistsException,
      )
      expect(mockExpenseRecordDB.create).not.toHaveBeenCalled()
    })
  })
})
