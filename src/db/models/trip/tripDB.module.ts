import { Module } from '@nestjs/common'

import { TripDBRepository } from './tripDB.repository'

@Module({
  providers: [TripDBRepository],
  exports: [TripDBRepository],
})
export class TripDBModule {}
