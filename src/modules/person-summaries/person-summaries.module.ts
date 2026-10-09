import { Module } from '@nestjs/common'

import { PersonDBModule } from '@/db/models/person/personDB.module'
import { PersonSummaryDBModule } from '@/db/models/person-summary/personSummaryDB.module'

import { PersonSummariesController } from './person-summaries.controller'
import { PersonSummariesService } from './person-summaries.service'

@Module({
  imports: [PersonSummaryDBModule, PersonDBModule],
  controllers: [PersonSummariesController],
  providers: [PersonSummariesService],
})
export class PersonSummariesModule {}
