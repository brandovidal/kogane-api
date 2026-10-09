import { z } from 'zod'

import { responseDto } from '@/commons/helpers/api-response.helper'

import { personSummaryResponseSchema } from '../../validations/person-summaries.validation'

export class PersonSummaryResponseDto extends responseDto(personSummaryResponseSchema) {}
export class PersonSummaryListResponseDto extends responseDto(z.array(personSummaryResponseSchema)) {}
