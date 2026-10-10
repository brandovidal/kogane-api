import { ConfigService } from '@nestjs/config'

import { DebtDirection, DebtStatus } from '@/commons/constants/debt.constant'
import { DebtNotFoundException } from '@/commons/exceptions/debt/debt-not-found.exception'
import { PrismaService } from '@/db/prisma/prisma.service'

import { DebtDBRepository } from './debtDB.repository'

// Payments recompute paidAmount and status in the same transaction (P17, D60)
describe('DebtDBRepository (integration)', () => {
  let prisma: PrismaService
  let repository: DebtDBRepository
  let personId: string

  const installment = (overrides: Record<string, unknown> = {}) => ({
    direction: DebtDirection.OWED_TO_ME,
    description: 'Iphone 16',
    amount: 400,
    personId,
    paymentMonth: 9,
    paymentYear: 2032,
    ...overrides,
  })

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ db: { url: process.env.DATABASE_URL ?? 'file:./test.db' } }))
    await prisma.onModuleInit()
    repository = new DebtDBRepository(prisma)
    personId = (await prisma.person.create({ data: { name: `Debt Person ${Date.now()}` } })).id
  })

  afterAll(async () => {
    // Out of the catalog again: conversation flows replay AI answers that point to catalog refs by position
    await prisma.debt.deleteMany({ where: { personId } })
    await prisma.person.delete({ where: { id: personId } })
    await prisma.onModuleDestroy()
  })

  it('should create every installment in one transaction, oldest first when listed', async () => {
    const created = await repository.createMany([
      installment({ installment: '2/2', paymentMonth: 10, description: 'Laptop' }),
      installment({ installment: '1/2', description: 'Laptop' }),
    ])

    expect(created).toHaveLength(2)
    const open = await repository.findOpen({ personId, direction: DebtDirection.OWED_TO_ME })
    expect(open.filter((debt) => debt.description === 'Laptop').map((debt) => debt.installment)).toEqual(['1/2', '2/2'])
    expect(open[0].person.id).toBe(personId)
  })

  it('should follow the confirmed payments: partial, paid, and back when a payment is deleted', async () => {
    const [debt] = await repository.createMany([installment({ description: 'Pagos' })])

    const partial = await repository.addPayment({
      debtId: debt.id,
      amount: 150,
      paidAt: new Date('2032-09-10T15:00:00Z'),
    })
    expect(partial).toMatchObject({ paidAmount: 150, status: DebtStatus.PARTIAL })

    const paid = await repository.addPayment({ debtId: debt.id, amount: 250, paidAt: new Date('2032-09-20T15:00:00Z') })
    expect(paid).toMatchObject({ paidAmount: 400, status: DebtStatus.PAID, paidDate: new Date('2032-09-20T15:00:00Z') })

    const { payments } = await repository.findById(debt.id)
    const reopened = await repository.deletePayment(debt.id, payments[1].id)
    expect(reopened).toMatchObject({ paidAmount: 150, status: DebtStatus.PARTIAL })
  })

  it('should mark a debt paid before its month as prepaid (Amortizado)', async () => {
    const [debt] = await repository.createMany([installment({ description: 'Adelanto', paymentMonth: 12 })])

    const prepaid = await repository.addPayment({
      debtId: debt.id,
      amount: 400,
      paidAt: new Date('2032-10-05T15:00:00Z'),
    })

    expect(prepaid.status).toBe(DebtStatus.PREPAID)
  })

  it('should count a bot proposal only after it is confirmed', async () => {
    const [first, second] = await repository.createMany([
      installment({ description: 'Propuesta', installment: '1/2' }),
      installment({ description: 'Propuesta', installment: '2/2', paymentMonth: 10 }),
    ])
    const allocations = [
      { debtId: first.id, amount: 400 },
      { debtId: second.id, amount: 100 },
    ]

    await repository.replaceProposal('batch-integration-1', allocations, new Date(), null)
    expect((await repository.findById(first.id)).paidAmount).toBe(0)
    expect(await repository.findProposal('batch-integration-1')).toHaveLength(2)

    const updated = await repository.confirmProposal('batch-integration-1')

    expect(updated.map(({ id, paidAmount, status }) => ({ id, paidAmount, status }))).toEqual(
      expect.arrayContaining([
        // paid today for an installment of 2032: ahead of its month
        { id: first.id, paidAmount: 400, status: DebtStatus.PREPAID },
        { id: second.id, paidAmount: 100, status: DebtStatus.PARTIAL },
      ]),
    )
    // Confirmed: no longer a proposal, and a second press confirms nothing
    expect(await repository.findProposal('batch-integration-1')).toEqual([])
    await expect(repository.confirmProposal('batch-integration-1')).resolves.toEqual([])
    expect((await repository.findById(first.id)).payments).toHaveLength(1)
  })

  it('should replace a proposal (✏️ Elegir cuota) and ignore it once expired', async () => {
    const [debt] = await repository.createMany([installment({ description: 'Expira' })])

    await repository.replaceProposal('batch-integration-2', [{ debtId: debt.id, amount: 100 }], new Date(), null)
    await repository.replaceProposal('batch-integration-2', [{ debtId: debt.id, amount: 300 }], new Date(), null)
    const [proposal] = await repository.findProposal('batch-integration-2')
    expect(proposal).toMatchObject({ amount: 300, debt: { id: debt.id } })

    // 31 minutes later the buttons do nothing
    await expect(repository.findProposal('batch-integration-2', new Date(Date.now() + 31 * 60_000))).resolves.toEqual(
      [],
    )

    await repository.discardProposal('batch-integration-2')
    await expect(prisma.debtPayment.count({ where: { batchId: 'batch-integration-2' } })).resolves.toBe(0)
  })

  it('should delete an installment with its payments and report a missing one', async () => {
    const [debt] = await repository.createMany([installment({ description: 'Borrar' })])
    await repository.addPayment({ debtId: debt.id, amount: 50, paidAt: new Date() })

    await repository.delete(debt.id)

    await expect(prisma.debtPayment.count({ where: { debtId: debt.id } })).resolves.toBe(0)
    await expect(repository.findById(debt.id)).rejects.toThrow(DebtNotFoundException)
    await expect(repository.delete(debt.id)).rejects.toThrow(DebtNotFoundException)
  })

  it('should carry open installments of earlier months to the target month, remembering only the first origin', async () => {
    const description = `Arrastre ${Date.now()}`
    const [august, september, paid] = await repository.createMany([
      installment({ description, paymentMonth: 8 }),
      installment({ description, paymentMonth: 9 }),
      installment({ description, paymentMonth: 7 }),
    ])
    await repository.addPayment({ debtId: paid.id, amount: 400, paidAt: new Date('2032-07-10T15:00:00Z') })

    const carryable = (await repository.findCarryable({ month: 10, year: 2032 }, { personId })).filter(
      (debt) => debt.description === description,
    )
    expect(carryable.map((debt) => debt.id)).toEqual([august.id, september.id])

    await repository.carryOver(carryable, { month: 10, year: 2032 })
    const moved = await prisma.debt.findUniqueOrThrow({ where: { id: august.id } })
    expect(moved).toMatchObject({ paymentMonth: 10, paymentYear: 2032, carriedFromMonth: 8, carriedFromYear: 2032 })

    await repository.carryOver([moved], { month: 11, year: 2032 })
    expect(await prisma.debt.findUniqueOrThrow({ where: { id: august.id } })).toMatchObject({
      paymentMonth: 11,
      carriedFromMonth: 8,
    })
  })
})
