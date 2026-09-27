import { Test, TestingModule } from '@nestjs/testing'
import ExcelJS from 'exceljs'
import { vi } from 'vitest'

import { DebtDirection, DebtStatus, DebtTiming } from '@/commons/constants/debt.constant'
import { ReportFormat } from '@/commons/constants/report.constant'
import { DebtsService } from '@/modules/debts/debts.service'
import { PaymentMethodDBRepository } from '@/db/models/payment-method/paymentMethodDB.repository'

import { ReportsService } from './reports.service'

const mockDebts = { summary: vi.fn(), list: vi.fn() }
const mockPaymentMethods = { findAll: vi.fn().mockResolvedValue([]) }

const debt = {
  id: 'debt-1',
  direction: DebtDirection.OWED_TO_ME,
  description: 'Iphone 16',
  amount: 500,
  paidAmount: 100,
  balance: 400,
  currency: 'PEN',
  installment: '3/12',
  paymentMonth: 9,
  paymentYear: 2026,
  status: DebtStatus.PARTIAL,
  timing: DebtTiming.LATE,
  personId: 'person-danery',
  person: { id: 'person-danery', name: 'Danery' },
}

describe('ReportsService', () => {
  let service: ReportsService

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: DebtsService, useValue: mockDebts },
        { provide: PaymentMethodDBRepository, useValue: mockPaymentMethods },
      ],
    }).compile()
    service = module.get(ReportsService)

    mockDebts.summary.mockResolvedValue([
      { personId: 'person-danery', name: 'Danery', owedToMe: 400, iOwe: 0, net: 400, late: 400, dueThisMonth: 0 },
      { personId: 'person-juan', name: 'Juan', owedToMe: 0, iOwe: 50, net: -50, late: 0, dueThisMonth: 0 },
    ])
    mockDebts.list.mockResolvedValue([debt])
  })

  afterEach(() => vi.clearAllMocks())

  it('should build the Excel of one person with the summary and the detail of each installment (D39)', async () => {
    const file = await service.debts(ReportFormat.XLSX, 'person-danery')

    expect(file.filename).toMatch(/^deudas-danery-\d{4}-\d{2}-\d{2}\.xlsx$/)
    expect(file.mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(mockDebts.list).toHaveBeenCalledWith(expect.objectContaining({ personId: 'person-danery' }))

    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(file.data as unknown as ExcelJS.Buffer)
    const resumen = workbook.getWorksheet('Resumen')!
    const detalle = workbook.getWorksheet('Detalle')!
    expect(resumen.rowCount).toBe(2) // header + Danery only
    expect(resumen.getRow(2).values).toEqual([undefined, 'Danery', 400, 0, 400, 400, 0])
    expect(detalle.getRow(2).values).toEqual([
      undefined,
      'Danery',
      'Me debe',
      'Iphone 16',
      '3/12',
      'set 2026',
      500,
      100,
      400,
      'Abonado',
      'Vencida',
      'PEN',
    ])
  })

  it('should build the PDF of everyone', async () => {
    const file = await service.debts(ReportFormat.PDF)

    expect(file.filename).toMatch(/^deudas-todas-.*\.pdf$/)
    expect(file.mimeType).toBe('application/pdf')
    expect(file.data.subarray(0, 5).toString()).toBe('%PDF-')
    expect(mockDebts.list).toHaveBeenCalledWith(expect.objectContaining({ personId: undefined }))
  })

  it('should keep one direction and payment month, and leave paid installments out (Cobros, D114)', async () => {
    mockDebts.list.mockResolvedValue([debt, { ...debt, id: 'paid', status: 'paid' }])

    await service.debts(ReportFormat.XLSX, undefined, { direction: DebtDirection.OWED_TO_ME, month: 9, year: 2026 })

    expect(mockDebts.list).toHaveBeenCalledWith(
      expect.objectContaining({ personId: undefined, direction: 'owed_to_me', month: 9, year: 2026 }),
    )
    expect(mockDebts.summary).not.toHaveBeenCalled()
  })
  describe('expenses (P18, /exportar)', () => {
    const rows = [
      {
        date: '2026-09-02',
        description: 'Pollo',
        category: 'Comida',
        method: 'Yape',
        amount: 30,
        currency: 'PEN',
        own: 30,
      },
      {
        date: '2026-09-03',
        description: 'Taxi',
        category: null,
        method: null,
        amount: 12.5,
        currency: 'PEN',
        own: 12.5,
      },
      {
        date: '2026-09-05',
        description: 'Cena',
        category: 'Comida',
        method: 'CMR',
        amount: 80,
        currency: 'PEN',
        own: 40,
      },
    ]

    it('should write the charges and the total by category in an Excel with the name of the month', async () => {
      const file = await service.expenses(ReportFormat.XLSX, { month: 9, year: 2026 }, rows)

      expect(file.filename).toBe('gastos-2026-09.xlsx')
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(file.data as unknown as ArrayBuffer)
      const summary = workbook.getWorksheet('Por categoría')!
      expect(summary.getRow(2).values).toEqual([undefined, 'Comida', 70])
      expect(summary.getRow(3).values).toEqual([undefined, 'Sin categoría', 12.5])
      expect(summary.getRow(4).values).toEqual([undefined, 'Total', 82.5])
      expect(workbook.getWorksheet('Gastos')!.rowCount).toBe(5) // header + 3 charges + total
    })

    it('should write a PDF', async () => {
      const file = await service.expenses(ReportFormat.PDF, { month: 9, year: 2026 }, rows)

      expect(file.filename).toBe('gastos-2026-09.pdf')
      expect(file.data.subarray(0, 4).toString()).toBe('%PDF')
    })
  })
})
