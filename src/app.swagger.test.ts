import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { cleanupOpenApiDoc } from 'nestjs-zod'

import { VERSIONING_OPTIONS } from '@/commons/constants/versioning.constant'
import {
  AccountsController,
  BudgetGroupsController,
  CategoriesController,
  PaymentMethodsController,
  PeopleController,
} from '@/modules/catalogs/catalogs.controller'
import { DebtsController } from '@/modules/debts/debts.controller'
import { DraftsController } from '@/modules/drafts/drafts.controller'
import { ExpenseMovesController } from '@/modules/expenses/expense-moves.controller'
import { ExpensesController } from '@/modules/expenses/expenses.controller'
import { MessagesController } from '@/modules/messages/messages.controller'
import { SummaryController } from '@/modules/summary/summary.controller'
import { BudgetSettingsController } from '@/modules/budget/budget-settings.controller'
import { CategoryBudgetsController } from '@/modules/budget/category-budgets.controller'
import { IncomesController } from '@/modules/budget/incomes.controller'
import { ReportsController } from '@/modules/reports/reports.controller'
import { REPORT_MIME_TYPES } from '@/commons/constants/report.constant'

type Operation = { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> }

// kogane-app generates its types from /docs-json (D56): an endpoint without its response schema becomes `never` there
describe('Swagger of the REST API for kogane-app', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        PeopleController,
        PaymentMethodsController,
        AccountsController,
        CategoriesController,
        BudgetGroupsController,
        ExpensesController,
        ExpenseMovesController,
        DraftsController,
        MessagesController,
        SummaryController,
        DebtsController,
        IncomesController,
        CategoryBudgetsController,
        BudgetSettingsController,
        ReportsController,
      ],
    })
      .useMocker(() => ({}))
      .compile()

    app = moduleRef.createNestApplication()
    app.enableVersioning(VERSIONING_OPTIONS)
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('should document the response of every endpoint (204 excepted) with the x-api-key security', () => {
    const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, new DocumentBuilder().build()))
    const undocumented: string[] = []

    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods as Record<string, Operation & { security?: unknown }>)) {
        const responses = operation.responses ?? {}
        if (responses['204']) continue
        const success = responses['200'] ?? responses['201']
        // Downloads (D39) document their file types instead of JSON
        const documented = ['application/json', ...Object.values(REPORT_MIME_TYPES)].some(
          (type) => success?.content?.[type]?.schema,
        )
        if (!documented) undocumented.push(`${method.toUpperCase()} ${path}`)
        expect(operation.security, `${method} ${path}`).toBeDefined()
      }
    }

    expect(undocumented).toEqual([])

    // nestjs-zod turns z.string().trim().nullable() without other checks into an array: text fields stay strings
    const textFields = Object.entries(document.components?.schemas ?? {}).flatMap(([name, schema]) =>
      Object.entries((schema as { properties?: Record<string, { type?: string }> }).properties ?? {})
        .filter(([field]) => ['notes', 'description', 'name'].includes(field))
        .map(([field, property]) => `${name}.${field}: ${property.type}`),
    )
    expect(textFields.filter((field) => !field.endsWith(': string'))).toEqual([])
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/v1/debts',
        '/v1/drafts',
        '/v1/messages',
        '/v1/incomes',
        '/v1/category-budgets',
        '/v1/summary/history',
        '/v1/reports/debts',
      ]),
    )
  })
})
