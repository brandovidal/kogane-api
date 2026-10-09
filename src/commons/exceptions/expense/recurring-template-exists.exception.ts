import { HttpStatus } from '@nestjs/common'

import { AppException } from '../app.exception'

// "Pasar desde…" of Recurrentes: the series already has a template (same description and person)
export class RecurringTemplateExistsException extends AppException {
  constructor(details?: any) {
    super(HttpStatus.CONFLICT, 'RECURRING_TEMPLATE_EXISTS', 'The series already repeats every month', details)
  }
}
