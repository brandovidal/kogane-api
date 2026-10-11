import { PrismaClient } from '@/generated/prisma/client'
import { PaymentMethodType } from '@/commons/constants/catalog.constant'
import { JsonHelper } from '@/commons/helpers/json.helper'

import { BASE_PAYMENT_METHODS, BUDGET_GROUPS, CATEGORIES, PAYMENT_METHODS, PEOPLE } from './catalog.seed.data'

export interface CatalogSeedResult {
  people: number
  paymentMethods: number
  budgetGroups: number
  categories: number
}

// What every user starts with (D97): the budget groups, the categories and the base payment methods (credit cards
// come inactive, to turn on). People are their own
export async function seedBaseCatalogs(
  prisma: PrismaClient,
  userId: string,
): Promise<Pick<CatalogSeedResult, 'budgetGroups' | 'categories'>> {
  await seedBasePaymentMethods(prisma, userId)

  const groupIdByName = new Map<string, string>()
  for (const { name, ...group } of BUDGET_GROUPS) {
    const saved = await prisma.budgetGroup.upsert({
      where: { userId_name: { userId, name } },
      create: { userId, name, ...group },
      update: group,
    })
    groupIdByName.set(name, saved.id)
  }

  for (const { name, budgetGroup, ...category } of CATEGORIES) {
    const data = { ...category, isDefault: true, budgetGroupId: groupIdByName.get(budgetGroup) ?? null }
    await prisma.category.upsert({
      where: { userId_name: { userId, name } },
      create: { userId, name, ...data },
      update: data,
    })
  }

  return { budgetGroups: BUDGET_GROUPS.length, categories: CATEGORIES.length }
}

// Created once by name: a card the user already has, edited or turned on, is never touched again
export async function seedBasePaymentMethods(prisma: PrismaClient, userId: string): Promise<number> {
  for (const { name, aliases, showInBot = true, isPrimary = false, ...method } of BASE_PAYMENT_METHODS) {
    const exists = await prisma.paymentMethod.findFirst({ where: { userId, name } })
    if (exists) continue
    await prisma.paymentMethod.create({
      data: {
        userId,
        name,
        ...method,
        aliases: JsonHelper.stringify(aliases),
        isPrimary,
        showInBot,
        isActive: method.type !== PaymentMethodType.CREDIT_CARD,
      },
    })
  }
  return BASE_PAYMENT_METHODS.length
}

// Idempotent: upserts by unique name/code, so it can run again after editing catalog.seed.data.ts.
// Aliases are replaced by the ones in the data file; rows not listed there are left untouched. The people and the
// cards of the file are the owner's (P23): the rest of the users start without them
export async function seedCatalogs(prisma: PrismaClient, userId: string): Promise<CatalogSeedResult> {
  for (const { name, aliases = [], isDefault = false } of PEOPLE) {
    const data = { aliases: JsonHelper.stringify(aliases), isDefault, isActive: true }
    await prisma.person.upsert({
      where: { userId_name: { userId, name } },
      create: { userId, name, ...data },
      update: data,
    })
  }

  // isActive and showInBot are only set on create: what the web turns off (P22) survives every deploy
  for (const { name, aliases, showInBot = true, isPrimary = false, ...method } of PAYMENT_METHODS) {
    const data = { ...method, aliases: JsonHelper.stringify(aliases), isPrimary }
    await prisma.paymentMethod.upsert({
      where: { userId_name: { userId, name } },
      create: { userId, name, ...data, showInBot, isActive: true },
      update: data,
    })
  }

  const base = await seedBaseCatalogs(prisma, userId)
  return { people: PEOPLE.length, paymentMethods: PAYMENT_METHODS.length, ...base }
}
