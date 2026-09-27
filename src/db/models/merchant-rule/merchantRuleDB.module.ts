import { Module } from '@nestjs/common'

import { MerchantRuleDBRepository } from './merchantRuleDB.repository'

@Module({
  providers: [MerchantRuleDBRepository],
  exports: [MerchantRuleDBRepository],
})
export class MerchantRuleDBModule {}
