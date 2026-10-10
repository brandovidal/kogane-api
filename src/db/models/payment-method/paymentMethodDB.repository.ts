import { Injectable } from '@nestjs/common'

import { Prisma } from '@/generated/prisma/client'
import { PrismaService } from '@/db/prisma/prisma.service'
import { requireUserId } from '@/db/tenant/tenant-context'
import { PaymentMethodType } from '@/commons/constants/catalog.constant'
import { JsonHelper } from '@/commons/helpers/json.helper'

import { toCatalogError } from '../catalog-error.helper'

import { PaymentMethodDbDto, PaymentMethodWriteDbDto } from './paymentMethodDB.dto'
import { PaymentMethodDBSerializer } from './paymentMethodDB.serializer'

@Injectable()
export class PaymentMethodDBRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly serializer: PaymentMethodDBSerializer,
  ) {}

  // Catalog injected into the AI prompt (all active methods; showInBot only filters the quick replies)
  async findActive(): Promise<PaymentMethodDbDto[]> {
    const paymentMethods = await this.prisma.paymentMethod.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    })
    return this.serializer.toDtoArray(paymentMethods)
  }

  async findById(id: string): Promise<PaymentMethodDbDto | null> {
    const paymentMethod = await this.prisma.paymentMethod.findUnique({ where: { id } })
    return paymentMethod ? this.serializer.toDto(paymentMethod) : null
  }

  // A payment method typed in the bot that did not exist yet
  async create(name: string, type: PaymentMethodType): Promise<PaymentMethodDbDto> {
    const paymentMethod = await this.prisma.paymentMethod.upsert({
      where: { userId_name: { userId: requireUserId(), name } },
      create: {
        userId: requireUserId(),
        name,
        type,
        aliases: JsonHelper.stringify([name.toLowerCase()]),
        showInBot: true,
      },
      update: { isActive: true },
    })
    return this.serializer.toDto(paymentMethod)
  }

  async updateBillingDays(id: string, billingCloseDay: number, paymentDueDay: number): Promise<PaymentMethodDbDto> {
    const paymentMethod = await this.prisma.paymentMethod.update({
      where: { id },
      data: { billingCloseDay, paymentDueDay },
    })
    return this.serializer.toDto(paymentMethod)
  }

  // kogane-app (P7): every payment method, active or not
  async findAll(): Promise<PaymentMethodDbDto[]> {
    const paymentMethods = await this.prisma.paymentMethod.findMany({ orderBy: [{ type: 'asc' }, { name: 'asc' }] })
    return this.serializer.toDtoArray(paymentMethods)
  }

  async createFull(data: PaymentMethodWriteDbDto): Promise<PaymentMethodDbDto> {
    try {
      const paymentMethod = await this.prisma.paymentMethod.create({
        data: this.toData(data) as Prisma.PaymentMethodCreateInput,
      })
      return this.serializer.toDto(paymentMethod)
    } catch (error) {
      throw toCatalogError(error, 'paymentMethod')
    }
  }

  async update(id: string, data: Partial<PaymentMethodWriteDbDto>): Promise<PaymentMethodDbDto> {
    try {
      const paymentMethod = await this.prisma.paymentMethod.update({ where: { id }, data: this.toData(data) })
      return this.serializer.toDto(paymentMethod)
    } catch (error) {
      throw toCatalogError(error, 'paymentMethod', id)
    }
  }

  // I12: the password that opens the statement PDFs of a card (null removes it)
  async setStatementPassword(id: string, password: string | null): Promise<PaymentMethodDbDto> {
    try {
      const paymentMethod = await this.prisma.paymentMethod.update({
        where: { id },
        data: { statementPassword: password },
      })
      return this.serializer.toDto(paymentMethod)
    } catch (error) {
      throw toCatalogError(error, 'paymentMethod', id)
    }
  }

  // Only for opening statement PDFs: the saved passwords, the chosen card first
  async findStatementPasswords(): Promise<{ id: string; password: string }[]> {
    const rows = await this.prisma.paymentMethod.findMany({
      where: { statementPassword: { not: null } },
      select: { id: true, statementPassword: true },
    })
    return rows.map((row) => ({ id: row.id, password: row.statementPassword! }))
  }

  // Expenses point to payment methods: they are deactivated, never deleted
  async deactivate(id: string): Promise<PaymentMethodDbDto> {
    return this.update(id, { isActive: false, showInBot: false })
  }

  private toData({ aliases, ...rest }: Partial<PaymentMethodWriteDbDto>) {
    return {
      ...rest,
      ...(aliases ? { aliases: JsonHelper.stringify(aliases.map((alias) => alias.toLowerCase())) } : {}),
    }
  }
}
