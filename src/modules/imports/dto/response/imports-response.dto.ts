import { z } from 'zod'

import { responseDto } from '@/commons/helpers/api-response.helper'

import {
  applyImportResponseSchema,
  importBatchResponseSchema,
  importDetailResponseSchema,
  importRowsResponseSchema,
  listImportResponseSchema,
} from '../../validations/imports.validation'

export class ImportListResponseDto extends responseDto(z.array(importBatchResponseSchema)) {}
export class ImportDetailResponseDto extends responseDto(importDetailResponseSchema) {}
export class ImportRowsResponseDto extends responseDto(importRowsResponseSchema) {}
export class ApplyImportResponseDto extends responseDto(applyImportResponseSchema) {}
export class ListImportResponseDto extends responseDto(listImportResponseSchema) {}
