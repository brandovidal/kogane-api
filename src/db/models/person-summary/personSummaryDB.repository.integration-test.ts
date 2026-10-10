import { ConfigService } from '@nestjs/config'

import { PersonSummaryStatus } from '@/commons/constants/debt.constant'
import { PrismaService } from '@/db/prisma/prisma.service'

import { PersonSummaryDBRepository } from './personSummaryDB.repository'

// Resumen by person: one row per person and month (per user), saved field by field
describe('PersonSummaryDBRepository (integration)', () => {
  let prisma: PrismaService
  let repository: PersonSummaryDBRepository
  let personId: string
  let otherId: string

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ db: { url: process.env.DATABASE_URL ?? 'file:./test.db' } }))
    await prisma.onModuleInit()
    repository = new PersonSummaryDBRepository(prisma)
    personId = (await prisma.person.create({ data: { name: `Summary Person ${Date.now()}` } })).id
    otherId = (await prisma.person.create({ data: { name: `Summary Other ${Date.now()}` } })).id
  })

  afterAll(async () => {
    await prisma.personSummary.deleteMany({ where: { personId: { in: [personId, otherId] } } })
    await prisma.person.deleteMany({ where: { id: { in: [personId, otherId] } } })
    await prisma.onModuleDestroy()
  })

  it('should create the row of a month on the first save and only change what is sent after', async () => {
    const created = await repository.upsert(personId, 10, 2032, {
      note: 'Enviado por WhatsApp',
      adjustments: [{ description: 'Delivery', amount: 15 }],
    })
    expect(created).toMatchObject({ status: PersonSummaryStatus.DRAFT, note: 'Enviado por WhatsApp' })
    expect(created.adjustments).toEqual([{ description: 'Delivery', amount: 15 }])

    const updated = await repository.upsert(personId, 10, 2032, {
      status: PersonSummaryStatus.IN_PROGRESS,
      collectBy: new Date('2032-11-05T00:00:00Z'),
    })
    expect(updated).toMatchObject({
      id: created.id,
      status: PersonSummaryStatus.IN_PROGRESS,
      note: 'Enviado por WhatsApp',
    })
    expect(updated.adjustments).toHaveLength(1)
  })

  it('should set the same status for several people of a month at once', async () => {
    const rows = await repository.setStatus([personId, otherId], 10, 2032, PersonSummaryStatus.PAID)
    expect(rows.map((row) => row.status)).toEqual([PersonSummaryStatus.PAID, PersonSummaryStatus.PAID])

    const month = (await repository.findByMonth(10, 2032)).filter((row) => [personId, otherId].includes(row.personId))
    expect(month).toHaveLength(2)
  })
})
