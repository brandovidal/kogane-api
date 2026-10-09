import { z } from 'zod'

import { responseDto } from '@/commons/helpers/api-response.helper'

import {
  cardCheckResponseSchema,
  debtBulkResponseSchema,
  debtPaymentCreatedResponseSchema,
  debtCarryOverResponseSchema,
  debtDetailResponseSchema,
  debtResponseSchema,
  debtSummaryResponseSchema,
  debtViewResponseSchema,
} from '../../validations/debts.validation'

export class DebtResponseDto extends responseDto(debtResponseSchema) {}
export class DebtListResponseDto extends responseDto(z.array(debtViewResponseSchema)) {}
export class DebtCreatedResponseDto extends responseDto(z.array(debtResponseSchema)) {}
export class DebtDetailResponseDto extends responseDto(debtDetailResponseSchema) {}
export class DebtSummaryResponseDto extends responseDto(z.array(debtSummaryResponseSchema)) {}
export class DebtBulkResponseDto extends responseDto(debtBulkResponseSchema) {}
export class DebtCarryOverResponseDto extends responseDto(debtCarryOverResponseSchema) {}
export class CardCheckResponseDto extends responseDto(cardCheckResponseSchema) {}
export class DebtPaymentCreatedResponseDto extends responseDto(debtPaymentCreatedResponseSchema) {}
