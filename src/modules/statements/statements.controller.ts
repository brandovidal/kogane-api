import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { ApiBody, ApiConsumes, ApiOkResponse, ApiOperation } from '@nestjs/swagger'

import { MAX_STATEMENT_BYTES } from '@/commons/constants/statement.constant'
import { ApiRest } from '@/commons/decorators/api-rest.decorator'
import { ResponseMessage } from '@/commons/decorators/response-message.decorator'
import { EmptyResponseDto } from '@/commons/helpers/api-response.helper'

import {
  AssignRowsDto,
  CreateNewRowsDto,
  UpdateRowDto,
  UpdateStatementDto,
  UploadStatementDto,
} from './dto/request/statements.dto'
import {
  StatementFileResponseDto,
  StatementListResponseDto,
  StatementResponseDto,
} from './dto/response/statements-response.dto'
import { StatementsService } from './statements.service'

// Estados de cuenta (P14 block 2, D95)
@ApiRest('statements')
@Controller('statements')
export class StatementsController {
  constructor(private readonly statementsService: StatementsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_STATEMENT_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'Statement PDF (≤ 15 MB)' },
        password: { type: 'string', description: 'Only when the saved document number does not open it' },
        paymentMethodId: { type: 'string', description: 'Only when the statement does not say which card' },
        personId: {
          type: 'string',
          description: 'Optional person override; otherwise detected from the statement holder',
        },
        saveCardPassword: {
          type: 'boolean',
          description: 'Save the typed password on the card of the statement (I12), if it opened it',
        },
        savePassword: {
          type: 'boolean',
          description: 'Save the typed password as the document number of the statement person (if it opened it)',
        },
      },
    },
  })
  @ApiOperation({ summary: 'Read a statement PDF and reconcile it with the card expenses of its month' })
  @ApiOkResponse({ type: StatementResponseDto })
  @ResponseMessage('STATEMENT_READ', 'Statement read')
  upload(@Body() body: UploadStatementDto, @UploadedFile() file?: { buffer: Buffer; mimetype: string }) {
    if (!file?.buffer?.length) throw new BadRequestException('file is required')
    return this.statementsService.upload({ data: file.buffer, ...body })
  }

  @Get()
  @ApiOperation({ summary: 'Statements read, newest month first, with their row counts' })
  @ApiOkResponse({ type: StatementListResponseDto })
  @ResponseMessage('STATEMENTS_LISTED', 'Statements listed')
  list() {
    return this.statementsService.list()
  }

  @Get(':id/file')
  @ApiOperation({ summary: '"Ver estado de cuenta": a signed link (10 minutes) to its PDF; url null when not kept' })
  @ApiOkResponse({ type: StatementFileResponseDto })
  @ResponseMessage('STATEMENT_FILE', 'Statement file link')
  file(@Param('id') id: string) {
    return this.statementsService.fileUrl(id)
  }

  @Get(':id')
  @ApiOperation({ summary: 'A statement with its rows, the card expenses missing from it and both totals' })
  @ApiOkResponse({ type: StatementResponseDto })
  @ResponseMessage('STATEMENT_FOUND', 'Statement found')
  get(@Param('id') id: string) {
    return this.statementsService.get(id)
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Assign the statement to another person' })
  @ApiOkResponse({ type: StatementResponseDto })
  @ResponseMessage('STATEMENT_UPDATED', 'Statement updated')
  update(@Param('id') id: string, @Body() body: UpdateStatementDto) {
    return this.statementsService.update(id, body)
  }

  @Post(':id/rows/assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Give several purchases not saved yet to a person (the additional card or who pays it)' })
  @ApiOkResponse({ type: StatementResponseDto })
  @ResponseMessage('STATEMENT_ROWS_ASSIGNED', 'Rows assigned')
  assignRows(@Param('id') id: string, @Body() body: AssignRowsDto) {
    return this.statementsService.assignRows(id, body)
  }

  @Post(':id/create-new')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Create the new rows (all, or the given ones even if matched or ignored) as pending card expenses',
  })
  @ApiOkResponse({ type: StatementResponseDto })
  @ResponseMessage('STATEMENT_ROWS_CREATED', 'Rows created')
  createNew(@Param('id') id: string, @Body() { rowIds }: CreateNewRowsDto) {
    return this.statementsService.createNew(id, rowIds)
  }

  @Patch(':id/rows/:rowId')
  @ApiOperation({ summary: 'Ignore a row, bring an ignored one back, or give it your description' })
  @ApiOkResponse({ type: StatementResponseDto })
  @ResponseMessage('STATEMENT_ROW_UPDATED', 'Row updated')
  updateRow(@Param('id') id: string, @Param('rowId') rowId: string, @Body() body: UpdateRowDto) {
    return this.statementsService.updateRow(id, rowId, body)
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a statement and its rows (the expenses it created stay)' })
  @ApiOkResponse({ type: EmptyResponseDto })
  @ResponseMessage('STATEMENT_DELETED', 'Statement deleted')
  async delete(@Param('id') id: string) {
    await this.statementsService.delete(id)
    return null
  }
}
