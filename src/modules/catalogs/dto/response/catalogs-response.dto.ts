import { z } from 'zod'

import { responseDto } from '@/commons/helpers/api-response.helper'

import {
  budgetGroupResponseSchema,
  cardHolderResponseSchema,
  categoryResponseSchema,
  accountResponseSchema,
  paymentMethodResponseSchema,
  personResponseSchema,
} from '../../validations/catalogs.validation'

export class PersonResponseDto extends responseDto(personResponseSchema) {}
export class PersonListResponseDto extends responseDto(z.array(personResponseSchema)) {}
export class PaymentMethodResponseDto extends responseDto(paymentMethodResponseSchema) {}
export class PaymentMethodListResponseDto extends responseDto(z.array(paymentMethodResponseSchema)) {}
export class CategoryResponseDto extends responseDto(categoryResponseSchema) {}
export class CategoryListResponseDto extends responseDto(z.array(categoryResponseSchema)) {}
export class BudgetGroupResponseDto extends responseDto(budgetGroupResponseSchema) {}
export class BudgetGroupListResponseDto extends responseDto(z.array(budgetGroupResponseSchema)) {}
export class CardHolderListResponseDto extends responseDto(z.array(cardHolderResponseSchema)) {}

export class AccountResponseDto extends responseDto(accountResponseSchema) {}
export class AccountListResponseDto extends responseDto(z.array(accountResponseSchema)) {}
