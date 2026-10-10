import { Module } from '@nestjs/common'

import { CategoryDBModule } from '@/db/models/category/categoryDB.module'
import { PaymentMethodDBModule } from '@/db/models/payment-method/paymentMethodDB.module'
import { PersonDBModule } from '@/db/models/person/personDB.module'
import { DebtsModule } from '@/modules/debts/debts.module'
import { ExpensesModule } from '@/modules/expenses/expenses.module'

import { ImportsController } from './imports.controller'
import { ImportsService } from './imports.service'
import { ListImportService } from './list/list-import.service'

@Module({
  imports: [PersonDBModule, PaymentMethodDBModule, CategoryDBModule, ExpensesModule, DebtsModule],
  controllers: [ImportsController],
  providers: [ImportsService, ListImportService],
})
export class ImportsModule {}
