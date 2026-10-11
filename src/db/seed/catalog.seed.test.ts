import { describe, expect, it, vi } from 'vitest'

import { PaymentMethodType } from '@/commons/constants/catalog.constant'
import { PrismaClient } from '@/generated/prisma/client'

import { BASE_PAYMENT_METHODS, CATEGORIES, BUDGET_GROUPS } from './catalog.seed.data'
import { seedBasePaymentMethods } from './catalog.seed'

function makePrisma(existing: string[] = []) {
  const create = vi.fn().mockResolvedValue({})
  const findFirst = vi.fn(({ where }: { where: { name: string } }) =>
    Promise.resolve(existing.includes(where.name) ? { id: 'x' } : null),
  )
  return { prisma: { paymentMethod: { findFirst, create } } as unknown as PrismaClient, create, findFirst }
}

describe('seedBasePaymentMethods', () => {
  it('creates every base method for the user, with credit cards inactive and without billing days', async () => {
    const { prisma, create } = makePrisma()

    await seedBasePaymentMethods(prisma, 'user-1')

    expect(create).toHaveBeenCalledTimes(BASE_PAYMENT_METHODS.length)
    const rows = create.mock.calls.map(([arg]) => arg.data)
    expect(rows.every((row) => row.userId === 'user-1')).toBe(true)
    for (const row of rows.filter((r) => r.type === PaymentMethodType.CREDIT_CARD)) {
      expect(row.isActive).toBe(false)
      expect(row.billingCloseDay).toBeUndefined()
      expect(row.code).toBeTruthy()
    }
    for (const row of rows.filter((r) => r.type !== PaymentMethodType.CREDIT_CARD)) {
      expect(row.isActive).toBe(true)
    }
  })

  it('never touches a method the user already has (name scoped to the user)', async () => {
    const { prisma, create, findFirst } = makePrisma(['CMR', 'Yape'])

    await seedBasePaymentMethods(prisma, 'user-1')

    expect(findFirst).toHaveBeenCalledWith({ where: { userId: 'user-1', name: 'CMR' } })
    expect(create).toHaveBeenCalledTimes(BASE_PAYMENT_METHODS.length - 2)
  })
})

describe('base catalog data', () => {
  it('has unique names and credit cards need a code', () => {
    const names = BASE_PAYMENT_METHODS.map((m) => m.name)
    expect(new Set(names).size).toBe(names.length)
    expect(BASE_PAYMENT_METHODS.filter((m) => m.type === PaymentMethodType.CREDIT_CARD).every((m) => m.code)).toBe(true)
  })

  it('assigns every category to an existing budget group', () => {
    const groups = new Set(BUDGET_GROUPS.map((g) => g.name))
    expect(CATEGORIES.every((c) => groups.has(c.budgetGroup))).toBe(true)
    expect(new Set(CATEGORIES.map((c) => c.name)).size).toBe(CATEGORIES.length)
  })
})
