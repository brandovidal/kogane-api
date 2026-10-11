import { Test, TestingModule } from '@nestjs/testing'
import { vi } from 'vitest'

import { CardHolderRole, PaymentMethodType } from '@/commons/constants/catalog.constant'
import { PaymentMethodIncompleteException } from '@/commons/exceptions/catalog/payment-method-incomplete.exception'
import { BudgetGroupDBRepository } from '@/db/models/budget-group/budgetGroupDB.repository'
import { CategoryDBRepository } from '@/db/models/category/categoryDB.repository'
import { CardHolderDBRepository } from '@/db/models/card-holder/cardHolderDB.repository'
import { PaymentMethodDBRepository } from '@/db/models/payment-method/paymentMethodDB.repository'
import { PersonModule } from '@/commons/constants/catalog.constant'
import { PersonDBRepository } from '@/db/models/person/personDB.repository'

import {
  BudgetGroupsController,
  CategoriesController,
  PaymentMethodsController,
  PeopleController,
} from './catalogs.controller'
import { cardHoldersSchema, createPaymentMethodSchema } from './validations/catalogs.validation'

const people = { findAll: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() }
const methods = { findAll: vi.fn(), findById: vi.fn(), createFull: vi.fn(), update: vi.fn(), deactivate: vi.fn() }
const categories = { findAll: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() }
const groups = { findAll: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() }
const holders = { findByCard: vi.fn(), replace: vi.fn() }

// Catalogs of kogane-app (P7): the controllers hand the validated body to their repository (errors are mapped there)
describe('Catalogs controllers', () => {
  let module: TestingModule

  beforeEach(async () => {
    module = await Test.createTestingModule({
      controllers: [PeopleController, PaymentMethodsController, CategoriesController, BudgetGroupsController],
      providers: [
        { provide: PersonDBRepository, useValue: people },
        { provide: PaymentMethodDBRepository, useValue: methods },
        { provide: CardHolderDBRepository, useValue: holders },
        { provide: CategoryDBRepository, useValue: categories },
        { provide: BudgetGroupDBRepository, useValue: groups },
      ],
    })
      // ApiKeyGuard and the rest of the app are not under test here
      .useMocker(() => ({}))
      .compile()
  })

  afterEach(() => vi.clearAllMocks())

  it('should list, create, edit and deactivate people (Configuración ▸ Personas, D80)', async () => {
    const controller = module.get(PeopleController)
    const person = { id: 'person-1', name: 'Brenda', documentNumber: null }
    people.findAll.mockResolvedValue([person])
    people.create.mockResolvedValue(person)
    people.update.mockResolvedValue(person)
    people.deactivate.mockResolvedValue(person)
    await controller.findAll({})
    await controller.findAll({ module: PersonModule.CARDS })
    await controller.create({ name: 'Brenda', aliases: ['mi hermana'], appearsIn: [PersonModule.CARDS] })
    await controller.update('person-1', { isActive: false })
    await controller.deactivate('person-1')

    expect(people.findAll).toHaveBeenNthCalledWith(1, undefined)
    expect(people.findAll).toHaveBeenNthCalledWith(2, PersonModule.CARDS)
    expect(people.create).toHaveBeenCalledWith({ name: 'Brenda', aliases: ['mi hermana'], appearsIn: ['cards'] })
    expect(people.update).toHaveBeenCalledWith('person-1', { isActive: false })
    expect(people.deactivate).toHaveBeenCalledWith('person-1')
  })

  it('should never answer the document number whole, only its last 3 characters (D94)', async () => {
    const controller = module.get(PeopleController)
    people.findAll.mockResolvedValue([
      { id: 'me', name: 'Brando', documentNumber: '44556677' },
      { id: 'dany', name: 'Danery', documentNumber: null },
    ])
    people.update.mockResolvedValue({ id: 'me', name: 'Brando', documentNumber: '44556677' })

    expect((await controller.findAll({})).map((person) => person.documentNumber)).toEqual(['•••••677', null])
    expect((await controller.update('me', { documentNumber: '44556677' })).documentNumber).toBe('•••••677')
    expect(people.update).toHaveBeenCalledWith('me', { documentNumber: '44556677' })
  })

  it('should turn a card off for the menu and the bot (Cuentas y tarjetas)', async () => {
    const controller = module.get(PaymentMethodsController)
    await controller.create({ name: 'Ripley', type: PaymentMethodType.CREDIT_CARD, billingCloseDay: 25 })
    await controller.update('method-1', { isActive: false, showInBot: false })

    expect(methods.createFull).toHaveBeenCalledWith({ name: 'Ripley', type: 'credit_card', billingCloseDay: 25 })
    expect(methods.update).toHaveBeenCalledWith('method-1', { isActive: false, showInBot: false })
  })

  it('should manage categories and budget groups', async () => {
    await module.get(CategoriesController).delete('category-1')
    await module.get(BudgetGroupsController).update('group-1', { percentage: 40 })

    expect(categories.delete).toHaveBeenCalledWith('category-1')
    expect(groups.update).toHaveBeenCalledWith('group-1', { percentage: 40 })
  })

  it('should keep exactly one titular per card and each person once (D116)', () => {
    const titular = { personId: 'me', role: CardHolderRole.TITULAR, last4: '1810' }
    const additional = { personId: 'dany', role: CardHolderRole.ADDITIONAL, last4: '8835' }

    expect(cardHoldersSchema.safeParse({ holders: [titular, additional] }).success).toBe(true)
    expect(cardHoldersSchema.safeParse({ holders: [additional] }).success).toBe(false)
    expect(
      cardHoldersSchema.safeParse({ holders: [titular, { ...titular, role: CardHolderRole.ADDITIONAL }] }).success,
    ).toBe(false)
    expect(cardHoldersSchema.safeParse({ holders: [{ ...titular, last4: '18' }] }).success).toBe(false)
  })

  describe('cards of Configuración ▸ Cuentas y tarjetas (D97)', () => {
    it('should not create a credit card without its code and billing days, nor a debit card without its bank', () => {
      const credit = createPaymentMethodSchema.safeParse({
        name: 'Ripley',
        type: PaymentMethodType.CREDIT_CARD,
        code: 'RIP',
      })
      const debit = createPaymentMethodSchema.safeParse({ name: 'Scotia', type: PaymentMethodType.DEBIT_CARD })
      const wallet = createPaymentMethodSchema.safeParse({ name: 'Tunki', type: PaymentMethodType.WALLET })

      expect(credit.error?.issues.map((issue) => issue.path[0])).toEqual(['billingCloseDay', 'paymentDueDay'])
      expect(debit.error?.issues.map((issue) => issue.path[0])).toEqual(['bank'])
      expect(wallet.success).toBe(true)
    })

    it('should refuse an edit that leaves a credit card without its closing day', async () => {
      const controller = module.get(PaymentMethodsController)
      methods.findById.mockResolvedValue({
        type: PaymentMethodType.CREDIT_CARD,
        code: 'IO',
        billingCloseDay: 25,
        paymentDueDay: 12,
      })

      await expect(controller.update('io', { billingCloseDay: null })).rejects.toBeInstanceOf(
        PaymentMethodIncompleteException,
      )
      expect(methods.update).not.toHaveBeenCalled()
    })

    it('should not check the card on edits that do not touch what it needs (a card made by the bot has no days yet)', async () => {
      const controller = module.get(PaymentMethodsController)

      await controller.update('new-card', { showInBot: false })

      expect(methods.findById).not.toHaveBeenCalled()
      expect(methods.update).toHaveBeenCalledWith('new-card', { showInBot: false })
    })
  })
})
