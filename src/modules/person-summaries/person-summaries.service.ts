import { Injectable } from '@nestjs/common'

import { CatalogItemNotFoundException } from '@/commons/exceptions/catalog/catalog-item-not-found.exception'
import { toCents } from '@/commons/constants/debt.constant'
import { PersonDBRepository } from '@/db/models/person/personDB.repository'
import { PersonSummaryDBRepository, PersonSummaryDbDto } from '@/db/models/person-summary/personSummaryDB.repository'

import { BulkPersonSummaryStatusDto, SavePersonSummaryDto } from './dto/request/person-summaries.dto'

const withTotal = (row: PersonSummaryDbDto) => ({
  ...row,
  adjustmentTotal: toCents(row.adjustments.reduce((sum, item) => sum + item.amount, 0)),
})

// Resumen by person (boards ResSheet, ResEstado*, ResMasivas): the status of each person's month, its dates, note and
// manual adjustments. The amounts themselves always come from the debts (GET /v1/debts/summary)
@Injectable()
export class PersonSummariesService {
  constructor(
    private readonly personSummaryDBRepository: PersonSummaryDBRepository,
    private readonly personDBRepository: PersonDBRepository,
  ) {}

  async list(month: number, year: number) {
    return (await this.personSummaryDBRepository.findByMonth(month, year)).map(withTotal)
  }

  async save(personId: string, { month, year, ...data }: SavePersonSummaryDto) {
    await this.assertPeople([personId])
    return withTotal(await this.personSummaryDBRepository.upsert(personId, month, year, data))
  }

  async setStatus({ month, year, personIds, status }: BulkPersonSummaryStatusDto) {
    const unique = [...new Set(personIds)]
    await this.assertPeople(unique)
    return (await this.personSummaryDBRepository.setStatus(unique, month, year, status)).map(withTotal)
  }

  private async assertPeople(ids: string[]) {
    const known = new Set((await this.personDBRepository.findAll()).map((person) => person.id))
    const missing = ids.filter((id) => !known.has(id))
    if (missing.length) throw new CatalogItemNotFoundException({ entity: 'person', id: missing.join(',') })
  }
}
