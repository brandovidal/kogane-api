import { vi } from 'vitest'

import { ExpenseDraftChannel, ExpenseDraftStatus } from '@/commons/constants/expense-draft.constant'
import { SavedExpenseLockedException } from '@/commons/exceptions/expense/saved-expense-locked.exception'
import { ExpenseDraftDBRepository } from '@/db/models/expense-draft/expenseDraftDB.repository'
import { ExpenseDBRepository } from '@/db/models/expense/expenseDB.repository'

import { UndoService } from './undo.service'

const mockDrafts = { findRecentSaved: vi.fn(), findById: vi.fn() }
const mockExpenses = { deleteSavedExpense: vi.fn() }
const saved = (overrides: Record<string, unknown> = {}) => ({
  id: 'd1',
  chatId: '555',
  description: 'Almuerzo',
  amount: 25,
  currency: 'PEN',
  status: ExpenseDraftStatus.SAVED,
  ...overrides,
})

describe('UndoService (/deshacer)', () => {
  const service = new UndoService(
    mockDrafts as unknown as ExpenseDraftDBRepository,
    mockExpenses as unknown as ExpenseDBRepository,
  )

  afterEach(() => vi.resetAllMocks())

  it('should ask before cancelling the last saved expense of the chat', async () => {
    mockDrafts.findRecentSaved.mockResolvedValue([saved()])

    const reply = await service.prompt(ExpenseDraftChannel.TELEGRAM, '555')

    expect(mockDrafts.findRecentSaved).toHaveBeenCalledWith(ExpenseDraftChannel.TELEGRAM, '555', 1)
    expect(reply.text).toContain('Almuerzo')
    expect(reply.buttons![0].map((button) => button.data)).toEqual(['und:d1', 'unx:d1'])
  })

  it('should say when there is nothing to undo', async () => {
    mockDrafts.findRecentSaved.mockResolvedValue([])

    expect((await service.prompt(ExpenseDraftChannel.TELEGRAM, '555')).text).toContain('No hay un gasto guardado')
  })

  it('should delete the expense once confirmed', async () => {
    mockDrafts.findById.mockResolvedValue(saved())

    const reply = await service.confirm('555', 'd1')

    expect(mockExpenses.deleteSavedExpense).toHaveBeenCalledWith('d1')
    expect(reply).toMatchObject({ edit: true, text: expect.stringContaining('Anulé') })
  })

  it('should not touch an expense of another chat, one already undone, or one that does not exist', async () => {
    for (const found of [saved({ chatId: '999' }), saved({ status: ExpenseDraftStatus.DISCARDED }), null]) {
      mockDrafts.findById.mockResolvedValue(found)
      await service.confirm('555', 'd1')
    }

    expect(mockExpenses.deleteSavedExpense).not.toHaveBeenCalled()
  })

  it('should leave an expense whose debts already have payments, and say why', async () => {
    mockDrafts.findById.mockResolvedValue(saved())
    mockExpenses.deleteSavedExpense.mockRejectedValue(new SavedExpenseLockedException({ draftId: 'd1' }))

    expect((await service.confirm('555', 'd1')).text).toContain('abonos')
  })
})
