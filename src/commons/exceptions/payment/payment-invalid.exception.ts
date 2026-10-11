import { HttpStatus } from '@nestjs/common'

import { AppException } from '../app.exception'

// A payment from the calendar that cannot be registered as asked: an amount of zero or above what is left
export class PaymentInvalidException extends AppException {
  constructor(details?: any) {
    super(HttpStatus.UNPROCESSABLE_ENTITY, 'PAYMENT_INVALID', 'The payment cannot be registered as asked', details)
  }
}
