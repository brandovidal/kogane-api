import { Injectable } from '@nestjs/common'

import { Account } from '@/generated/prisma/client'
import { PrismaService } from '@/db/prisma/prisma.service'

import { toCatalogError } from '../catalog-error.helper'

export interface AccountWriteDbDto {
  name: string
  type: string // AccountType
  bank?: string | null
  currency?: string
  color?: string | null
  isActive?: boolean
}

// Cuentas de salida: the catalog of where payments leave from. No balance: it only says which account was used
@Injectable()
export class AccountDBRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<Account[]> {
    return this.prisma.account.findMany({ orderBy: [{ isActive: 'desc' }, { name: 'asc' }] })
  }

  async findById(id: string): Promise<Account | null> {
    return this.prisma.account.findUnique({ where: { id } })
  }

  async create(data: AccountWriteDbDto): Promise<Account> {
    try {
      return await this.prisma.account.create({ data })
    } catch (error) {
      throw toCatalogError(error, 'account')
    }
  }

  async update(id: string, data: Partial<AccountWriteDbDto>): Promise<Account> {
    try {
      return await this.prisma.account.update({ where: { id }, data })
    } catch (error) {
      throw toCatalogError(error, 'account', id)
    }
  }

  // Payments point to accounts: they are deactivated, never deleted
  async deactivate(id: string): Promise<Account> {
    return this.update(id, { isActive: false })
  }
}
