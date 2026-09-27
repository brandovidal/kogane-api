import { Injectable, Logger } from '@nestjs/common'

import { BotAction, BotCommand } from '@/commons/constants/conversation.constant'
import { CatalogKind, ExpenseField } from '@/commons/constants/expense-extraction.constant'
import { MerchantRuleDBRepository } from '@/db/models/merchant-rule/merchantRuleDB.repository'
import {
  ExtractionCatalog,
  ResolvedExpense,
  ResolvedExpenseFields,
} from '@/modules/expense-extraction/dto/expense-extraction.types'
import { findCatalogEntryById } from '@/modules/expense-extraction/expense-extraction.catalog'
import { ExpenseExtractionService } from '@/modules/expense-extraction/expense-extraction.service'

import { encodeBotAction } from '../bot-action.codec'
import { commandButtons } from '../conversation.messages'
import { BotReply } from '../dto/conversation.types'
import { applyRules, ruleKey } from './rules.helper'
import { formatRules, RULES_TEXTS } from './rules.messages'

const MAX_RULES = 10
const LABEL_MAX = 22

// The merchant rules (P18, D129): learned when the user corrects the category or the payment method of an expense,
// applied to the next expenses that say the same, listed and deleted with /reglas
@Injectable()
export class RulesService {
  private readonly logger = new Logger(RulesService.name)

  constructor(
    private readonly merchantRuleDBRepository: MerchantRuleDBRepository,
    private readonly expenseExtractionService: ExpenseExtractionService,
  ) {}

  // Fills in the category / payment method of freshly extracted expenses. A failure never blocks the expense
  async apply(expenses: ResolvedExpense[], catalog: ExtractionCatalog): Promise<ResolvedExpense[]> {
    try {
      return applyRules(expenses, await this.merchantRuleDBRepository.findAll(), catalog)
    } catch (error) {
      this.logger.warn(`[apply] ${(error as Error).message}`)
      return expenses
    }
  }

  // The user chose a category or a payment method: remember it for that merchant
  async learn(
    expense: Pick<ResolvedExpenseFields, 'merchant' | 'description'>,
    correction: Partial<ResolvedExpenseFields>,
  ): Promise<void> {
    const key = ruleKey(expense)
    const categoryId = correction[ExpenseField.CATEGORY] ?? undefined
    const paymentMethodId = correction[ExpenseField.PAYMENT_METHOD] ?? undefined
    if (!key || (!categoryId && !paymentMethodId)) return
    try {
      await this.merchantRuleDBRepository.learn(key, { categoryId, paymentMethodId })
    } catch (error) {
      this.logger.warn(`[learn] ${(error as Error).message}`)
    }
  }

  // /reglas: the last ones, each with its delete button
  async list(): Promise<BotReply> {
    const [rules, catalog] = await Promise.all([
      this.merchantRuleDBRepository.findAll(),
      this.expenseExtractionService.loadCatalog(),
    ])
    if (!rules.length) return { text: RULES_TEXTS.empty }

    const shown = rules.slice(0, MAX_RULES).map((rule) => ({
      id: rule.id,
      merchant: rule.merchant,
      category: this.nameOf(catalog, rule.categoryId, CatalogKind.CATEGORY),
      method: this.nameOf(catalog, rule.paymentMethodId, CatalogKind.PAYMENT_METHOD),
    }))
    return {
      text: formatRules(shown) + (rules.length > shown.length ? `\n… y ${rules.length - shown.length} más` : ''),
      buttons: [
        ...shown.map((rule) => [
          {
            label: `🗑️ ${rule.merchant.slice(0, LABEL_MAX)}`,
            data: encodeBotAction({ name: BotAction.RULE_DELETE, draftId: rule.id }),
          },
        ]),
        ...commandButtons(BotCommand.SETTINGS),
      ],
    }
  }

  // 🗑️ of /reglas: deletes it and shows the list again
  async remove(id: string): Promise<{ reply: BotReply; notice: string }> {
    const removed = await this.merchantRuleDBRepository.delete(id)
    return { reply: { ...(await this.list()), edit: true }, notice: removed ? RULES_TEXTS.removed : RULES_TEXTS.gone }
  }

  private nameOf(catalog: ExtractionCatalog, id: string | null, kind: CatalogKind): string | null {
    const entry = findCatalogEntryById(catalog, id)
    return entry?.kind === kind ? entry.name : null
  }
}
