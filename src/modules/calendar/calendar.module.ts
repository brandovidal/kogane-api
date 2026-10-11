import { Module } from '@nestjs/common'

import { AccountDBModule } from '@/db/models/account/accountDB.module'
import { CalendarDBModule } from '@/db/models/calendar/calendarDB.module'
import { PaymentDBModule } from '@/db/models/payment/paymentDB.module'
import { StatementDBModule } from '@/db/models/statement/statementDB.module'
import { DebtsModule } from '@/modules/debts/debts.module'

import { CalendarController } from './calendar.controller'
import { CalendarService } from './calendar.service'

@Module({
  imports: [CalendarDBModule, StatementDBModule, DebtsModule, PaymentDBModule, AccountDBModule],
  controllers: [CalendarController],
  providers: [CalendarService],
  exports: [CalendarService],
})
export class CalendarModule {}
