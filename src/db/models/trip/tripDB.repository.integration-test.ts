import { ConfigService } from '@nestjs/config'

import { PrismaService } from '@/db/prisma/prisma.service'

import { TripDBRepository } from './tripDB.repository'

// /viaje (P18): one trip open at a time, and the expenses saved meanwhile add up by category, your part in soles
describe('TripDBRepository (integration)', () => {
  let prisma: PrismaService
  let repository: TripDBRepository
  let personId: string
  let categoryId: string
  let paymentMethodId: string
  const suffix = Date.now()

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ db: { url: process.env.DATABASE_URL ?? 'file:./test.db' } }))
    await prisma.onModuleInit()
    repository = new TripDBRepository(prisma)
    personId = (await prisma.person.create({ data: { name: `Trip Person ${suffix}`, isActive: false } })).id
    categoryId = (await prisma.category.create({ data: { name: `Trip Category ${suffix}` } })).id
    paymentMethodId = (
      await prisma.paymentMethod.create({ data: { name: `Trip Wallet ${suffix}`, type: 'wallet', isActive: false } })
    ).id
    await prisma.trip.deleteMany({})
  })

  afterAll(async () => {
    await prisma.dailyExpense.deleteMany({ where: { personId } })
    await prisma.trip.deleteMany({})
    await prisma.paymentMethod.delete({ where: { id: paymentMethodId } })
    await prisma.category.delete({ where: { id: categoryId } })
    await prisma.person.delete({ where: { id: personId } })
    await prisma.onModuleDestroy()
  })

  it('should keep one trip open: a new one closes the previous', async () => {
    const lima = await repository.start('Lima')
    expect((await repository.findActive())?.id).toBe(lima.id)

    const cusco = await repository.start('Cusco')

    expect((await repository.findActive())?.id).toBe(cusco.id)
    expect((await prisma.trip.findUnique({ where: { id: lima.id } }))?.endedAt).not.toBeNull()
  })

  it('should add up what was tagged: your part in soles, by category, ignoring other currencies', async () => {
    const trip = (await repository.findActive())!
    const expense = (amount: number, extra: Record<string, unknown> = {}) =>
      prisma.dailyExpense.create({
        data: {
          description: 'Gasto',
          amount,
          spentAt: new Date(),
          personId,
          paymentMethodId,
          categoryId,
          tripId: trip.id,
          ...extra,
        },
      })
    await expense(100)
    await expense(60, { othersShare: 20 })
    await expense(50, { currency: 'USD' })
    await prisma.dailyExpense.create({
      data: { description: 'Fuera del viaje', amount: 999, spentAt: new Date(), personId, paymentMethodId, categoryId },
    })

    const totals = await repository.totals(trip.id)

    expect(totals).toEqual({ total: 140, count: 3, byCategory: [{ categoryId, total: 140 }] })
  })

  it('should end the open trip once, and answer null when there is none', async () => {
    expect((await repository.end())?.endedAt).not.toBeNull()
    expect(await repository.end()).toBeNull()
    expect(await repository.findActive()).toBeNull()
  })
})
