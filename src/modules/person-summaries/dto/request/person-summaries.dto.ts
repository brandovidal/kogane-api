import { createZodDto } from 'nestjs-zod'

import {
  bulkPersonSummaryStatusSchema,
  personSummaryQuerySchema,
  savePersonSummarySchema,
} from '../../validations/person-summaries.validation'

export class PersonSummaryQueryDto extends createZodDto(personSummaryQuerySchema) {}
export class SavePersonSummaryDto extends createZodDto(savePersonSummarySchema) {}
export class BulkPersonSummaryStatusDto extends createZodDto(bulkPersonSummaryStatusSchema) {}
