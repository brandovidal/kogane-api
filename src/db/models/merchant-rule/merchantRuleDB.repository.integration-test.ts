import { ConfigService } from '@nestjs/config'

import { PrismaService } from '@/db/prisma/prisma.service'

import { MerchantRuleDBRepository } from './merchantRuleDB.repository'

// The rules /reglas lists (P18, D129): one per merchant, a correction adds to it without erasing the rest
describe('MerchantRuleDBRepository (integration)', () => {
  let prisma: PrismaService
  let repository: MerchantRuleDBRepository

  beforeAll(async () => {
    prisma = new PrismaService(new ConfigService({ db: { url: process.env.DATABASE_URL ?? 'file:./test.db' } }))
    await prisma.onModuleInit()
    repository = new MerchantRuleDBRepository(prisma)
    await prisma.merchantRule.deleteMany({})
  })

  afterAll(async () => {
    await prisma.merchantRule.deleteMany({})
    await prisma.onModuleDestroy()
  })

  it('should keep one rule per merchant and merge a later correction into it', async () => {
    const first = await repository.learn('almuerzo', { categoryId: 'cat-1' })
    const second = await repository.learn('almuerzo', { paymentMethodId: 'pm-1' })
    await repository.learn('netflix', { categoryId: 'cat-2' })

    expect(second.id).toBe(first.id)
    const rules = await repository.findAll()
    expect(rules).toHaveLength(2)
    expect(rules.find((rule) => rule.merchant === 'almuerzo')).toEqual(
      expect.objectContaining({ categoryId: 'cat-1', paymentMethodId: 'pm-1' }),
    )
  })

  it('should say whether the rule it deleted existed', async () => {
    const [rule] = await repository.findAll()

    expect(await repository.delete(rule.id)).toBe(true)
    expect(await repository.delete(rule.id)).toBe(false)
  })
})
