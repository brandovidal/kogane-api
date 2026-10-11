import { Module } from '@nestjs/common'

import { AccountDBRepository } from './accountDB.repository'

@Module({
  providers: [AccountDBRepository],
  exports: [AccountDBRepository],
})
export class AccountDBModule {}
