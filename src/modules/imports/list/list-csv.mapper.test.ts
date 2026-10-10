import { DebtDirection } from '@/commons/constants/debt.constant'
import { SubscriptionKind, SubscriptionPeriod } from '@/commons/constants/expense.constant'

import { parseCsv } from '../notion/notion-csv'
import { ListImportTarget, mapListRow, paymentMonthOf } from './list-csv.mapper'

const catalogs = {
  people: [
    { id: 'me', name: 'Brando' },
    { id: 'dany', name: 'Danery', aliases: ['dany'] },
  ],
  paymentMethods: [
    { id: 'yape', name: 'Yape' },
    { id: 'io', name: 'Visa IO', aliases: ['io'] },
  ],
  categories: [{ id: 'food', name: 'Alimentación' }],
  defaultPersonId: 'me',
}

const firstRow = (csv: string) => parseCsv(csv).rows[0]

describe('list-csv.mapper', () => {
  it('should read a day-to-day expense with Spanish headers, the owner by default', () => {
    const row = firstRow(
      'Descripción,Monto,Fecha,Medio de pago,Categoría\nAlmuerzo,"S/ 12.00",02/10/2026,Yape,alimentacion',
    )
    expect(mapListRow(ListImportTarget.DAILY, row, catalogs)).toEqual({
      line: 2,
      description: 'Almuerzo',
      amount: 12,
      issues: [],
      body: expect.objectContaining({
        description: 'Almuerzo',
        amount: 12,
        currency: 'PEN',
        personId: 'me',
        spentAt: '2026-10-02',
        paymentMethodId: 'yape',
        categoryId: 'food',
      }),
    })
  })

  it('should list every problem of a row in Spanish and give no body', () => {
    const row = firstRow('Description,Amount,Date,Payment method,Person\nTaxi,0,,Plin,Nadie')
    const mapped = mapListRow(ListImportTarget.DAILY, row, catalogs)
    expect(mapped.body).toBeNull()
    expect(mapped.issues).toEqual([
      'Falta el monto o no es mayor a 0',
      'No existe la persona «Nadie»',
      'No existe el medio de pago «Plin»',
      'Falta la fecha (DD/MM/AAAA o AAAA-MM-DD)',
      'Falta el medio de pago',
    ])
  })

  it('should read a platform with its payment month and period', () => {
    const row = firstRow(
      'Descripción,Monto,Moneda,Mes de pago,Frecuencia,Medio de pago\nNetflix,24.99,USD,10/2026,Mensual,io',
    )
    expect(mapListRow(ListImportTarget.PLATFORMS, row, catalogs).body).toEqual(
      expect.objectContaining({
        currency: 'USD',
        paymentMonth: 10,
        paymentYear: 2026,
        period: SubscriptionPeriod.MONTHLY,
        kind: SubscriptionKind.PLATFORM,
        paymentMethodId: 'io',
      }),
    )
  })

  it('should need the person of a cobro and read its installment', () => {
    const withPerson = firstRow('Descripción,Monto,Mes de pago,Persona,Cuota\nStream,74.57,Octubre 2026,dany,2/3')
    expect(mapListRow(ListImportTarget.RECEIVABLES, withPerson, catalogs).body).toEqual(
      expect.objectContaining({
        direction: DebtDirection.OWED_TO_ME,
        personId: 'dany',
        paymentMonth: 10,
        paymentYear: 2026,
        installment: '2/3',
      }),
    )
    const withoutPerson = firstRow('Descripción,Monto,Mes de pago\nPréstamo,200,2026-10')
    expect(mapListRow(ListImportTarget.PAYABLES, withoutPerson, catalogs).issues).toEqual(['Falta la persona'])
  })

  it('should read the payment month as a name, MM/YYYY or YYYY-MM', () => {
    expect(paymentMonthOf('Octubre 2026')).toEqual({ month: 10, year: 2026 })
    expect(paymentMonthOf('10/2026')).toEqual({ month: 10, year: 2026 })
    expect(paymentMonthOf('2026-03')).toEqual({ month: 3, year: 2026 })
    expect(paymentMonthOf('13/2026')).toBeNull()
  })
})
