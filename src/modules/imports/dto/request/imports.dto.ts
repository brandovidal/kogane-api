import { createZodDto } from 'nestjs-zod'

import { importRowsQuerySchema, listImportQuerySchema } from '../../validations/imports.validation'

export class ImportRowsQueryDto extends createZodDto(importRowsQuerySchema) {}
export class ListImportQueryDto extends createZodDto(listImportQuerySchema) {}
