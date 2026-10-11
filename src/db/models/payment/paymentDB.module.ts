import { Module } from '@nestjs/common'

import { PaymentDBRepository } from './paymentDB.repository'

@Module({
  providers: [PaymentDBRepository],
  exports: [PaymentDBRepository],
})
export class PaymentDBModule {}
