import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common'
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger'

import { APP_TIME_ZONE } from '@/commons/constants/app.constant'
import { ApiRest } from '@/commons/decorators/api-rest.decorator'
import { ResponseMessage } from '@/commons/decorators/response-message.decorator'
import { DateHelper } from '@/commons/helpers/date.helper'

import { GenerateRecurringDto, RecurringFromSeriesDto } from './dto/request/recurring-expenses.dto'
import { ExpenseRecordResponseDto } from './dto/response/expenses-response.dto'
import { ExpensesService } from './expenses.service'
import { RecurringGenerationResponseDto } from './dto/response/recurring-expenses-response.dto'
import { RecurringExpensesService } from './recurring-expenses.service'

// Recurrentes (P20, D88): the job of the 1st does it; this is "Generar" in the web
@ApiRest('expenses')
@Controller('recurring-expenses')
export class RecurringExpensesController {
  constructor(
    private readonly recurringExpensesService: RecurringExpensesService,
    private readonly expensesService: ExpensesService,
  ) {}

  @Post('from-series')
  @ApiOperation({
    summary:
      '"Pasar desde Costos fijos… / Plataformas…": a monthly template from a series (409 RECURRING_TEMPLATE_EXISTS)',
  })
  @ApiOkResponse({ type: ExpenseRecordResponseDto })
  @ResponseMessage('RECURRING_FROM_SERIES', 'Recurring template created')
  fromSeries(@Body() { resource, id }: RecurringFromSeriesDto) {
    return this.expensesService.recurringFromSeries(resource, id)
  }

  @Post('generate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create the pending rows of a month from the active recurring expenses (never twice)' })
  @ApiOkResponse({ type: RecurringGenerationResponseDto })
  @ResponseMessage('RECURRING_GENERATED', 'Recurring expenses generated')
  generate(@Body() { month, year }: GenerateRecurringDto) {
    const today = DateHelper.todayIn(APP_TIME_ZONE)
    return this.recurringExpensesService.generate(month ?? Number(today.slice(5, 7)), year ?? Number(today.slice(0, 4)))
  }
}
