import { Module } from '@nestjs/common'

import { BudgetSettingDBModule } from '@/db/models/budget-setting/budgetSettingDB.module'
import { ExpenseDraftDBModule } from '@/db/models/expense-draft/expenseDraftDB.module'
import { ExpenseDBModule } from '@/db/models/expense/expenseDB.module'
import { PaymentMethodDBModule } from '@/db/models/payment-method/paymentMethodDB.module'
import { MerchantRuleDBModule } from '@/db/models/merchant-rule/merchantRuleDB.module'
import { StatementDBModule } from '@/db/models/statement/statementDB.module'
import { TripDBModule } from '@/db/models/trip/tripDB.module'
import { PersonDBModule } from '@/db/models/person/personDB.module'
import { ExpenseExtractionModule } from '@/modules/expense-extraction/expense-extraction.module'
import { StoredFilesModule } from '@/modules/stored-files/stored-files.module'
import { DebtsModule } from '@/modules/debts/debts.module'
import { RecognitionModule } from '@/modules/recognition/recognition.module'
import { BudgetModule } from '@/modules/budget/budget.module'
import { ReportsModule } from '@/modules/reports/reports.module'
import { NotificationsModule } from '@/modules/notifications/notifications.module'

import { ConversationService } from './conversation.service'
import { ExpenseSaverService } from './expense-saver.service'
import { MediaDownloaderRegistry } from './media-downloader.registry'
import { BotToolsService } from './tools/bot-tools.service'
import { ChartService } from './tools/chart.service'
import { QuestionService } from './tools/question.service'
import { ReconcileService } from './tools/reconcile.service'
import { RulesService } from './tools/rules.service'
import { QuickExpensesService } from './tools/quick-expenses.service'
import { SpendingQueriesService } from './tools/spending-queries.service'
import { TripsService } from './tools/trips.service'
import { UndoService } from './tools/undo.service'

@Module({
  imports: [
    BudgetSettingDBModule,
    ExpenseDraftDBModule,
    ExpenseDBModule,
    PaymentMethodDBModule,
    PersonDBModule,
    TripDBModule,
    MerchantRuleDBModule,
    StatementDBModule,
    ExpenseExtractionModule,
    StoredFilesModule,
    DebtsModule,
    RecognitionModule,
    BudgetModule,
    ReportsModule,
    NotificationsModule,
  ],
  providers: [
    ConversationService,
    ExpenseSaverService,
    MediaDownloaderRegistry,
    BotToolsService,
    SpendingQueriesService,
    QuickExpensesService,
    UndoService,
    TripsService,
    ChartService,
    QuestionService,
    ReconcileService,
    RulesService,
  ],
  exports: [ConversationService, ExpenseSaverService, MediaDownloaderRegistry],
})
export class ConversationModule {}
