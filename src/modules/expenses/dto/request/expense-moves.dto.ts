import { createZodDto } from 'nestjs-zod'

import { cardReviewSchema, moveSeriesSchema } from '../../validations/expense-moves.validation'

export class MoveSeriesDto extends createZodDto(moveSeriesSchema) {}
export class CardReviewDto extends createZodDto(cardReviewSchema) {}
