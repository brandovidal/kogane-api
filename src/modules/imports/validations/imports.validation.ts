import { z } from 'zod'

import { ListImportTarget } from '../list/list-csv.mapper'

import {
  IMPORT_PAGE_SIZE,
  ImportBatchStatus,
  ImportRowKind,
  ImportRowStatus,
  ImportTab,
} from '@/commons/constants/import.constant'
import { dateTimeSchema } from '@/commons/helpers/api-response.helper'

export const importRowsQuerySchema = z.object({
  tab: z.enum(ImportTab).default(ImportTab.CARDS),
  status: z.enum(ImportRowStatus).optional(),
  q: z.string().trim().max(80).optional().describe('Search in the description'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(IMPORT_PAGE_SIZE),
})

// ==================== Responses (Swagger / kogane-app types) ====================

const monthCheckSchema = z.object({
  month: z.number().int(),
  year: z.number().int(),
  spent: z.number().describe('Fixed costs + cards of the payment month in soles, everyone’s'),
  salary: z.number().nullable(),
  surplus: z.number().nullable(),
  linked: z.number().describe('Rows linked to the Resumen page of the month, as Notion adds them'),
  notionSpent: z.number().nullable().describe('"Gastos" of that Resumen page: equal to linked when all came through'),
})

export const importBatchResponseSchema = z.object({
  id: z.string(),
  source: z.string(),
  sourceDir: z.string(),
  status: z.enum(ImportBatchStatus),
  files: z.number().int(),
  created: z.number().int().describe('New rows (on a preview: to create)'),
  updated: z.number().int().describe('Rows that changed in Notion'),
  unchanged: z.number().int().describe('Same rows as the last import: not touched'),
  appliedAt: dateTimeSchema.nullable(),
  createdAt: dateTimeSchema,
})

export const importDetailResponseSchema = importBatchResponseSchema.extend({
  summary: z.object({
    files: z.array(z.object({ file: z.string(), base: z.string(), rows: z.number().int() })),
    months: z.array(monthCheckSchema),
  }),
  tabs: z.record(z.enum(ImportTab), z.number().int()).describe('Rows per tab'),
  blocked: z.number().int(),
  warnings: z.number().int(),
})

export const importRowResponseSchema = z.object({
  id: z.string(),
  kind: z.enum(ImportRowKind),
  status: z.enum(ImportRowStatus),
  message: z.string().nullable(),
  file: z.string(),
  line: z.number().int(),
  targetTable: z.string().nullable(),
  targetId: z.string().nullable(),
  destination: z.string().nullable().describe('Where it goes: "Tarjetas ▸ IO · Setiembre 2026"'),
  description: z.string().nullable(),
  amount: z.number().nullable(),
  currency: z.string().nullable(),
  month: z.number().int().nullable(),
  year: z.number().int().nullable(),
  data: z.record(z.string(), z.unknown()).describe('The Kogane row that is written'),
  raw: z.record(z.string(), z.string()).describe('The Notion CSV row'),
})

export const importRowsResponseSchema = z.object({
  items: z.array(importRowResponseSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
})

export const applyImportResponseSchema = z.object({
  batchId: z.string(),
  created: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  payments: z.number().int(),
  groups: z.number().int(),
  budgets: z.number().int(),
})

// "Importar … (CSV)" of the ⋯ menu of each list: preview first, apply=true creates the ready rows
export const listImportQuerySchema = z.object({
  target: z
    .enum(ListImportTarget)
    .describe('The list: daily-expenses, platforms, recurring-expenses, receivables or payables'),
  apply: z.stringbool().optional().describe('Create the ready rows; without it only a preview'),
})

export const listImportResponseSchema = z.object({
  target: z.enum(ListImportTarget),
  applied: z.boolean(),
  total: z.number().int(),
  ready: z.number().int().describe('Rows that would be created (preview)'),
  created: z.number().int().describe('Rows created (apply)'),
  withIssues: z.number().int(),
  rows: z.array(
    z.object({
      line: z.number().int().describe('Line of the CSV (the header is 1)'),
      description: z.string().nullable(),
      amount: z.number().nullable(),
      status: z.enum(['ready', 'issue', 'created']),
      issues: z.array(z.string()).describe('In Spanish, as the preview shows them'),
    }),
  ),
})
