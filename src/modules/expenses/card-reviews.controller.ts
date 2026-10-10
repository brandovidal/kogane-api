import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common'
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger'

import { ApiRest } from '@/commons/decorators/api-rest.decorator'
import { ResponseMessage } from '@/commons/decorators/response-message.decorator'
import { ExpenseRecordDBRepository } from '@/db/models/expense-record/expenseRecordDB.repository'

import { CardReviewDto } from './dto/request/expense-moves.dto'
import { CardReviewResponseDto } from './dto/response/expense-moves-response.dto'

// "Marcar como revisados" of Tarjetas. Not under /expenses: it would collide with /expenses/:resource
@ApiRest('expenses')
@Controller('card-reviews')
export class CardReviewsController {
  constructor(private readonly expenseRecordDBRepository: ExpenseRecordDBRepository) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark card charges as checked against the statement (reviewed: false unmarks them)' })
  @ApiOkResponse({ type: CardReviewResponseDto })
  @ResponseMessage('CARD_CHARGES_REVIEWED', 'Card charges reviewed')
  async review(@Body() { ids, reviewed }: CardReviewDto) {
    const reviewedAt = reviewed ? new Date() : null
    const affected = await this.expenseRecordDBRepository.setReviewed(ids, reviewedAt)
    return { affected, reviewedAt: reviewedAt?.toISOString() ?? null }
  }
}
