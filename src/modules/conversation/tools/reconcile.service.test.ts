import { vi } from 'vitest'

import { CatalogKind } from '@/commons/constants/expense-extraction.constant'
import { StatementRowResult } from '@/commons/constants/statement.constant'
import { StatementDBRepository } from '@/db/models/statement/statementDB.repository'
import { ExpenseExtractionService } from '@/modules/expense-extraction/expense-extraction.service'

import { ReconcileService } from './reconcile.service'

const mockStatements = { findMany: vi.fn(), findById: vi.fn(), findCardExpenses: vi.fn() }
const mockExtraction = {
  loadCatalog: vi.fn().mockResolvedValue({
    entries: [
      { id: 'pm-cmr', kind: CatalogKind.PAYMENT_METHOD, name: 'CMR', aliases: [] },
      { id: 'pm-sip', kind: CatalogKind.PAYMENT_METHOD, name: 'Sip', aliases: [] },
      { id: 'pm-yape', kind: CatalogKind.PAYMENT_METHOD, name: 'Yape', aliases: [] },
    ],
  }),
}
const statement = (id: string, paymentMethodId: string) => ({ id, paymentMethodId, paymentMonth: 9, paymentYear: 2026 })

describe('ReconcileService', () => {
  const service = new ReconcileService(
    mockStatements as unknown as StatementDBRepository,
    mockExtraction as unknown as ExpenseExtractionService,
  )

  beforeEach(() => {
    mockStatements.findMany.mockResolvedValue([statement('s-cmr', 'pm-cmr'), statement('s-sip', 'pm-sip')])
    mockStatements.findById.mockResolvedValue({
      id: 's-cmr',
      paymentMonth: 9,
      paymentYear: 2026,
      currency: 'PEN',
      totalDue: 500,
      rows: [
        { result: StatementRowResult.MATCHED, expenseId: 'e1' },
        { result: StatementRowResult.NEW, expenseId: null },
      ],
    })
    mockStatements.findCardExpenses.mockResolvedValue([
      { id: 'e1', description: 'Cena', amount: 300 },
      { id: 'e2', description: 'Cine', amount: 100 },
    ])
  })
  afterEach(() => vi.clearAllMocks())

  it('should compare the latest statement of the card with what is registered for its month', async () => {
    const { reply, asksCard } = await service.reply('cmr')

    expect(asksCard).toBe(false)
    expect(mockStatements.findById).toHaveBeenCalledWith('s-cmr')
    expect(mockStatements.findCardExpenses).toHaveBeenCalledWith('pm-cmr', { paymentMonth: 9, paymentYear: 2026 })
    expect(reply.text).toContain('Estado: <b>S/ 500.00</b> · Kogane: <b>S/ 400.00</b>')
    expect(reply.text).toContain('1 movimiento del estado sin registrar')
    expect(reply.text).toContain('Cine')
  })

  it('should ask which card when there are several and none was said, listing only cards with a statement', async () => {
    const { reply, asksCard } = await service.reply('')

    expect(asksCard).toBe(true)
    expect(reply.text).toContain('CMR · Sip')
    expect(reply.text).not.toContain('Yape')
  })

  it('should take the only card that has a statement without asking', async () => {
    mockStatements.findMany.mockResolvedValue([statement('s-cmr', 'pm-cmr')])

    expect((await service.reply('')).asksCard).toBe(false)
  })

  it('should ask again when the card is not one of those, and say when there are no statements', async () => {
    const unknown = await service.reply('bcp')
    expect(unknown).toEqual({
      reply: expect.objectContaining({ text: expect.stringContaining('No encontré la tarjeta') }),
      asksCard: true,
    })

    mockStatements.findMany.mockResolvedValue([])
    const none = await service.reply('cmr')
    expect(none.asksCard).toBe(false)
    expect(none.reply.text).toContain('Todavía no hay estados de cuenta')
  })
})
