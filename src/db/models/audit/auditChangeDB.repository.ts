import { Injectable } from '@nestjs/common'

import { AuditChange } from '@/generated/prisma/client'
import { PrismaService } from '@/db/prisma/prisma.service'

export interface AuditChangeFilter {
  entity?: string
  entities?: string[]
  entityId?: string
  source?: string
  from?: Date
  to?: Date // inclusive: the whole day
}

// Read side of the history (P29): the triggers write aud_changes, nothing in the app does. The tenant extension scopes
// this table by userId, just like the people, expense and budget tables.
@Injectable()
export class AuditChangeDBRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findPage(
    filter: AuditChangeFilter,
    page: number,
    pageSize: number,
  ): Promise<{ rows: AuditChange[]; total: number }> {
    const where = {
      ...(filter.entity ? { entity: filter.entity } : filter.entities ? { entity: { in: filter.entities } } : {}),
      ...(filter.entityId ? { entityId: filter.entityId } : {}),
      ...(filter.source ? { source: filter.source } : {}),
      ...(filter.from || filter.to
        ? {
            createdAt: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.to ? { lt: new Date(filter.to.getTime() + 24 * 60 * 60_000) } : {}),
            },
          }
        : {}),
    }
    const [rows, total] = await Promise.all([
      this.prisma.auditChange.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.auditChange.count({ where }),
    ])
    return { rows, total }
  }

  // Names of the catalog rows a change points to (personId → "Brando"), for the labels of the timeline
  async namesOf(
    model: 'person' | 'category' | 'paymentMethod' | 'budgetGroup' | 'commitment' | 'account',
    ids: string[],
  ) {
    if (!ids.length) return []
    const delegate = this.prisma[model] as unknown as {
      findMany(args: unknown): Promise<{ id: string; name: string }[]>
    }
    return delegate.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
  }

  // The current name of rows that still exist, one query per table (table and column come from constants)
  async titlesOf(
    table: string,
    column: string,
    idColumn: string,
    ids: string[],
  ): Promise<{ id: string; title: string | null }[]> {
    if (!ids.length) return []
    const marks = ids.map(() => '?').join(', ')
    const rows = await this.prisma.$queryRawUnsafe<{ id: string; title: string | null }[]>(
      `SELECT "${idColumn}" AS id, "${column}" AS title FROM "${table}" WHERE "${idColumn}" IN (${marks})`,
      ...ids,
    )
    return rows
  }
}
