import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express'
import { ApiBody, ApiConsumes, ApiOkResponse, ApiOperation } from '@nestjs/swagger'

import { MAX_IMPORT_BYTES } from '@/commons/constants/import.constant'
import { ApiRest } from '@/commons/decorators/api-rest.decorator'
import { ResponseMessage } from '@/commons/decorators/response-message.decorator'
import { EmptyResponseDto } from '@/commons/helpers/api-response.helper'

import { ImportRowsQueryDto, ListImportQueryDto } from './dto/request/imports.dto'
import { ListImportFile, ListImportService } from './list/list-import.service'
import {
  ApplyImportResponseDto,
  ImportDetailResponseDto,
  ImportListResponseDto,
  ImportRowsResponseDto,
  ListImportResponseDto,
} from './dto/response/imports-response.dto'
import { ImportsService, UploadedImportFile } from './imports.service'

// Reconocimiento / Importación (P14, D104)
@ApiRest('imports')
@Controller('imports')
export class ImportsController {
  constructor(
    private readonly importsService: ImportsService,
    private readonly listImportService: ListImportService,
  ) {}

  @Post('list')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description:
            'CSV with the columns of "Exportar lista (CSV)" (Descripción, Monto, Moneda, Fecha, Mes de pago…)',
        },
      },
    },
  })
  @ApiOperation({
    summary: '"Importar gastos… / plataformas… / recurrentes… / cuotas… / deudas…": preview, or create with apply=true',
  })
  @ApiOkResponse({ type: ListImportResponseDto })
  @ResponseMessage('LIST_IMPORTED', 'List import read')
  importList(@Query() { target, apply }: ListImportQueryDto, @UploadedFile() file?: ListImportFile) {
    return this.listImportService.run(target, file, !!apply)
  }

  @Post('notion')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FilesInterceptor('files', 60, { limits: { fileSize: MAX_IMPORT_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['files'],
      properties: {
        files: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          description: 'The ZIP exported by Notion, or its CSV files',
        },
      },
    },
  })
  @ApiOperation({ summary: 'Read a Notion export and save it as a preview (nothing is written in the expenses)' })
  @ApiOkResponse({ type: ImportDetailResponseDto })
  @ResponseMessage('IMPORT_PREVIEWED', 'Import ready to review')
  previewNotion(@UploadedFiles() files: UploadedImportFile[] = []) {
    return this.importsService.previewNotion(files)
  }

  @Get()
  @ApiOperation({ summary: 'Notion imports, newest first' })
  @ApiOkResponse({ type: ImportListResponseDto })
  @ResponseMessage('IMPORTS_LISTED', 'Imports listed')
  list() {
    return this.importsService.list()
  }

  @Get(':id')
  @ApiOperation({ summary: 'An import with its month-by-month check and the rows per tab' })
  @ApiOkResponse({ type: ImportDetailResponseDto })
  @ResponseMessage('IMPORT_FOUND', 'Import found')
  get(@Param('id') id: string) {
    return this.importsService.get(id)
  }

  @Get(':id/rows')
  @ApiOperation({ summary: 'The rows of one tab, paginated, with where each one goes' })
  @ApiOkResponse({ type: ImportRowsResponseDto })
  @ResponseMessage('IMPORT_ROWS_LISTED', 'Rows listed')
  rows(@Param('id') id: string, @Query() query: ImportRowsQueryDto) {
    return this.importsService.rows(id, query)
  }

  @Post(':id/apply')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Write a preview: new rows created, changed ones updated, the same ones left alone' })
  @ApiOkResponse({ type: ApplyImportResponseDto })
  @ResponseMessage('IMPORT_APPLIED', 'Import applied')
  apply(@Param('id') id: string) {
    return this.importsService.apply(id)
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Discard a preview' })
  @ApiOkResponse({ type: EmptyResponseDto })
  @ResponseMessage('IMPORT_DISCARDED', 'Import discarded')
  async discard(@Param('id') id: string) {
    await this.importsService.discard(id)
    return null
  }
}
