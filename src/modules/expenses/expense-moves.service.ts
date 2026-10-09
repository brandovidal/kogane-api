import { Injectable } from '@nestjs/common'

import { rowsFrom } from '@/commons/helpers/expense-move.helper'
import { ExpenseMoveBlockedException } from '@/commons/exceptions/expense/expense-move-blocked.exception'
import { ExpenseRecordDBRepository, ExpenseResource } from '@/db/models/expense-record/expenseRecordDB.repository'

import { MoveSeriesDto } from './dto/request/expense-moves.dto'

// "Pasar a…" (D106): Costos fijos ↔ Recurrentes ↔ Plataformas, always the whole series
@Injectable()
export class ExpenseMovesService {
  constructor(private readonly expenseRecordDBRepository: ExpenseRecordDBRepository) {}

  async move({ resource, id, to, kind, period, categoryId, dryRun, mode = 'move', from: fromMonth }: MoveSeriesDto) {
    const found = await this.expenseRecordDBRepository.findSeries(resource, id)
    const series = { ...found, rows: rowsFrom(found.rows, fromMonth) }
    const first = series.rows[0]
    const last = series.rows[series.rows.length - 1]
    const needsCategory = to === ExpenseResource.FIXED_COST && resource !== to
    const blockedIds = new Set(series.blockedIds)
    const answer = {
      dryRun: !!dryRun,
      mode,
      count: series.rows.length,
      from: first ? { month: first.paymentMonth, year: first.paymentYear } : null,
      until: last ? { month: last.paymentMonth, year: last.paymentYear } : null,
      templates: series.templates,
      withoutCategory: needsCategory ? series.rows.filter((row) => !row.categoryId).length : 0,
      // A copy leaves the series where it is: an /editar copy open on it blocks nothing
      blocked: series.rows
        .filter((row) => mode === 'move' && blockedIds.has(row.id))
        .map((row) => ({ id: row.id, month: row.paymentMonth, year: row.paymentYear })),
    }
    if (dryRun) return answer

    if (answer.blocked.length || (answer.withoutCategory && !categoryId)) {
      throw new ExpenseMoveBlockedException({ blocked: answer.blocked, withoutCategory: answer.withoutCategory })
    }
    if (mode === 'copy') {
      await this.expenseRecordDBRepository.copySeries(
        resource,
        to,
        series.rows.map((row) => row.id),
        { kind, period, categoryId },
      )
      return answer
    }
    await this.expenseRecordDBRepository.moveSeries(
      resource,
      to,
      series.rows.map((row) => row.id),
      { kind, period, categoryId },
    )
    return answer
  }
}
