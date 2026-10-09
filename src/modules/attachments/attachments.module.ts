import { Module } from '@nestjs/common'

import { AttachmentDBModule } from '@/db/models/attachment/attachmentDB.module'
import { CommitmentDBModule } from '@/db/models/commitment/commitmentDB.module'
import { DebtDBModule } from '@/db/models/debt/debtDB.module'
import { ExpenseRecordDBModule } from '@/db/models/expense-record/expenseRecordDB.module'
import { StoredFilesModule } from '@/modules/stored-files/stored-files.module'

import { AttachmentsController } from './attachments.controller'
import { AttachmentsService } from './attachments.service'

@Module({
  imports: [AttachmentDBModule, CommitmentDBModule, DebtDBModule, ExpenseRecordDBModule, StoredFilesModule],
  controllers: [AttachmentsController],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
