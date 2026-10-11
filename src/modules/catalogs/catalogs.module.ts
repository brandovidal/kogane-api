import { Module } from '@nestjs/common'

import { AccountDBModule } from '@/db/models/account/accountDB.module'
import { BudgetGroupDBModule } from '@/db/models/budget-group/budgetGroupDB.module'
import { CardHolderDBModule } from '@/db/models/card-holder/cardHolderDB.module'
import { CategoryDBModule } from '@/db/models/category/categoryDB.module'
import { PaymentMethodDBModule } from '@/db/models/payment-method/paymentMethodDB.module'
import { PersonDBModule } from '@/db/models/person/personDB.module'

import {
  AccountsController,
  BudgetGroupsController,
  CategoriesController,
  PaymentMethodsController,
  PeopleController,
} from './catalogs.controller'

@Module({
  imports: [
    PersonDBModule,
    PaymentMethodDBModule,
    AccountDBModule,
    CardHolderDBModule,
    CategoryDBModule,
    BudgetGroupDBModule,
  ],
  controllers: [
    PeopleController,
    PaymentMethodsController,
    AccountsController,
    CategoriesController,
    BudgetGroupsController,
  ],
})
export class CatalogsModule {}
