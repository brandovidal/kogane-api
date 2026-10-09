import { responseDto } from '@/commons/helpers/api-response.helper'

import { cardReviewResponseSchema, moveSeriesResponseSchema } from '../../validations/expense-moves.validation'

export class MoveSeriesResponseDto extends responseDto(moveSeriesResponseSchema) {}
export class CardReviewResponseDto extends responseDto(cardReviewResponseSchema) {}
