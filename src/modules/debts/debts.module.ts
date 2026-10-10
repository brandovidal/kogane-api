import { Module } from '@nestjs/common'

import { DebtDBModule } from '@/db/models/debt/debtDB.module'
import { StatementDBModule } from '@/db/models/statement/statementDB.module'
import { AttachmentsModule } from '@/modules/attachments/attachments.module'

import { DebtsController } from './debts.controller'
import { DebtsService } from './debts.service'

@Module({
  imports: [DebtDBModule, StatementDBModule, AttachmentsModule],
  controllers: [DebtsController],
  providers: [DebtsService],
  exports: [DebtsService],
})
export class DebtsModule {}
