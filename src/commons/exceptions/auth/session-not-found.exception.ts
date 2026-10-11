import { HttpStatus } from '@nestjs/common'

import { AppException } from '../app.exception'

export class SessionNotFoundException extends AppException {
  constructor(details?: any) {
    super(HttpStatus.NOT_FOUND, 'SESSION_NOT_FOUND', 'That session does not exist or is not yours', details)
  }
}
