import { ConfigService } from '@nestjs/config'

import { PrismaService } from './prisma.service'

import { PaymentMethodType } from '@/commons/constants/catalog.constant'
import { DebtDirection, DebtStatus } from '@/commons/constants/debt.constant'
import {
  ExpenseDestination,
  ExpenseType,
  PaymentStatus,
  SubscriptionPeriod,
} from '@/commons/constants/expense.constant'
import {
  ExpenseDraftChannel,
  ExpenseDraftInputType,
  ExpenseDraftStatus,
} from '@/commons/constants/expense-draft.constant'

describe('Prisma schema (integration)', () => {
  let prisma: PrismaService

  beforeAll(async () => {
    const configService = new ConfigService({ db: { url: process.env.DATABASE_URL ?? 'file:./test.db' } })

    prisma = new PrismaService(configService)
    await prisma.onModuleInit()
  })

  afterAll(async () => {
    await prisma.onModuleDestroy()
  })

  it('should use the table prefixes by use', async () => {
    const tables = await prisma.$queryRaw<{ name: string }[]>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_prisma%' ESCAPE '\\' AND name NOT LIKE 'sqlite%'`

    expect(tables.map((table) => table.name).sort()).toEqual([
      'ai_request_logs',
      'aud_changes',
      'aud_context',
      'auth_attempts',
      'auth_invites',
      'auth_sessions',
      'auth_tokens',
      'auth_users',
      'bot_expense_drafts',
      'bot_files',
      'bud_budget_groups',
      'bud_category_budgets',
      'bud_incomes',
      'bud_monthly_budgets',
      'bud_settings',
      'cat_card_holders',
      'cat_categories',
      'cat_merchant_rules',
      'cat_payment_methods',
      'cat_people',
      'exp_attachments',
      'exp_commitments',
      'exp_contributions',
      'exp_credit_card_expenses',
      'exp_daily_expenses',
      'exp_debt_payments',
      'exp_debts',
      'exp_fixed_costs',
      'exp_recurring_expenses',
      'exp_subscriptions',
      'exp_trips',
      'imp_batches',
      'imp_rows',
      'imp_statement_rows',
      'imp_statements',
      'ntf_notifications',
      'ntf_settings',
    ])
  })

  it('should create catalogs, a chat draft and one expense per table with unified fields', async () => {
    const person = await prisma.person.create({ data: { name: 'Test Person', aliases: JSON.stringify(['tp']) } })
    const category = await prisma.category.create({ data: { name: 'Test Category' } })
    const wallet = await prisma.paymentMethod.create({ data: { name: 'Test Wallet', type: PaymentMethodType.WALLET } })
    const card = await prisma.paymentMethod.create({
      data: {
        name: 'Test Card',
        type: PaymentMethodType.CREDIT_CARD,
        code: 'TST',
        billingCloseDay: 20,
        paymentDueDay: 5,
      },
    })

    const draft = await prisma.expenseDraft.create({
      data: {
        channel: ExpenseDraftChannel.TELEGRAM,
        chatId: 'schema-chat',
        messageId: '1',
        inputType: ExpenseDraftInputType.TEXT,
        destination: ExpenseDestination.DAILY,
        description: 'Almuerzo',
        amount: 25,
        personId: person.id,
        paymentMethodId: wallet.id,
        status: ExpenseDraftStatus.SAVED,
      },
    })

    const daily = await prisma.dailyExpense.create({
      data: {
        description: 'Café',
        amount: 8,
        spentAt: new Date('2026-09-22T00:00:00.000Z'),
        personId: person.id,
        paymentMethodId: wallet.id,
        draftId: draft.id,
      },
    })

    const base = { amount: 50, personId: person.id, paymentMonth: 9, paymentYear: 2026 }

    const fixedCost = await prisma.fixedCost.create({
      data: { ...base, description: 'Rent', categoryId: category.id, paymentMethodId: wallet.id },
    })
    const subscription = await prisma.subscription.create({
      data: { ...base, description: 'Streaming', period: SubscriptionPeriod.MONTHLY },
    })
    const cardExpense = await prisma.creditCardExpense.create({
      data: { ...base, description: 'Laptop', paymentMethodId: card.id, installment: '2/6' },
    })
    const debt = await prisma.debt.create({
      data: {
        direction: DebtDirection.OWED_TO_ME,
        description: 'Loan',
        amount: 100,
        personId: person.id,
        paymentMonth: 9,
        paymentYear: 2026,
      },
    })

    expect(draft.status).toBe(ExpenseDraftStatus.SAVED)
    expect(daily.expenseType).toBe(ExpenseType.ESSENTIAL)
    expect(daily.currency).toBe('PEN')
    expect(fixedCost.expenseType).toBe(ExpenseType.ESSENTIAL)
    expect(fixedCost.paymentStatus).toBe(PaymentStatus.NOT_STARTED)
    expect(subscription.categoryId).toBeNull()
    expect(cardExpense.paymentStatus).toBe(PaymentStatus.PENDING)
    expect(debt).toMatchObject({ status: DebtStatus.PENDING, paidAmount: 0, currency: 'PEN' })

    const savedCard = await prisma.paymentMethod.findUniqueOrThrow({
      where: { id: card.id },
      include: { creditCardExpenses: true },
    })

    expect(savedCard.showInBot).toBe(true)
    expect(savedCard.billingCloseDay).toBe(20)
    expect(savedCard.creditCardExpenses).toHaveLength(1)
  })

  it('should reject two payment methods with the same card code', async () => {
    await prisma.paymentMethod.create({ data: { name: 'Dup A', type: PaymentMethodType.CREDIT_CARD, code: 'DUP' } })

    await expect(
      prisma.paymentMethod.create({ data: { name: 'Dup B', type: PaymentMethodType.CREDIT_CARD, code: 'DUP' } }),
    ).rejects.toThrow()
  })
})
