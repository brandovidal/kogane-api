import { Injectable } from '@nestjs/common'

import { BotAction } from '@/commons/constants/conversation.constant'
import { ExpenseDraftDbDto } from '@/db/models/expense-draft/expenseDraftDB.dto'
import { ExpenseDraftDBRepository } from '@/db/models/expense-draft/expenseDraftDB.repository'

import { encodeBotAction } from '../bot-action.codec'
import { formatAmount } from '../conversation.messages'
import { BotReply } from '../dto/conversation.types'
import { QUICK_LOOKBACK_DAYS, quickCandidates } from './quick.helper'

const DAY_MS = 24 * 60 * 60_000
const LOOKED_AT = 400 // saved expenses read to find the repeated ones
const LABEL_MAX = 22

const trim = (text: string) => (text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text)

// /rapido (P18): the expenses you save again and again, one tap each, without the AI
@Injectable()
export class QuickExpensesService {
  constructor(private readonly expenseDraftDBRepository: ExpenseDraftDBRepository) {}

  private async candidates() {
    const since = new Date(Date.now() - QUICK_LOOKBACK_DAYS * DAY_MS)
    return quickCandidates(await this.expenseDraftDBRepository.findSavedSince(since, LOOKED_AT))
  }

  async reply(): Promise<BotReply> {
    const candidates = await this.candidates()
    if (!candidates.length) {
      return {
        text: '⚡ Todavía no tengo gastos repetidos. Cuando guardes dos veces el mismo (concepto, monto, medio de pago y categoría) aparecerá aquí para guardarlo de un toque.',
      }
    }
    const buttons = candidates.map((candidate) => ({
      label: `${trim(candidate.description)} ${formatAmount(candidate.amount, candidate.currency)}`,
      data: encodeBotAction({ name: BotAction.QUICK, draftId: candidate.key }),
    }))
    return {
      text: '⚡ <b>Rápido</b>\nTus gastos más repetidos de los últimos 3 meses. Un toque y se guarda con la fecha de hoy.',
      buttons: buttons.reduce<(typeof buttons)[]>((rows, button, index) => {
        if (index % 2 === 0) rows.push([])
        rows[rows.length - 1].push(button)
        return rows
      }, []),
    }
  }

  // The expense behind a button (the list is read again: the button may be old)
  async find(key: string): Promise<ExpenseDraftDbDto | null> {
    return (await this.candidates()).find((candidate) => candidate.key === key)?.sample ?? null
  }
}
