import { Injectable } from '@nestjs/common'

import { MerchantRule } from '@/generated/prisma/client'
import { PrismaService } from '@/db/prisma/prisma.service'

// Rules learned from corrections (P18, D129): one per merchant
@Injectable()
export class MerchantRuleDBRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<MerchantRule[]> {
    return this.prisma.merchantRule.findMany({ orderBy: { updatedAt: 'desc' } })
  }

  // Creates the rule or updates it: a field that is not given keeps what it had
  async learn(
    merchant: string,
    { categoryId, paymentMethodId }: { categoryId?: string; paymentMethodId?: string },
  ): Promise<MerchantRule> {
    const existing = await this.prisma.merchantRule.findFirst({ where: { merchant } })
    const data = {
      ...(categoryId ? { categoryId } : {}),
      ...(paymentMethodId ? { paymentMethodId } : {}),
    }
    return existing
      ? this.prisma.merchantRule.update({ where: { id: existing.id }, data })
      : this.prisma.merchantRule.create({ data: { merchant, ...data } })
  }

  // Whether it existed (the button of a rule already deleted answers "ya no está")
  async delete(id: string): Promise<boolean> {
    const { count } = await this.prisma.merchantRule.deleteMany({ where: { id } })
    return count > 0
  }
}
