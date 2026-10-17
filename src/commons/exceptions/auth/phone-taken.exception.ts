import { HttpStatus } from '@nestjs/common'

import { AppException } from '../app.exception'

export class PhoneTakenException extends AppException {
  constructor(details?: any) {
    super(HttpStatus.CONFLICT, 'PHONE_TAKEN', 'That mobile belongs to another account', details)
  }
}
