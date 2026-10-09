import { Test, TestingModule } from '@nestjs/testing'
import { vi } from 'vitest'

import { SubscriptionKind } from '@/commons/constants/expense.constant'
import { ExpenseMoveBlockedException } from '@/commons/exceptions/expense/expense-move-blocked.exception'
import { ExpenseRecordDBRepository, ExpenseResource } from '@/db/models/expense-record/expenseRecordDB.repository'

import { ExpenseMovesService } from './expense-moves.service'

const mockRepository = { findSeries: vi.fn(), moveSeries: vi.fn(), copySeries: vi.fn() }

const row = (
  id: string,
  month: number,
  year = 2026,
  categoryId: string | null = 'cat1',
  draftId: string | null = null,
) => ({
  id,
  categoryId,
  paymentMonth: month,
  paymentYear: year,
  draftId,
})

describe('ExpenseMovesService', () => {
  let service: ExpenseMovesService

  beforeEach(async () => {
    vi.clearAllMocks()
    const module: TestingModule = await Test.createTestingModule({
      providers: [ExpenseMovesService, { provide: ExpenseRecordDBRepository, useValue: mockRepository }],
    }).compile()
    service = module.get(ExpenseMovesService)
    mockRepository.findSeries.mockResolvedValue({
      rows: [row('a', 8), row('b', 9), row('c', 10)],
      templates: 1,
      blockedIds: ['a'],
    })
  })

  const base = {
    resource: ExpenseResource.FIXED_COST,
    id: 'b',
    to: ExpenseResource.SUBSCRIPTION,
    kind: SubscriptionKind.PLATFORM,
  } as const

  it('should only take the rows from the chosen month on', async () => {
    const answer = await service.move({ ...base, mode: 'move', from: { month: 9, year: 2026 } })

    expect(answer).toMatchObject({ count: 2, from: { month: 9, year: 2026 }, until: { month: 10, year: 2026 } })
    expect(mockRepository.moveSeries).toHaveBeenCalledWith(
      ExpenseResource.FIXED_COST,
      ExpenseResource.SUBSCRIPTION,
      ['b', 'c'],
      expect.objectContaining({ kind: SubscriptionKind.PLATFORM }),
    )
  })

  it('should still refuse a move while a row of it has an /editar copy open', async () => {
    await expect(service.move({ ...base, mode: 'move' })).rejects.toBeInstanceOf(ExpenseMoveBlockedException)
    expect(mockRepository.moveSeries).not.toHaveBeenCalled()
  })

  it('should copy the series without moving it, and an open /editar copy does not block a copy', async () => {
    const answer = await service.move({ ...base, mode: 'copy' })

    expect(answer).toMatchObject({ mode: 'copy', count: 3, blocked: [] })
    expect(mockRepository.copySeries).toHaveBeenCalledWith(
      ExpenseResource.FIXED_COST,
      ExpenseResource.SUBSCRIPTION,
      ['a', 'b', 'c'],
      expect.anything(),
    )
    expect(mockRepository.moveSeries).not.toHaveBeenCalled()
  })

  it('should only count on a dry run', async () => {
    const answer = await service.move({ ...base, mode: 'copy', dryRun: true })
    expect(answer.dryRun).toBe(true)
    expect(mockRepository.copySeries).not.toHaveBeenCalled()
  })
})
