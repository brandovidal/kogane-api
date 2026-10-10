import { Injectable } from '@nestjs/common'

import { PersonSummaryStatus } from '@/commons/constants/debt.constant'
import { JsonHelper } from '@/commons/helpers/json.helper'
import { PrismaService } from '@/db/prisma/prisma.service'
import { requireUserId } from '@/db/tenant/tenant-context'
import { PersonSummary } from '@/generated/prisma/client'

import { toCatalogError } from '../catalog-error.helper'

export interface SummaryAdjustment {
  description: string
  amount: number // positive: they owe more; negative: less
}

export type PersonSummaryDbDto = Omit<PersonSummary, 'adjustments'> & { adjustments: SummaryAdjustment[] }

export interface PersonSummaryWriteDbDto {
  status?: PersonSummaryStatus
  cutoffDate?: Date | null
  collectBy?: Date | null
  note?: string | null
  adjustments?: SummaryAdjustment[]
}

const toDto = (row: PersonSummary): PersonSummaryDbDto => ({
  ...row,
  adjustments: JsonHelper.parseArray<SummaryAdjustment>(row.adjustments),
})

// exp_person_summaries: what the user decides about each person's month in Resumen (status, dates, note, adjustments)
@Injectable()
export class PersonSummaryDBRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByMonth(month: number, year: number): Promise<PersonSummaryDbDto[]> {
    return (await this.prisma.personSummary.findMany({ where: { month, year } })).map(toDto)
  }

  async upsert(personId: string, month: number, year: number, data: PersonSummaryWriteDbDto) {
    const { adjustments, ...rest } = data
    const values = { ...rest, ...(adjustments ? { adjustments: JsonHelper.stringify(adjustments) } : {}) }
    try {
      const row = await this.prisma.personSummary.upsert({
        where: { userId_personId_year_month: { userId: requireUserId(), personId, year, month } },
        create: { userId: requireUserId(), personId, month, year, ...values },
        update: values,
      })
      return toDto(row)
    } catch (error) {
      throw toCatalogError(error, 'personSummary', personId)
    }
  }

  // Cambio en masa: the same status for several people of a month, in one transaction
  async setStatus(personIds: string[], month: number, year: number, status: PersonSummaryStatus) {
    const userId = requireUserId()
    try {
      const rows = await this.prisma.$transaction(async (tx) =>
        Promise.all(
          personIds.map((personId) =>
            tx.personSummary.upsert({
              where: { userId_personId_year_month: { userId, personId, year, month } },
              create: { userId, personId, month, year, status },
              update: { status },
            }),
          ),
        ),
      )
      return rows.map(toDto)
    } catch (error) {
      throw toCatalogError(error, 'personSummary')
    }
  }
}
