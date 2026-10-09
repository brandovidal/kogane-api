import { Test, TestingModule } from '@nestjs/testing'
import { vi } from 'vitest'

import { CategoryDBRepository } from '@/db/models/category/categoryDB.repository'
import { ExpenseResource } from '@/db/models/expense-record/expenseRecordDB.repository'
import { PaymentMethodDBRepository } from '@/db/models/payment-method/paymentMethodDB.repository'
import { PersonDBRepository } from '@/db/models/person/personDB.repository'
import { DebtsService } from '@/modules/debts/debts.service'
import { ExpensesService } from '@/modules/expenses/expenses.service'

import { ListImportTarget } from './list-csv.mapper'
import { ListImportService } from './list-import.service'

const mockPeople = { findAll: vi.fn(), findDefault: vi.fn() }
const mockMethods = { findActive: vi.fn() }
const mockCategories = { findAll: vi.fn() }
const mockExpenses = { create: vi.fn() }
const mockDebts = { create: vi.fn(), update: vi.fn() }

const csv = (text: string) => ({ buffer: Buffer.from(text, 'utf8') })

describe('ListImportService', () => {
  let service: ListImportService

  beforeEach(async () => {
    vi.clearAllMocks()
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ListImportService,
        { provide: PersonDBRepository, useValue: mockPeople },
        { provide: PaymentMethodDBRepository, useValue: mockMethods },
        { provide: CategoryDBRepository, useValue: mockCategories },
        { provide: ExpensesService, useValue: mockExpenses },
        { provide: DebtsService, useValue: mockDebts },
      ],
    }).compile()
    service = module.get(ListImportService)
    mockPeople.findAll.mockResolvedValue([
      { id: 'me', name: 'Brando', aliases: [] },
      { id: 'dany', name: 'Danery', aliases: ['dany'] },
    ])
    mockPeople.findDefault.mockResolvedValue({ id: 'me' })
    mockMethods.findActive.mockResolvedValue([{ id: 'yape', name: 'Yape', aliases: [] }])
    mockCategories.findAll.mockResolvedValue([])
  })

  const DAILY = 'Descripción,Monto,Fecha,Medio de pago\nAlmuerzo,12,02/10/2026,Yape\nTaxi,,03/10/2026,Yape\n'

  it('should preview without writing anything', async () => {
    const result = await service.run(ListImportTarget.DAILY, csv(DAILY), false)

    expect(result).toMatchObject({ total: 2, ready: 1, created: 0, withIssues: 1, applied: false })
    expect(result.rows[1]).toMatchObject({ line: 3, status: 'issue', issues: ['Falta el monto o no es mayor a 0'] })
    expect(mockExpenses.create).not.toHaveBeenCalled()
  })

  it('should create only the ready rows when applied', async () => {
    mockExpenses.create.mockResolvedValue({ id: 'e1' })
    const result = await service.run(ListImportTarget.DAILY, csv(DAILY), true)

    expect(result).toMatchObject({ created: 1, withIssues: 1 })
    expect(mockExpenses.create).toHaveBeenCalledWith(
      ExpenseResource.DAILY,
      expect.objectContaining({ description: 'Almuerzo', spentAt: '2026-10-02', paymentMethodId: 'yape' }),
    )
  })

  it('should create a cobro with its installment', async () => {
    mockDebts.create.mockResolvedValue([{ id: 'd1' }])
    await service.run(
      ListImportTarget.RECEIVABLES,
      csv('Descripción,Monto,Mes de pago,Persona,Cuota\nStream,74.57,10/2026,dany,2/3\n'),
      true,
    )
    expect(mockDebts.create).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'owed_to_me', personId: 'dany', paymentMonth: 10, paymentYear: 2026 }),
    )
    expect(mockDebts.update).toHaveBeenCalledWith('d1', { installment: '2/3' })
  })

  it('should keep a row that failed to save as an issue and go on', async () => {
    mockExpenses.create.mockRejectedValueOnce(new Error('boom'))
    const result = await service.run(ListImportTarget.DAILY, csv(DAILY), true)
    expect(result.rows[0]).toMatchObject({ status: 'issue', issues: ['No se pudo crear: boom'] })
  })

  it('should refuse an empty file', async () => {
    await expect(service.run(ListImportTarget.DAILY, csv(''), false)).rejects.toThrow('Sube el archivo CSV')
    await expect(service.run(ListImportTarget.DAILY, csv('Descripción,Monto\n'), false)).rejects.toThrow(
      'El CSV no tiene filas',
    )
  })
})
