import { Test, TestingModule } from '@nestjs/testing'
import { vi } from 'vitest'

import { PersonSummaryStatus } from '@/commons/constants/debt.constant'
import { CatalogItemNotFoundException } from '@/commons/exceptions/catalog/catalog-item-not-found.exception'
import { PersonDBRepository } from '@/db/models/person/personDB.repository'
import { PersonSummaryDBRepository } from '@/db/models/person-summary/personSummaryDB.repository'

import { PersonSummariesService } from './person-summaries.service'

const mockSummaries = { findByMonth: vi.fn(), upsert: vi.fn(), setStatus: vi.fn() }
const mockPeople = { findAll: vi.fn() }

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 's1',
  userId: 'u1',
  personId: 'dany',
  month: 10,
  year: 2026,
  status: PersonSummaryStatus.DRAFT,
  cutoffDate: null,
  collectBy: null,
  note: null,
  adjustments: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

describe('PersonSummariesService', () => {
  let service: PersonSummariesService

  beforeEach(async () => {
    vi.clearAllMocks()
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PersonSummariesService,
        { provide: PersonSummaryDBRepository, useValue: mockSummaries },
        { provide: PersonDBRepository, useValue: mockPeople },
      ],
    }).compile()
    service = module.get(PersonSummariesService)
    mockPeople.findAll.mockResolvedValue([{ id: 'dany' }, { id: 'ana' }])
  })

  it('should add the total of the manual adjustments to each person of the month', async () => {
    mockSummaries.findByMonth.mockResolvedValue([
      row({
        adjustments: [
          { description: 'Delivery compartido', amount: 15.5 },
          { description: 'Descuento', amount: -5.25 },
        ],
      }),
    ])
    const [summary] = await service.list(10, 2026)
    expect(summary.adjustmentTotal).toBe(10.25)
  })

  it('should save only what was sent for a known person', async () => {
    mockSummaries.upsert.mockResolvedValue(row({ status: PersonSummaryStatus.IN_PROGRESS }))
    await service.save('dany', { month: 10, year: 2026, status: PersonSummaryStatus.IN_PROGRESS, note: 'Enviado' })
    expect(mockSummaries.upsert).toHaveBeenCalledWith('dany', 10, 2026, {
      status: PersonSummaryStatus.IN_PROGRESS,
      note: 'Enviado',
    })
  })

  it('should refuse a person that does not exist', async () => {
    await expect(service.save('nadie', { month: 10, year: 2026 })).rejects.toBeInstanceOf(CatalogItemNotFoundException)
    await expect(
      service.setStatus({ month: 10, year: 2026, personIds: ['dany', 'nadie'], status: PersonSummaryStatus.PAID }),
    ).rejects.toBeInstanceOf(CatalogItemNotFoundException)
    expect(mockSummaries.upsert).not.toHaveBeenCalled()
    expect(mockSummaries.setStatus).not.toHaveBeenCalled()
  })

  it('should change the status of several people at once, each person once', async () => {
    mockSummaries.setStatus.mockResolvedValue([row(), row({ personId: 'ana' })])
    await service.setStatus({
      month: 10,
      year: 2026,
      personIds: ['dany', 'ana', 'dany'],
      status: PersonSummaryStatus.PAID,
    })
    expect(mockSummaries.setStatus).toHaveBeenCalledWith(['dany', 'ana'], 10, 2026, PersonSummaryStatus.PAID)
  })
})
