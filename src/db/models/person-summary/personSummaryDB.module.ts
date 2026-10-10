import { Module } from '@nestjs/common'

import { PersonSummaryDBRepository } from './personSummaryDB.repository'

@Module({
  providers: [PersonSummaryDBRepository],
  exports: [PersonSummaryDBRepository],
})
export class PersonSummaryDBModule {}
