import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import { APP_TIME_ZONE } from '@/commons/constants/app.constant'
import { BotAction, BotCommand } from '@/commons/constants/conversation.constant'
import { ReportFormat } from '@/commons/constants/report.constant'
import { DateHelper } from '@/commons/helpers/date.helper'
import { ReportsService } from '@/modules/reports/reports.service'
import { ExtractionCatalog, ResolvedExpense } from '@/modules/expense-extraction/dto/expense-extraction.types'
import { AuthConfig } from '@/settings/settings.model'

import { encodeBotAction } from '../bot-action.codec'
import { BotActionPayload, BotReply, ChannelMessage } from '../dto/conversation.types'
import { parseMonthArg } from '../month-arg.parser'
import { helpHub, paymentsHub, queryHub, registerHub, settingsHub } from './hubs.messages'
import { QuickExpensesService } from './quick-expenses.service'
import { ReconcileService } from './reconcile.service'
import { RulesService } from './rules.service'
import { ChartService } from './chart.service'
import { QuestionService } from './question.service'
import { QUESTION_TEXTS } from './question.messages'
import { EXPORT_TEXTS, monthLabel } from './spending.messages'
import { SpendingQueriesService } from './spending-queries.service'
import { TRIP_TEXTS } from './trip.messages'
import { TripsService } from './trips.service'
import { UndoService } from './undo.service'

const AWAITING_MS = 10 * 60_000

// The commands behind the seven groups of the menu (P18, D128). ConversationService asks it first for the commands it
// does not know; it answers null for the rest. A command that needs text and came without it (a button) asks for it and
// waits: the next message of that chat is its argument
@Injectable()
export class BotToolsService {
  private readonly awaiting = new Map<string, { command: BotCommand; expiresAt: number }>()
  // The fixed keyboard is one press to show and another to hide; Telegram keeps it, this only remembers what we sent
  private readonly keyboardShown = new Set<string>()

  constructor(
    private readonly spendingQueriesService: SpendingQueriesService,
    private readonly quickExpensesService: QuickExpensesService,
    private readonly undoService: UndoService,
    private readonly tripsService: TripsService,
    private readonly reconcileService: ReconcileService,
    private readonly rulesService: RulesService,
    private readonly chartService: ChartService,
    private readonly questionService: QuestionService,
    private readonly reportsService: ReportsService,
    private readonly configService: ConfigService,
  ) {}

  // ✏️ the next text of the chat is the argument of this command (10 minutes; in memory, one process)
  await(chatId: string, command: BotCommand): void {
    this.awaiting.set(chatId, { command, expiresAt: Date.now() + AWAITING_MS })
  }

  // The command that was waiting for text, once (any command or button drops the wait)
  takeAwaiting(chatId: string): BotCommand | null {
    const waiting = this.awaiting.get(chatId)
    this.awaiting.delete(chatId)
    return waiting && waiting.expiresAt > Date.now() ? waiting.command : null
  }

  clearAwaiting(chatId: string): void {
    this.awaiting.delete(chatId)
  }

  async handleCommand(message: ChannelMessage): Promise<BotReply[] | null> {
    switch (message.command) {
      case BotCommand.REGISTER:
        return [registerHub()]
      case BotCommand.QUERY:
        return [queryHub()]
      case BotCommand.PAYMENTS:
        return [paymentsHub()]
      case BotCommand.SETTINGS:
        return [settingsHub()]
      case BotCommand.TODAY:
        return [await this.spendingQueriesService.today()]
      case BotCommand.WEEK:
        return [await this.spendingQueriesService.week()]
      case BotCommand.CARDS:
        return [await this.spendingQueriesService.cards()]
      case BotCommand.WEB:
        return [this.webReply()]
      case BotCommand.QUICK:
        return [await this.quickExpensesService.reply()]
      case BotCommand.UNDO:
        return [await this.undoService.prompt(message.channel, message.chatId)]
      case BotCommand.TRIP: {
        const reply = await this.tripsService.open(this.argsOf(message))
        if (reply) return [reply]
        this.await(message.chatId, BotCommand.TRIP)
        return [{ text: TRIP_TEXTS.askName }]
      }
      case BotCommand.TRIP_END:
        return [await this.tripsService.close()]
      case BotCommand.CHART:
        return [await this.chartService.reply(this.argsOf(message))]
      case BotCommand.ASK: {
        const question = this.argsOf(message)
        if (question) return [await this.questionService.ask(question)]
        this.await(message.chatId, BotCommand.ASK)
        return [{ text: QUESTION_TEXTS.ask }]
      }
      case BotCommand.RULES:
        return [await this.rulesService.list()]
      case BotCommand.EXPORT:
        return [await this.exportPrompt(this.argsOf(message))]
      case BotCommand.RECONCILE: {
        const { reply, asksCard } = await this.reconcileService.reply(this.argsOf(message))
        if (asksCard) this.await(message.chatId, BotCommand.RECONCILE)
        return [reply]
      }
      case BotCommand.KEYBOARD:
        return [this.keyboardReply(message.chatId, message.text)]
      case BotCommand.START:
      case BotCommand.HELP:
        return [helpHub()]
      default:
        return null
    }
  }

  // "/viaje Lima" → "Lima"
  private argsOf(message: ChannelMessage): string {
    return (message.text ?? '').trim().split(/\s+/).slice(1).join(' ')
  }

  // The expense behind a ⚡ button, or null when it is no longer one of the repeated ones
  quickExpense(key: string) {
    return this.quickExpensesService.find(key)
  }

  // /exportar [mes]: the month, then Excel or PDF ("exp:<format>-<yyyy-mm>")
  private async exportPrompt(args: string): Promise<BotReply> {
    const period = parseMonthArg(args, DateHelper.todayIn(APP_TIME_ZONE))
    if (!period) return { text: EXPORT_TEXTS.usage }
    const label = monthLabel(period.month, period.year)
    const rows = await this.spendingQueriesService.monthRows(period.month, period.year)
    if (!rows.length) return { text: EXPORT_TEXTS.empty(label) }

    const key = `${period.year}-${String(period.month).padStart(2, '0')}`
    const button = (text: string, format: ReportFormat) => ({
      label: text,
      data: encodeBotAction({ name: BotAction.EXPORT, draftId: `${format}-${key}` }),
    })
    return {
      text: EXPORT_TEXTS.choose(label, rows.length),
      buttons: [[button('📥 Excel', ReportFormat.XLSX), button('📄 PDF', ReportFormat.PDF)]],
    }
  }

  // 📥 Excel · 📄 PDF of /exportar
  async exportFile({ draftId }: BotActionPayload): Promise<BotReply | null> {
    const match = /^(xlsx|pdf)-(\d{4})-(\d{2})$/.exec(draftId)
    if (!match) return null
    const [, format, year, month] = match
    const period = { month: Number(month), year: Number(year) }
    const rows = await this.spendingQueriesService.monthRows(period.month, period.year)
    const file = await this.reportsService.expenses(format as ReportFormat, period, rows)
    return { text: `📎 ${file.filename}`, document: file }
  }

  // The merchant rules (D129): applied to what was just extracted, learned from a correction, deleted from /reglas
  applyRules(expenses: ResolvedExpense[], catalog: ExtractionCatalog) {
    return this.rulesService.apply(expenses, catalog)
  }

  learnRule(...args: Parameters<RulesService['learn']>) {
    return this.rulesService.learn(...args)
  }

  removeRule(id: string) {
    return this.rulesService.remove(id)
  }

  undoConfirm(chatId: string, draftId: string) {
    return this.undoService.confirm(chatId, draftId)
  }

  undoCancel() {
    return this.undoService.cancel()
  }

  // /teclado: shows the fixed keyboard (⚡ Rápido · 📝 Borrador · 📊 Consultar) or hides it. "/teclado ocultar" and
  // "/teclado mostrar" say it; alone it flips what it sent last
  private keyboardReply(chatId: string, text?: string): BotReply {
    const arg = (text ?? '').trim().split(/\s+/)[1]?.toLowerCase()
    const show = arg ? !/^(ocultar|off|quitar)/.test(arg) : !this.keyboardShown.has(chatId)
    if (show) this.keyboardShown.add(chatId)
    else this.keyboardShown.delete(chatId)
    return show
      ? {
          text: '⌨️ Teclado activado: ⚡ Rápido · 📝 Borrador · 📊 Consultar. Para quitarlo, toca ⌨️ Teclado otra vez.',
          keyboard: 'show',
        }
      : { text: '⌨️ Teclado oculto. Vuelve a tocar ⌨️ Teclado cuando lo quieras.', keyboard: 'hide' }
  }

  // /web: links to kogane-app (URL buttons: they open the page)
  private webReply(): BotReply {
    const base = this.configService.getOrThrow<AuthConfig>('auth').appUrl.replace(/\/$/, '')
    const link = (label: string, path: string) => ({ label, data: '', url: `${base}${path}` })
    return {
      text: '🌐 <b>Kogane en la web</b>\nAhí ves los gráficos, editas en tablas y administras tu cuenta.',
      buttons: [
        [link('🏠 Inicio', '/'), link('📊 Resumen', '/resumen')],
        [link('💳 Tarjetas', '/tarjetas'), link('💸 Deudas', '/deudas')],
        [link('📅 Calendario', '/calendario'), link('📝 Borrador', '/borrador')],
      ],
    }
  }
}
