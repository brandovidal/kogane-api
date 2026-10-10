import { HttpStatus } from '@nestjs/common'

import { AppException } from '../app.exception'

export class ResetLinkInvalidException extends AppException {
  constructor(details?: any) {
    super(HttpStatus.GONE, 'RESET_LINK_INVALID', 'The password reset link is not valid or has expired', details)
  }
}
