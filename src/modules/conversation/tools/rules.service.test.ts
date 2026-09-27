import { vi } from 'vitest'

import { MerchantRuleDBRepository } from '@/db/models/merchant-rule/merchantRuleDB.repository'
import { CatalogKind } from '@/commons/constants/expense-extraction.constant'
import { ExpenseExtractionService } from '@/modules/expense-extraction/expense-extraction.service'

import { RulesService } from './rules.service'

const repo = { findAll: vi.fn(), learn: vi.fn(), delete: vi.fn() }
const extraction = {
  loadCatalog: vi.fn().mockResolvedValue({
    entries: [
      { id: 'cat-food', kind: CatalogKind.CATEGORY, name: 'Comida', aliases: [] },
      { id: 'pm-yape', kind: CatalogKind.PAYMENT_METHOD, name: 'Yape', aliases: [] },
    ],
  }),
}
const rule = (id: string, merchant: string) => ({ id, merchant, categoryId: 'cat-food', paymentMethodId: 'pm-yape' })

describe('RulesService', () => {
  const service = new RulesService(
    repo as unknown as MerchantRuleDBRepository,
    extraction as unknown as ExpenseExtractionService,
  )
  afterEach(() => vi.clearAllMocks())

  it('should learn the category or the method chosen for a merchant, keyed as the rules are', async () => {
    await service.learn({ merchant: 'Café Tostado', description: 'Desayuno' }, { categoryId: 'cat-food' })

    expect(repo.learn).toHaveBeenCalledWith('cafe tostado', { categoryId: 'cat-food', paymentMethodId: undefined })
  })

  it('should not learn from a correction of something else, or an expense with nothing to key by', async () => {
    await service.learn({ merchant: null, description: 'Almuerzo' }, { amount: 30 })
    await service.learn({ merchant: null, description: 'x' }, { categoryId: 'cat-food' })

    expect(repo.learn).not.toHaveBeenCalled()
  })

  it('should never fail the message because of a rule', async () => {
    repo.learn.mockRejectedValue(new Error('db'))
    repo.findAll.mockRejectedValue(new Error('db'))
    const expenses = [{ description: 'Almuerzo' }] as never[]

    await expect(
      service.learn({ merchant: null, description: 'Almuerzo' }, { categoryId: 'cat-food' }),
    ).resolves.toBeUndefined()
    await expect(service.apply(expenses, {} as never)).resolves.toBe(expenses)
  })

  it('should list the rules with names and a delete button each', async () => {
    repo.findAll.mockResolvedValue([rule('r1', 'almuerzo'), rule('r2', 'netflix')])

    const reply = await service.list()

    expect(reply.text).toContain('<b>almuerzo</b> → Comida · Yape')
    expect(reply.buttons!.slice(0, 2).map((row) => row[0].data)).toEqual(['rul:r1', 'rul:r2'])
  })

  it('should explain that there are none yet', async () => {
    repo.findAll.mockResolvedValue([])

    expect((await service.list()).text).toContain('Todavía no aprendí reglas')
  })

  it('should delete a rule and show the list again in place, or say it is already gone', async () => {
    repo.findAll.mockResolvedValue([rule('r2', 'netflix')])
    repo.delete.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const first = await service.remove('r1')
    const second = await service.remove('r1')

    expect(first.notice).toBe('Regla borrada')
    expect(first.reply.edit).toBe(true)
    expect(second.notice).toBe('Esa regla ya no existe')
  })
})
