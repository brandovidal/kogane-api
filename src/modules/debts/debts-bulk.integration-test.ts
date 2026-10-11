import { ConfigService } from '@nestjs/config'

import { PrismaService } from '@/db/prisma/prisma.service'
import { PaymentMethodType } from '@/commons/constants/catalog.constant'
import { DebtDirection, DebtPaymentKind, DebtStatus } from '@/commons/constants/debt.constant'
import { DebtDBRepository } from '@/db/models/debt/debtDB.repository'
import { StatementDBRepository } from '@/db/models/statement/statementDB.repository'

import { DebtsService } from './debts.service'
import { DebtBulkAction } from './validations/debts.validation'

const PERSON = 'Bulk Cobros'
const CARD = 'Bulk CMR'

// P30 against SQLite: bulk actions and the card check (D114, D115). Catalogs are created inactive and removed at the
// end: recorded AI answers pick catalog entries by position (conversation integration test)
describe('Cobros: bulk actions and card check (integration)', () => {
  let prisma: PrismaService
  let service: DebtsService
  let personId: string
  let cardId: string

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ db: { url: process.env.DATABASE_URL ?? 'file:./test.db' } }))
    await prisma.onModuleInit()
    service = new DebtsService(new DebtDBRepository(prisma), new StatementDBRepository(prisma))
    personId = (await prisma.person.create({ data: { name: PERSON, isActive: false } })).id
    cardId = (
      await prisma.paymentMethod.create({
        data: { name: CARD, type: PaymentMethodType.CREDIT_CARD, isActive: false, showInBot: false },
      })
    ).id
  })

  afterAll(async () => {
    await prisma.statement.deleteMany({ where: { paymentMethodId: cardId } })
    await prisma.creditCardExpense.deleteMany({ where: { paymentMethodId: cardId } })
    await prisma.debt.deleteMany({ where: { personId } })
    await prisma.paymentMethod.delete({ where: { id: cardId } })
    await prisma.person.delete({ where: { id: personId } })
    await prisma.onModuleDestroy()
  })

  const debt = (description: string, amount: number, paymentMonth: number) =>
    prisma.debt.create({
      data: {
        direction: DebtDirection.OWED_TO_ME,
        description,
        amount,
        personId,
        paymentMethodId: cardId,
        paymentMonth,
        paymentYear: 2031,
      },
    })

  it('should spread an abono, pay with cashback, reset, clone and delete with confirmation of payments', async () => {
    const [august, september] = [await debt('Zapatillas 1/2', 150, 8), await debt('Zapatillas 2/2', 150, 9)]
    const ids = [august.id, september.id]

    const abono = await service.bulk({ ids, action: DebtBulkAction.PARTIAL, amount: 200 })
    expect(abono).toEqual(expect.objectContaining({ affected: 2, paid: 200, excess: 0 }))
    expect(abono.paymentIds).toHaveLength(2)
    const afterAbono = await service.list({ personId, year: 2031 })
    // paid today, before its month of 2031: Amortizado (D60)
    expect(afterAbono.map((row) => [row.status, row.balance])).toEqual([
      [DebtStatus.PREPAID, 0],
      [DebtStatus.PARTIAL, 100],
    ])

    await service.bulk({ ids, action: DebtBulkAction.CASHBACK })
    const [, closed] = await service.list({ personId, month: 9, year: 2031, until: true })
    expect(closed.status).toBe(DebtStatus.CASHBACK)
    expect((await service.get(closed.id)).payments.map((payment) => payment.kind)).toEqual([
      DebtPaymentKind.PARTIAL,
      DebtPaymentKind.CASHBACK,
    ])

    await service.bulk({ ids: [closed.id], action: DebtBulkAction.RESET })
    expect((await service.get(closed.id)).status).toBe(DebtStatus.PENDING)

    const cloned = await service.bulk({ ids, action: DebtBulkAction.CLONE, month: 12, year: 2031 })
    expect(cloned.affected).toBe(2)
    expect((await service.list({ personId, month: 12, year: 2031 })).map((row) => row.paymentMethodId)).toEqual([
      cardId,
      cardId,
    ])

    const kept = await service.bulk({ ids, action: DebtBulkAction.DELETE })
    expect(kept).toEqual(expect.objectContaining({ affected: 1, skipped: [august.id] }))
  })

  it('should contrast the card debts of a month with its statement and find interest lines of the next one', async () => {
    await debt('Televisor 1/6', 300, 10)
    await prisma.creditCardExpense.create({
      data: {
        description: 'Televisor',
        amount: 1800,
        personId,
        paymentMethodId: cardId,
        paymentMonth: 10,
        paymentYear: 2031,
      },
    })
    await prisma.statement.create({
      data: { paymentMethodId: cardId, paymentMonth: 10, paymentYear: 2031, totalDue: 1830, source: 'template' },
    })
    await prisma.statement.create({
      data: {
        paymentMethodId: cardId,
        paymentMonth: 11,
        paymentYear: 2031,
        totalDue: 40,
        source: 'template',
        rows: { create: [{ description: 'INTERES COMPENSATORIO', amount: 22.5, currency: 'PEN', result: 'new' }] },
      },
    })

    const check = await service.cardCheck({ paymentMethodId: cardId, month: 10, year: 2031 })

    expect(check).toEqual(
      expect.objectContaining({
        statementTotal: 1830,
        koganeTotal: 1800,
        unexplained: 30,
        othersOwed: 300,
        possibleInterest: [{ description: 'INTERES COMPENSATORIO', amount: 22.5 }],
      }),
    )
  })
})
