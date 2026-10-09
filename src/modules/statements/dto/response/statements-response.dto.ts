import { z } from 'zod'

import { responseDto } from '@/commons/helpers/api-response.helper'

import {
  statementFileSchema,
  statementResponseSchema,
  statementSummaryResponseSchema,
} from '../../validations/statements.validation'

export class StatementResponseDto extends responseDto(statementResponseSchema) {}
export class StatementListResponseDto extends responseDto(z.array(statementSummaryResponseSchema)) {}
export class StatementFileResponseDto extends responseDto(statementFileSchema) {}
