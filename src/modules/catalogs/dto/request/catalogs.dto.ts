import { createZodDto } from 'nestjs-zod'

import {
  cardHoldersSchema,
  statementPasswordSchema,
  budgetGroupSchema,
  categorySchema,
  createPaymentMethodSchema,
  paymentMethodSchema,
  personSchema,
} from '../../validations/catalogs.validation'

export class CreatePersonDto extends createZodDto(personSchema) {}
export class UpdatePersonDto extends createZodDto(personSchema.partial()) {}

export class CreatePaymentMethodDto extends createZodDto(createPaymentMethodSchema) {}
export class UpdatePaymentMethodDto extends createZodDto(paymentMethodSchema.partial()) {}

export class CreateCategoryDto extends createZodDto(categorySchema) {}
export class UpdateCategoryDto extends createZodDto(categorySchema.partial()) {}

export class CreateBudgetGroupDto extends createZodDto(budgetGroupSchema) {}
export class UpdateBudgetGroupDto extends createZodDto(budgetGroupSchema.partial()) {}
export class CardHoldersDto extends createZodDto(cardHoldersSchema) {}
export class StatementPasswordDto extends createZodDto(statementPasswordSchema) {}
