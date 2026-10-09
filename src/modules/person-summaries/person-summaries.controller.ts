import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common'
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger'

import { ApiRest } from '@/commons/decorators/api-rest.decorator'
import { ResponseMessage } from '@/commons/decorators/response-message.decorator'

import {
  BulkPersonSummaryStatusDto,
  PersonSummaryQueryDto,
  SavePersonSummaryDto,
} from './dto/request/person-summaries.dto'
import { PersonSummaryListResponseDto, PersonSummaryResponseDto } from './dto/response/person-summaries-response.dto'
import { PersonSummariesService } from './person-summaries.service'

// Resumen by person and month: status (Borrador → En progreso → Pagado), dates, note and manual adjustments
@ApiRest('summary')
@Controller('person-summaries')
export class PersonSummariesController {
  constructor(private readonly personSummariesService: PersonSummariesService) {}

  @Get()
  @ApiOperation({ summary: 'What was decided for each person in a month (a person without a row is a draft)' })
  @ApiOkResponse({ type: PersonSummaryListResponseDto })
  @ResponseMessage('PERSON_SUMMARIES_LISTED', 'Person summaries listed')
  list(@Query() { month, year }: PersonSummaryQueryDto) {
    return this.personSummariesService.list(month, year)
  }

  @Post('status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cambio en masa: the same status for several people of a month' })
  @ApiOkResponse({ type: PersonSummaryListResponseDto })
  @ResponseMessage('PERSON_SUMMARIES_STATUS', 'Status changed')
  setStatus(@Body() body: BulkPersonSummaryStatusDto) {
    return this.personSummariesService.setStatus(body)
  }

  @Put(':personId')
  @ApiOperation({ summary: 'Save the status, cutoff date, collect-by date, note or adjustments of a person and month' })
  @ApiOkResponse({ type: PersonSummaryResponseDto })
  @ResponseMessage('PERSON_SUMMARY_SAVED', 'Person summary saved')
  save(@Param('personId') personId: string, @Body() body: SavePersonSummaryDto) {
    return this.personSummariesService.save(personId, body)
  }
}
