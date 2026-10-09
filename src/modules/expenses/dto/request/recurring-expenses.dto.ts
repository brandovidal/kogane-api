import { createZodDto } from 'nestjs-zod'

import { generateRecurringSchema, recurringFromSeriesSchema } from '../../validations/recurring-expenses.validation'

export class GenerateRecurringDto extends createZodDto(generateRecurringSchema) {}
export class RecurringFromSeriesDto extends createZodDto(recurringFromSeriesSchema) {}
