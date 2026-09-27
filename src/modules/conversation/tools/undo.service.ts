import { Injectable } from '@nestjs/common'

import { BotAction } from '@/commons/constants/conversation.constant'
import { ExpenseDraftChannel, ExpenseDraftStatus } from '@/commons/constants/expense-draft.constant'
import { SavedExpenseLockedException } from '@/commons/exceptions/expense/saved-expense-locked.exception'
import { ExpenseDraftDBRepository } from '@/db/models/expense-draft/expenseDraftDB.repository'
import { ExpenseDBRepository } from '@/db/models/expense/expenseDB.repository'

import { encodeBotAction } from '../bot-action.codec'
import { escapeHtml, formatAmount, TEXTS } from '../conversation.messages'
import { BotReply } from '../dto/conversation.types'

// /deshacer (P18): cancels the last expense saved in this chat. Asks first; the debts it created go with it unless one
// already has payments (then it stays: SavedExpenseLockedException)
@Injectable()
export class UndoService {
  constructor(
    private readonly expenseDraftDBRepository: ExpenseDraftDBRepository,
    private readonly expenseDBRepository: ExpenseDBRepository,
  ) {}

  async prompt(channel: ExpenseDraftChannel, chatId: string): Promise<BotReply> {
    const [last] = await this.expenseDraftDBRepository.findRecentSaved(channel, chatId, 1)
    if (!last) return { text: '↩️ No hay un gasto guardado para anular.' }
    return {
      text: `↩️ ¿Anulo <b>${escapeHtml(last.description ?? 'el último gasto')}</b> (${formatAmount(last.amount, last.currency)})? Se borra de tus gastos.`,
      buttons: [
        [
          { label: '↩️ Sí, anular', data: encodeBotAction({ name: BotAction.UNDO, draftId: last.id }) },
          { label: 'No, dejarlo', data: encodeBotAction({ name: BotAction.UNDO_CANCEL, draftId: last.id }) },
        ],
      ],
    }
  }

  async confirm(chatId: string, draftId: string): Promise<BotReply> {
    const draft = await this.expenseDraftDBRepository.findById(draftId)
    if (!draft || draft.chatId !== chatId || draft.status !== ExpenseDraftStatus.SAVED) {
      return { text: TEXTS.alreadyProcessed, edit: true }
    }
    try {
      await this.expenseDBRepository.deleteSavedExpense(draftId)
    } catch (error) {
      if (error instanceof SavedExpenseLockedException) return { text: TEXTS.editLocked, edit: true }
      throw error
    }
    return {
      text: `↩️ Anulé <b>${escapeHtml(draft.description ?? 'el gasto')}</b> (${formatAmount(draft.amount, draft.currency)}).`,
      edit: true,
    }
  }

  cancel(): BotReply {
    return { text: '👍 Lo dejé como está.', edit: true }
  }
}
