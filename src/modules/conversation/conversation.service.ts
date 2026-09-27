import { randomUUID } from 'node:crypto'

import { Injectable, Logger } from '@nestjs/common'

import { APP_TIME_ZONE } from '@/commons/constants/app.constant'
import {
  BotAction,
  BotCommand,
  CARD_DAYS_FIELD_PREFIX,
  ChannelMessageType,
  BATCH_ACTIONS,
  KEYBOARD_COMMANDS,
  TOOL_ACTIONS,
  DEBT_PAYMENT_ACTIONS,
  NOTIFICATION_ACTIONS,
  FREE_CORRECTION_FIELD,
  DRAFTS_LIMIT,
  MAX_AUDIO_SECONDS,
  MAX_IMAGE_BYTES,
  RECENT_EXPENSES_LIMIT,
} from '@/commons/constants/conversation.constant'
import { PaymentMethodType } from '@/commons/constants/catalog.constant'
import { DebtDirection } from '@/commons/constants/debt.constant'
import { Currency, ExpenseDestination, SubscriptionPeriod } from '@/commons/constants/expense.constant'
import {
  EXPENSE_DRAFT_EXPIRATION_MINUTES,
  ExpenseDraftChannel,
  ExpenseDraftInputType,
  ExpenseDraftStatus,
  OPEN_EXPENSE_DRAFT_STATUSES,
  REVIEW_EXPENSE_DRAFT_STATUSES,
} from '@/commons/constants/expense-draft.constant'
import { CatalogKind, ExpenseField } from '@/commons/constants/expense-extraction.constant'
import { dayStart } from '@/commons/helpers/charge.helper'
import { DateHelper } from '@/commons/helpers/date.helper'
import { DuplicateExpenseDraftException } from '@/commons/exceptions/expense-draft/duplicate-expense-draft.exception'
import { StoredFileExpiredException } from '@/commons/exceptions/stored-file/stored-file-expired.exception'
import { SavedExpenseLockedException } from '@/commons/exceptions/expense/saved-expense-locked.exception'
import { ExpenseDraftDBRepository } from '@/db/models/expense-draft/expenseDraftDB.repository'
import { ExpenseDraftDbDto, SharedExpense, UpdateExpenseDraftDbDto } from '@/db/models/expense-draft/expenseDraftDB.dto'
import { ExpenseDBRepository } from '@/db/models/expense/expenseDB.repository'
import { PaymentMethodDBRepository } from '@/db/models/payment-method/paymentMethodDB.repository'
import { ExpenseExtractionService } from '@/modules/expense-extraction/expense-extraction.service'
import { completeExpense, withPrimaryCard } from '@/modules/expense-extraction/expense-extraction.resolver'
import {
  findCatalogEntryById,
  findDefaultPerson,
  matchCatalogEntry,
  normalizeText,
} from '@/modules/expense-extraction/expense-extraction.catalog'
import { DebtsService } from '@/modules/debts/debts.service'
import { RecognitionService } from '@/modules/recognition/recognition.service'
import { BudgetService } from '@/modules/budget/budget.service'
import { ReportsService } from '@/modules/reports/reports.service'
import { NotificationsBotService } from '@/modules/notifications/notifications-bot.service'
import { ReportFormat } from '@/commons/constants/report.constant'
import { RecognitionResult, RecognizedScreen } from '@/modules/recognition/recognition.templates'
import { StoredFilesService } from '@/modules/stored-files/stored-files.service'
import {
  ExtractionCatalog,
  ReceivedPayment,
  ResolvedExpense,
  ResolvedExpenseFields,
  MediaFile,
} from '@/modules/expense-extraction/dto/expense-extraction.types'

import { parseDebtPayment } from './debt-payment.parser'
import { sameMerchant } from './duplicate.helper'
import { formatReconciliation } from './recognition.messages'
import { BUDGET_TEXTS, formatBudget, formatBudgetAlert, formatForecast } from './budget.messages'
import { parseMonthArg } from './month-arg.parser'
import { parseShare, parseShareCorrection, parseSharedExpense, SharedExpenseMatch } from './shared-expense.parser'
import { parseSavedSearch } from './saved-search.parser'
import {
  buildInstallmentPickerReply,
  buildPaymentProposalReply,
  buildPaymentSavedReply,
  DEBT_TEXTS,
  debtReportButtons,
  formatCollectMessage,
  formatDebtSummary,
  formatPersonDebts,
  REPORT_FOR_EVERYONE,
} from './debt.messages'
import { encodeBotAction } from './bot-action.codec'
import { ExpenseSaverService } from './expense-saver.service'
import { BotToolsService } from './tools/bot-tools.service'
import { helpHub } from './tools/hubs.messages'
import { EXPORT_TEXTS, monthUsage } from './tools/spending.messages'
import { TRIP_TEXTS } from './tools/trip.messages'
import { MediaDownloaderRegistry } from './media-downloader.registry'
import { needsInstallmentConfirmation, toExpenseFields, toExpenseDraftUpdate } from './expense-draft.mapper'
import {
  DESTINATION_LABELS,
  TEXTS,
  formatAmount,
  buildClosedReply,
  buildBatchReply,
  buildParkedNotice,
  buildSavedNotice,
  conceptOf,
  nameOf,
  buildInstallmentsConfirmReply,
  MONTH_NAMES,
  buildExpenseReply,
  buildDraftReplies,
  buildSavedSearchReply,
  buildClosedShareReply,
  buildShareReply,
  formatSharedDebts,
  SHARE_CHOICE_RATIOS,
  ShareChoice,
  commandButtons,
  withCommandButtons,
  buildNewPaymentMethodReply,
  formatMonthlyTotals,
  formatAiUsage,
  formatRecent,
  toNewPaymentMethodName,
} from './conversation.messages'
import {
  AlbumItem,
  BotActionPayload,
  BotReply,
  BudgetImpact,
  ChannelMessage,
  ConversationResult,
  SavedExpense,
} from './dto/conversation.types'

// Overlapping screenshots are compared against what was registered in this window (P21)
const DUPLICATE_LOOKBACK_DAYS = 60

// /editar (D76): corrections keep the copy in EDITING (they would make it a new draft otherwise)
const keepEditing = (expenseDraft: ExpenseDraftDbDto, update: UpdateExpenseDraftDbDto): UpdateExpenseDraftDbDto =>
  expenseDraft.status === ExpenseDraftStatus.EDITING && update.status !== ExpenseDraftStatus.DISCARDED
    ? { ...update, status: ExpenseDraftStatus.EDITING }
    : update

// ✏️ of the split message (D75): an amount up to the total is an amount; above it and up to 100 it can only be a
// percentage ("50" of S/ 20 is 50 %); above both it cannot be owed
const SHARE_OVER_TOTAL = 'over-total'
function shareOfTotal(
  share: ReturnType<typeof parseShare>,
  total: number,
): ReturnType<typeof parseShare> | typeof SHARE_OVER_TOTAL {
  if (!share || share.amount == null || share.amount <= total) return share
  return share.amount <= 100 ? { ratio: share.amount / 100 } : SHARE_OVER_TOTAL
}

// Split message ✏️ (D75): "share:<person index>" while the bot waits for that person's part
const SHARE_FIELD_PREFIX = 'share:'

// /editar: results shown at most
const SAVED_SEARCH_LIMIT = 5

// Closed-for-now expenses of Borrador that accept only Retomar and Descartar
const PARKED_STATUSES = [ExpenseDraftStatus.PENDING_REVIEW, ExpenseDraftStatus.FAILED]

// "cierre 15, pago 5" or "15 5"
const CARD_DAYS_REGEX = /(\d{1,2})\D+(\d{1,2})/

// Channel-agnostic conversation: one ExpenseDraft per expense, one question at a time, confirm with buttons
@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name)

  constructor(
    private readonly expenseDraftDBRepository: ExpenseDraftDBRepository,
    private readonly expenseDBRepository: ExpenseDBRepository,
    private readonly paymentMethodDBRepository: PaymentMethodDBRepository,
    private readonly expenseExtractionService: ExpenseExtractionService,
    private readonly expenseSaverService: ExpenseSaverService,
    private readonly mediaDownloaderRegistry: MediaDownloaderRegistry,
    private readonly storedFilesService: StoredFilesService,
    private readonly debtsService: DebtsService,
    private readonly recognitionService: RecognitionService,
    private readonly budgetService: BudgetService,
    private readonly reportsService: ReportsService,
    private readonly notificationsBotService: NotificationsBotService,
    private readonly botToolsService: BotToolsService,
  ) {}

  async handle(message: ChannelMessage): Promise<ConversationResult> {
    const result = await this.route(message)
    return { ...result, replies: result.replies.map(withCommandButtons) }
  }

  private async route(message: ChannelMessage): Promise<ConversationResult> {
    switch (message.type) {
      case ChannelMessageType.COMMAND:
        return { replies: await this.handleCommand(message) }
      case ChannelMessageType.ACTION:
        return this.handleAction(message)
      case ChannelMessageType.IMAGE:
      case ChannelMessageType.AUDIO:
        return { replies: await this.handleMedia(message) }
      default:
        return { replies: await this.handleText(message) }
    }
  }

  private async handleText(message: ChannelMessage): Promise<BotReply[]> {
    const text = message.text?.trim()
    if (!text) return []

    // The amount asked by ✏️ Editar monto of a reminder (P20); any other text drops that wait
    const amountReply = await this.notificationsBotService.answerAmount(message.chatId, text)
    if (amountReply) return amountReply

    // A key of the fixed keyboard (/teclado) is a command
    const key = KEYBOARD_COMMANDS[text]
    if (key) return this.handleCommand({ ...message, type: ChannelMessageType.COMMAND, command: key, text: `/${key}` })

    // A command from a button that asked for its text (/buscar, /pregunta, /viaje…): this message is its argument (P18)
    const waiting = this.botToolsService.takeAwaiting(message.chatId)
    if (waiting) {
      return this.handleCommand({
        ...message,
        type: ChannelMessageType.COMMAND,
        command: waiting,
        text: `/${waiting} ${text}`,
      })
    }

    const active = await this.findActive(message)

    if (active) {
      // "compartido con dany a medias": shares the open expense (D74); the user becomes the payer
      const split = parseShareCorrection(text, await this.expenseExtractionService.loadCatalog())
      if (split && !active.pendingField?.startsWith(SHARE_FIELD_PREFIX)) return this.shareOpenExpense(active, split)

      if (active.pendingField === FREE_CORRECTION_FIELD) {
        return this.correctWithAi(active, text)
      }

      if (active.pendingField?.startsWith(CARD_DAYS_FIELD_PREFIX)) {
        return this.saveCardDays(active, text)
      }

      // ✏️ of the split message: "20", "30%", "la mitad" for that person (D75)
      if (active.pendingField?.startsWith(SHARE_FIELD_PREFIX)) {
        return this.setShareFromText(active, text)
      }

      // Answer to the pending question, or a correction that starts with a keyword ("monto 30")
      const correction = await this.expenseExtractionService.parseLocalCorrection(
        text,
        active.pendingField as ExpenseField | null,
      )

      if (correction) {
        return this.applyCorrection(active, correction)
      }

      // Asked for the payment method and got a name we do not know: offer to add it
      if (active.pendingField === ExpenseField.PAYMENT_METHOD && this.looksLikeName(text)) {
        return [buildNewPaymentMethodReply(active.id, toNewPaymentMethodName(text))]
      }
    }

    // "dany me pagó 150": a payment towards what that person owes, read without the AI (P17)
    const payment = await this.proposeDebtPayment(text)
    if (payment) return [payment]

    return this.registerNewExpenses(message, text)
  }

  // Only when the person has something open in that direction; otherwise the text is a new expense
  private async proposeDebtPayment(text: string): Promise<BotReply | null> {
    const intent = parseDebtPayment(text, await this.expenseExtractionService.loadCatalog())
    if (!intent) return null

    const proposal = await this.debtsService.proposePayment(intent.personId, intent.direction, intent.amount)
    return proposal ? buildPaymentProposalReply(proposal) : null
  }

  // ✅ Confirmar · ✏️ Elegir cuota · ❌ Cancelar of a debt payment; the batch id travels as draftId
  private async handleDebtPaymentAction({
    name,
    draftId: batchId,
    value,
  }: BotActionPayload): Promise<ConversationResult> {
    const expired = { replies: [], notice: DEBT_TEXTS.paymentExpired }

    switch (name) {
      case BotAction.PAY_CONFIRM: {
        const updated = await this.debtsService.confirmPayment(batchId)
        return updated ? { replies: [buildPaymentSavedReply(updated)], notice: TEXTS.saved } : expired
      }
      case BotAction.PAY_LIST: {
        const proposal = await this.debtsService.findProposal(batchId)
        if (!proposal) return expired
        const open = await this.debtsService.findOpen(proposal.personId, proposal.direction)
        return { replies: [buildInstallmentPickerReply(batchId, open)] }
      }
      case BotAction.PAY_PICK: {
        const proposal = value ? await this.debtsService.pickInstallment(batchId, value) : null
        return proposal ? { replies: [buildPaymentProposalReply(proposal, true)] } : expired
      }
      default:
        await this.debtsService.cancelPayment(batchId)
        return { replies: [{ text: DEBT_TEXTS.paymentCancelled, edit: true }] }
    }
  }

  private async registerNewExpenses(message: ChannelMessage, text: string): Promise<BotReply[]> {
    let expenseDraft: ExpenseDraftDbDto

    try {
      expenseDraft = await this.expenseDraftDBRepository.create({
        channel: message.channel,
        chatId: message.chatId,
        messageId: message.messageId,
        inputType: ExpenseDraftInputType.TEXT,
        rawText: text,
      })
    } catch (error) {
      // Webhook retry of a message already handled
      if (error instanceof DuplicateExpenseDraftException) return []
      throw error
    }

    return this.extractInto(expenseDraft)
  }

  // An image (receipt photo, Yape/Plin screenshot) or a voice note is always a new message: an image caption adds
  // details for every expense in it and is never read as a correction of the open draft
  // Screenshots share a batch: an album, or one image with several movements, is answered with one list (P21)
  private async handleMedia(message: ChannelMessage): Promise<BotReply[]> {
    if (message.type === ChannelMessageType.AUDIO) return this.receiveMedia(message)

    const batchId = randomUUID()
    const items: AlbumItem[] = message.album?.length
      ? message.album
      : message.media
        ? [{ messageId: message.messageId, media: message.media, text: message.text }]
        : []
    const replies: BotReply[] = []
    for (const { messageId, media, text } of items) {
      replies.push(...(await this.receiveMedia({ ...message, messageId, media, text, album: undefined }, batchId)))
    }
    return this.asList(message.chatId, batchId, replies)
  }

  // Two or more open expenses → one list; the replies without buttons (failures, cuadre, repeated images) stay
  private async asList(chatId: string, batchId: string, replies: BotReply[]): Promise<BotReply[]> {
    const expenseDrafts = await this.expenseDraftDBRepository.findOpenByBatch(chatId, batchId)
    if (expenseDrafts.length < 2) return replies

    const catalog = await this.expenseExtractionService.loadCatalog()
    const warnings = await Promise.all(expenseDrafts.map((expenseDraft) => this.duplicateWarning(expenseDraft)))
    return [
      ...replies.filter((reply) => !reply.buttons?.length),
      buildBatchReply(batchId, expenseDrafts, warnings, catalog),
    ]
  }

  private async receiveMedia(message: ChannelMessage, batchId?: string): Promise<BotReply[]> {
    const { media } = message
    if (!media) return []

    const isAudio = message.type === ChannelMessageType.AUDIO
    if (!isAudio && media.sizeBytes && media.sizeBytes > MAX_IMAGE_BYTES) return [{ text: TEXTS.imageTooLarge }]
    if (isAudio && media.durationSeconds && media.durationSeconds > MAX_AUDIO_SECONDS) {
      return [{ text: TEXTS.audioTooLong(MAX_AUDIO_SECONDS) }]
    }

    const previous = await this.expenseDraftDBRepository.findByMediaUniqueId(
      message.channel,
      message.chatId,
      media.uniqueId,
    )
    if (previous) return [{ text: isAudio ? TEXTS.duplicateAudio : TEXTS.duplicateImage }]

    let expenseDraft: ExpenseDraftDbDto
    try {
      expenseDraft = await this.expenseDraftDBRepository.create({
        channel: message.channel,
        chatId: message.chatId,
        messageId: message.messageId,
        batchId: batchId ?? null,
        inputType: isAudio ? ExpenseDraftInputType.AUDIO : ExpenseDraftInputType.IMAGE,
        // Audio: rawText is filled with the transcription
        rawText: isAudio ? null : message.text?.trim() || null,
        mediaFileId: media.fileId,
        mediaUniqueId: media.uniqueId,
        fileId: media.storedFileId ?? null,
      })
    } catch (error) {
      if (error instanceof DuplicateExpenseDraftException) return []
      throw error
    }

    return this.extractInto(expenseDraft)
  }

  // Runs the AI on a row (new message or a failed one resumed from /borrador) and shows one summary per expense.
  // The input comes from the row itself: its text or caption, its image downloaded again from the channel, or its
  // voice note transcribed once (the transcription is kept in rawText, so a retry only repeats the extraction).
  private async extractInto(expenseDraft: ExpenseDraftDbDto, edit = false): Promise<BotReply[]> {
    let expenses: ResolvedExpense[] = []
    let unreadable: string[] = []
    let received: ReceivedPayment[] = []
    let shared: SharedExpenseMatch | null = null
    let text = expenseDraft.rawText ?? undefined
    let documentType: string | null = null
    let summary: Extract<RecognitionResult, { screen: RecognizedScreen.IO_CATEGORY_SUMMARY }> | null = null
    const isAudio = expenseDraft.inputType === ExpenseDraftInputType.AUDIO

    try {
      if (isAudio && !text) {
        text = await this.transcribe(expenseDraft)
        if (!text) {
          await this.expenseDraftDBRepository.update(expenseDraft.id, { status: ExpenseDraftStatus.DISCARDED })
          return [{ text: TEXTS.emptyAudio, edit }]
        }
      }

      if (expenseDraft.inputType === ExpenseDraftInputType.IMAGE && expenseDraft.mediaFileId) {
        // Hybrid (D47, D63): the local templates first; Yape, lists and anything unsure go to the AI
        const image = await this.download(expenseDraft)
        const recognized = await this.recognitionService.recognize(image, expenseDraft.id)
        if (recognized?.screen === RecognizedScreen.IO_CATEGORY_SUMMARY) {
          summary = recognized
        } else if (recognized) {
          documentType = recognized.screen
          expenses = this.recognitionService.toExpenses(
            recognized.expenses,
            await this.expenseExtractionService.loadCatalog(),
          )
        } else {
          const result = await this.expenseExtractionService.extract({
            text,
            images: [image],
            draftId: expenseDraft.id,
          })
          expenses = result.expenses
          unreadable = result.unreadable ?? []
          received = result.received ?? []
        }
      } else {
        // "cena 120 con dany, mitad": the split is read here and the AI only gets "cena 120" (P17)
        shared = text ? parseSharedExpense(text, await this.expenseExtractionService.loadCatalog()) : null
        ;({ expenses } = await this.expenseExtractionService.extract({
          text: shared?.text ?? text,
          draftId: expenseDraft.id,
        }))
      }
    } catch (error) {
      this.logger.warn(`[extractInto] extraction failed: ${(error as Error).message}`)
      await this.expenseDraftDBRepository.update(expenseDraft.id, { status: ExpenseDraftStatus.FAILED })
      return [{ text: error instanceof StoredFileExpiredException ? TEXTS.fileExpired : TEXTS.failed, edit }]
    }

    // A summary by category has no expenses: it answers how the month of the card adds up
    if (summary) return this.replyReconciliation(expenseDraft, summary, edit)

    // Voice notes show what was understood, so a wrong transcription is easy to spot
    const heard = isAudio && text ? `${TEXTS.heard(text)}\n\n` : ''

    // List items the AI could not read (covered or cut off): named so they can be sent again (P21)
    const unreadableReplies: BotReply[] = unreadable.length ? [{ text: TEXTS.unreadable(unreadable) }] : []

    if (!expenses.length) {
      await this.expenseDraftDBRepository.update(expenseDraft.id, { status: ExpenseDraftStatus.DISCARDED })
      // "Te yapearon": money received is not an expense, but it can pay what that person owes (P17)
      if (received.length) return [await this.replyReceived(received[0], edit), ...unreadableReplies]
      return [{ text: `${heard}${TEXTS.notAnExpense}`, edit }, ...unreadableReplies]
    }

    const catalog = await this.expenseExtractionService.loadCatalog()
    const replies: BotReply[] = []
    // Card screenshots without a visible card are the primary card (D47)
    if (expenseDraft.inputType === ExpenseDraftInputType.IMAGE) {
      expenses = expenses.map((expense) => withPrimaryCard(expense, catalog))
    }
    // What the bot learned from earlier corrections (/reglas, D129)
    expenses = await this.botToolsService.applyRules(expenses, catalog)

    for (const [index, expense] of expenses.entries()) {
      const target =
        index === 0
          ? expenseDraft
          : await this.expenseDraftDBRepository.create({
              channel: expenseDraft.channel,
              chatId: expenseDraft.chatId,
              messageId: expenseDraft.messageId,
              itemIndex: expenseDraft.itemIndex + index,
              batchId: expenseDraft.batchId,
              inputType: expenseDraft.inputType,
              rawText: text ?? null,
              mediaFileId: expenseDraft.mediaFileId,
              fileId: expenseDraft.fileId,
            })

      const updated = await this.expenseDraftDBRepository.update(target.id, {
        ...toExpenseDraftUpdate(expense),
        ...(documentType ? { documentType } : {}),
        ...(shared && index === 0 ? { sharedWith: shared.sharedWith } : {}),
      })
      const reply = await this.withDuplicateWarning(updated, this.replyFor(updated, catalog, edit && index === 0))
      replies.push(index === 0 && heard ? { ...reply, text: `${heard}${reply.text}` } : reply)
      replies.push(...this.shareReplies(updated, catalog))
    }

    return [...replies, ...unreadableReplies]
  }

  // A screenshot of money received from a person of the catalog proposes a payment of what they owe (✅ Confirmar)
  private async replyReceived(payment: ReceivedPayment, edit: boolean): Promise<BotReply> {
    const catalog = await this.expenseExtractionService.loadCatalog()
    const person = matchCatalogEntry(catalog, CatalogKind.PERSON, payment.sender)
    const isPen = (payment.currency ?? Currency.PEN) === Currency.PEN
    const proposal =
      person && isPen
        ? await this.debtsService.proposePayment(person.id, DebtDirection.OWED_TO_ME, payment.amount)
        : null
    if (proposal) return { ...buildPaymentProposalReply(proposal), edit }
    return { text: TEXTS.receivedNotDebt(payment.sender, payment.amount, payment.currency), edit }
  }

  private async replyReconciliation(
    expenseDraft: ExpenseDraftDbDto,
    summary: Extract<RecognitionResult, { screen: RecognizedScreen.IO_CATEGORY_SUMMARY }>,
    edit: boolean,
  ): Promise<BotReply[]> {
    await this.expenseDraftDBRepository.update(expenseDraft.id, {
      status: ExpenseDraftStatus.DISCARDED,
      documentType: summary.screen,
    })
    const reconciliation = await this.recognitionService.reconcile(
      summary,
      await this.expenseExtractionService.loadCatalog(),
    )
    return [{ text: reconciliation ? formatReconciliation(reconciliation) : TEXTS.notAnExpense, edit }]
  }

  // From R2 when the file is already stored (D58); otherwise from the channel the first time, and kept in R2 for 7 days
  // so retries and kogane-app use that copy. A storage failure only logs: the extraction goes on with the bytes.
  private async download(expenseDraft: ExpenseDraftDbDto): Promise<MediaFile> {
    if (expenseDraft.fileId) return this.storedFilesService.download(expenseDraft.fileId)
    if (!expenseDraft.mediaFileId) throw new Error('The expense draft has no media file')

    const media = await this.mediaDownloaderRegistry.download(
      expenseDraft.channel as ExpenseDraftChannel,
      expenseDraft.mediaFileId,
    )
    try {
      const file = await this.storedFilesService.storeTemporary(
        expenseDraft.channel,
        Buffer.from(media.data, 'base64'),
        media.mimeType,
      )
      await this.expenseDraftDBRepository.update(expenseDraft.id, { fileId: file.id })
      expenseDraft.fileId = file.id
    } catch (error) {
      this.logger.warn(`[download] file not stored: ${(error as Error).message}`)
    }
    return media
  }

  // Downloads the voice note, transcribes it and keeps the text in rawText
  private async transcribe(expenseDraft: ExpenseDraftDbDto): Promise<string> {
    const audio = await this.download(expenseDraft)
    const text = await this.expenseExtractionService.transcribe({ audio, draftId: expenseDraft.id })
    if (text) await this.expenseDraftDBRepository.update(expenseDraft.id, { rawText: text })
    return text
  }

  private async applyCorrection(
    expenseDraft: ExpenseDraftDbDto,
    correction: Partial<ResolvedExpenseFields>,
    edit = false,
  ): Promise<BotReply[]> {
    // What the user says is certain: corrected fields lose their ❓
    const confidence = { ...expenseDraft.confidence }
    for (const field of Object.keys(correction)) confidence[field] = 1

    const catalog = await this.expenseExtractionService.loadCatalog()
    const expense = completeExpense({ ...toExpenseFields(expenseDraft), ...correction }, confidence, catalog)
    const updated = await this.expenseDraftDBRepository.update(
      expenseDraft.id,
      keepEditing(expenseDraft, toExpenseDraftUpdate(expense)),
    )
    // A chosen category or payment method is remembered for that merchant (/reglas, D129)
    await this.botToolsService.learnRule(toExpenseFields(expenseDraft), correction)

    return [this.replyFor(updated, catalog, edit), ...this.shareRepliesAfter(expenseDraft, updated, catalog)]
  }

  private async correctWithAi(expenseDraft: ExpenseDraftDbDto, text: string): Promise<BotReply[]> {
    try {
      const { expenses } = await this.expenseExtractionService.extract({
        text,
        draft: toExpenseFields(expenseDraft),
        draftId: expenseDraft.id,
      })

      if (expenses[0]) {
        const updated = await this.expenseDraftDBRepository.update(
          expenseDraft.id,
          keepEditing(expenseDraft, toExpenseDraftUpdate(expenses[0])),
        )
        const catalog = await this.expenseExtractionService.loadCatalog()
        return [this.replyFor(updated, catalog), ...this.shareRepliesAfter(expenseDraft, updated, catalog)]
      }
    } catch (error) {
      this.logger.warn(`[correctWithAi] extraction failed: ${(error as Error).message}`)
    }

    // Leave correction mode so the next message is handled normally
    await this.expenseDraftDBRepository.update(expenseDraft.id, { pendingField: expenseDraft.missingFields[0] ?? null })
    return [{ text: TEXTS.correctionFailed }]
  }

  // ✅ Guardar todos saves the complete ones and leaves repeated or incomplete ones in Borrador; 📝 Revisar uno por
  // uno shows each summary; 📝 Borrador parks them all
  private async handleBatchAction(
    chatId: string,
    { name, draftId: batchId }: BotActionPayload,
  ): Promise<ConversationResult> {
    const expenseDrafts = await this.expenseDraftDBRepository.findOpenByBatch(chatId, batchId)
    if (!expenseDrafts.length) return { replies: [], notice: TEXTS.alreadyProcessed }

    const catalog = await this.expenseExtractionService.loadCatalog()
    const park = (id: string) =>
      this.expenseDraftDBRepository.update(id, { status: ExpenseDraftStatus.PENDING_REVIEW, pendingField: null })

    switch (name) {
      case BotAction.SAVE_ALL: {
        let saved = 0
        const alerts: string[] = []
        for (const expenseDraft of expenseDrafts) {
          // Repeated, incomplete or with a deduced installment amount (D66): left in Borrador to review
          const complete =
            !expenseDraft.missingFields.length &&
            !needsInstallmentConfirmation(expenseDraft) &&
            !(await this.duplicateWarning(expenseDraft))
          try {
            if (!complete) throw new Error('repeated or incomplete')
            const { budget } = await this.expenseSaverService.save(expenseDraft)
            saved++
            const alert = await this.budgetAlert(budget)
            if (alert) alerts.push(alert)
          } catch (error) {
            if (complete) this.logger.warn(`[handleBatchAction] save failed: ${(error as Error).message}`)
            await park(expenseDraft.id)
          }
        }
        const parked = expenseDrafts.length - saved
        return {
          replies: [
            { text: `✅ <b>Lista procesada</b>: ${saved} guardados, ${parked} en borrador.`, edit: true },
            { text: [TEXTS.batchSaved(saved, parked), ...alerts].join('\n') },
          ],
          notice: TEXTS.saved,
        }
      }
      case BotAction.REVIEW_ALL: {
        const replies: BotReply[] = [{ text: TEXTS.batchReview, edit: true }]
        for (const expenseDraft of expenseDrafts) {
          replies.push(await this.withDuplicateWarning(expenseDraft, this.replyFor(expenseDraft, catalog)))
        }
        return { replies }
      }
      default: {
        for (const expenseDraft of expenseDrafts) await park(expenseDraft.id)
        return {
          replies: [
            { text: `📝 <b>En borrador</b>: ${expenseDrafts.length} gastos.`, edit: true },
            { text: TEXTS.batchParked(expenseDrafts.length) },
          ],
        }
      }
    }
  }

  private async handleAction(message: ChannelMessage): Promise<ConversationResult> {
    const action = message.action as BotActionPayload
    if (action.name === BotAction.REPORT) return this.sendDebtReport(action)
    // Help buttons: run the command as if it was typed (draftId carries the command name)
    if (action.name === BotAction.COMMAND) {
      const command = action.draftId
      if (!(Object.values(BotCommand) as string[]).includes(command)) return { replies: [] }
      const replies = await this.handleCommand({
        ...message,
        type: ChannelMessageType.COMMAND,
        command,
        text: `/${command}`,
      })
      return { replies }
    }
    if (action.name === BotAction.EDIT_SAVED) return this.startEdit(message, action.draftId)
    if (TOOL_ACTIONS.includes(action.name)) return this.handleToolAction(message, action)
    // Reminder buttons and /avisos (P20): draftId carries the notification id or the kind
    if (NOTIFICATION_ACTIONS.includes(action.name))
      return this.notificationsBotService.handleAction(message.chatId, action)
    if (DEBT_PAYMENT_ACTIONS.includes(action.name)) return this.handleDebtPaymentAction(action)
    if (BATCH_ACTIONS.includes(action.name)) return this.handleBatchAction(message.chatId, action)

    const expenseDraft = await this.expenseDraftDBRepository.findById(action.draftId)
    const status = expenseDraft?.status as ExpenseDraftStatus | undefined

    // Open expenses accept every button; pending and failed ones only Retomar and Descartar (from /borrador)
    const isOwn = expenseDraft?.chatId === message.chatId
    const isOpen = status !== undefined && OPEN_EXPENSE_DRAFT_STATUSES.includes(status)
    const isParked = status !== undefined && PARKED_STATUSES.includes(status)
    const allowed =
      isOwn && (isOpen || (isParked && (action.name === BotAction.RESUME || action.name === BotAction.DISCARD)))

    // A button of a split message whose expense is already closed: that message shows what was kept, no buttons
    if (expenseDraft && isOwn && !isOpen && action.name === BotAction.SHARE && expenseDraft.sharedWith) {
      const catalog = await this.expenseExtractionService.loadCatalog()
      return { replies: [buildClosedShareReply(expenseDraft, catalog, { edit: true })], notice: TEXTS.alreadyProcessed }
    }

    if (!expenseDraft || !allowed) {
      return { replies: [], notice: TEXTS.alreadyProcessed }
    }

    const catalog = await this.expenseExtractionService.loadCatalog()

    switch (action.name) {
      case BotAction.SAVE: {
        if (expenseDraft.missingFields.length) {
          return { replies: [this.replyFor(expenseDraft, catalog, true)] }
        }
        if (needsInstallmentConfirmation(expenseDraft)) {
          return { replies: [buildInstallmentsConfirmReply(expenseDraft)] }
        }
        return this.saveAndReply(expenseDraft, catalog)
      }
      case BotAction.INSTALLMENTS_OK: {
        // The deduced amount is confirmed: it loses its ❓ and the n installments are created
        const confirmed = await this.expenseDraftDBRepository.update(expenseDraft.id, {
          confidence: { ...expenseDraft.confidence, [ExpenseField.AMOUNT]: 1 },
        })
        if (confirmed.missingFields.length) return { replies: [this.replyFor(confirmed, catalog)] }
        return this.saveAndReply(confirmed, catalog, false)
      }
      case BotAction.INSTALLMENTS_EDIT:
        await this.expenseDraftDBRepository.update(expenseDraft.id, { pendingField: ExpenseField.AMOUNT })
        return { replies: [{ text: TEXTS.askInstallmentAmount, edit: true }] }
      case BotAction.EDIT:
        await this.expenseDraftDBRepository.update(expenseDraft.id, { pendingField: FREE_CORRECTION_FIELD })
        return { replies: [{ text: TEXTS.askCorrection }] }
      case BotAction.LATER: {
        const updated = await this.expenseDraftDBRepository.update(expenseDraft.id, {
          status: ExpenseDraftStatus.PENDING_REVIEW,
          pendingField: null,
        })
        return {
          replies: [
            buildClosedReply('📝 <b>En borrador</b>', updated, catalog),
            ...this.closeShare(updated, catalog),
            buildParkedNotice(updated),
          ],
        }
      }
      case BotAction.DISCARD: {
        const updated = await this.expenseDraftDBRepository.update(expenseDraft.id, {
          status: ExpenseDraftStatus.DISCARDED,
          pendingField: null,
        })
        // /editar: dropping the copy leaves the saved expense as it was
        if (expenseDraft.status === ExpenseDraftStatus.EDITING) {
          return { replies: [{ text: TEXTS.editCancelled, edit: true }, ...this.closeShare(updated, catalog)] }
        }
        return { replies: [buildClosedReply('❌ <b>Descartado</b>', updated, catalog)] }
      }
      case BotAction.SHARE:
        return this.setShareFromButton(expenseDraft, action, catalog)
      case BotAction.RESUME:
        return { replies: await this.resume(expenseDraft, catalog), notice: TEXTS.resumed }
      case BotAction.NEW_PAYMENT_METHOD:
        return { replies: await this.createPaymentMethod(expenseDraft, action) }
      case BotAction.SET_FIELD: {
        const correction = this.toFieldCorrection(action, catalog)
        if (!correction) return { replies: [], notice: TEXTS.alreadyProcessed }
        return { replies: await this.applyCorrection(expenseDraft, correction, true) }
      }
      default:
        return { replies: [] }
    }
  }

  // Reopens a pending expense (or retries the AI on a failed one) and shows it with its buttons again
  private async resume(expenseDraft: ExpenseDraftDbDto, catalog: ExtractionCatalog): Promise<BotReply[]> {
    if (expenseDraft.status === ExpenseDraftStatus.FAILED) {
      return this.extractInto(expenseDraft, true)
    }

    const expense = completeExpense(toExpenseFields(expenseDraft), expenseDraft.confidence, catalog)
    const updated = await this.expenseDraftDBRepository.update(expenseDraft.id, toExpenseDraftUpdate(expense))
    return [this.replyFor(updated, catalog, true)]
  }

  // "No conozco bbva": the user picked a type (create it and use it) or "No"
  private async createPaymentMethod(expenseDraft: ExpenseDraftDbDto, { field, value }: BotActionPayload) {
    const type = field as PaymentMethodType | undefined

    if (!type || !value || !(Object.values(PaymentMethodType) as string[]).includes(type)) {
      return [{ text: TEXTS.paymentMethodNotAdded, edit: true }]
    }

    const paymentMethod = await this.paymentMethodDBRepository.create(value, type)
    const created: BotReply = { text: TEXTS.paymentMethodCreated(paymentMethod.name), edit: true }
    const next = await this.applyCorrection(expenseDraft, { paymentMethodId: paymentMethod.id })

    // A new credit card needs its billing days to know the payment month
    if (type === PaymentMethodType.CREDIT_CARD) {
      await this.expenseDraftDBRepository.update(expenseDraft.id, {
        pendingField: `${CARD_DAYS_FIELD_PREFIX}${paymentMethod.id}`,
      })
      return [created, { text: TEXTS.askCardDays }]
    }

    return [created, ...next]
  }

  private async saveCardDays(expenseDraft: ExpenseDraftDbDto, text: string): Promise<BotReply[]> {
    const paymentMethodId = (expenseDraft.pendingField as string).slice(CARD_DAYS_FIELD_PREFIX.length)
    const match = text.match(CARD_DAYS_REGEX)
    const [closeDay, dueDay] = match ? [Number(match[1]), Number(match[2])] : [0, 0]

    if (!match || closeDay < 1 || closeDay > 31 || dueDay < 1 || dueDay > 31) {
      return [{ text: TEXTS.cardDaysInvalid }]
    }

    const card = await this.paymentMethodDBRepository.updateBillingDays(paymentMethodId, closeDay, dueDay)
    // Back to the normal flow: next missing field or the confirmation buttons
    const next = await this.applyCorrection(expenseDraft, { paymentMethodId })

    return [{ text: TEXTS.cardDaysSaved(card.name) }, ...next]
  }

  // Values from quick reply buttons are checked again: the button may be older than the catalog
  private toFieldCorrection(
    { field, value }: BotActionPayload,
    catalog: ExtractionCatalog,
  ): Partial<ResolvedExpenseFields> | null {
    if (!field || !value) return null

    switch (field) {
      case ExpenseField.DESTINATION:
        return (Object.values(ExpenseDestination) as string[]).includes(value) ? { destination: value } : null
      case ExpenseField.PERIOD:
        return (Object.values(SubscriptionPeriod) as string[]).includes(value) ? { period: value } : null
      case ExpenseField.PAYMENT_METHOD:
      case ExpenseField.CATEGORY:
      case ExpenseField.PERSON:
        return findCatalogEntryById(catalog, value) ? { [field]: value } : null
      default:
        return null
    }
  }

  private async handleCommand(message: ChannelMessage): Promise<BotReply[]> {
    // A command drops the text another one was waiting for
    this.botToolsService.clearAwaiting(message.chatId)
    switch (message.command) {
      case BotCommand.CANCEL: {
        const count = await this.expenseDraftDBRepository.discardOpenByChat(message.channel, message.chatId)
        return [{ text: TEXTS.cancelled(count) }]
      }
      case BotCommand.USAGE: {
        const [usage, ocr] = await Promise.all([
          this.expenseExtractionService.getUsage(),
          this.recognitionService.todayStats(),
        ])
        return [{ text: formatAiUsage(usage, ocr) }]
      }
      case BotCommand.RECENT: {
        const recent = await this.expenseDraftDBRepository.findRecentSaved(
          message.channel,
          message.chatId,
          RECENT_EXPENSES_LIMIT,
        )
        return [{ text: formatRecent(recent), buttons: commandButtons(BotCommand.SUMMARY, BotCommand.DRAFTS) }]
      }
      case BotCommand.DRAFTS: {
        const [{ items, total }, catalog] = await Promise.all([
          this.expenseDraftDBRepository.findByStatuses(
            message.channel,
            message.chatId,
            REVIEW_EXPENSE_DRAFT_STATUSES,
            DRAFTS_LIMIT,
          ),
          this.expenseExtractionService.loadCatalog(),
        ])
        return buildDraftReplies(items, total, catalog)
      }
      case BotCommand.SUMMARY: {
        // "/resumen agosto", "/resumen 8 2026": any month (P18); alone, this one
        const period = parseMonthArg(this.commandArgs(message), DateHelper.todayIn(APP_TIME_ZONE))
        if (!period) return [{ text: monthUsage('📊', 'resumen') }]
        const { month, year } = period
        const [totals, catalog] = await Promise.all([
          this.expenseDBRepository.findMonthlyTotals(month, year),
          this.expenseExtractionService.loadCatalog(),
        ])
        return [
          {
            text: formatMonthlyTotals(totals, catalog, `${MONTH_NAMES[month - 1]} ${year}`),
            buttons: commandButtons(BotCommand.RECENT, BotCommand.DRAFTS),
          },
        ]
      }
      case BotCommand.DEBTS:
        return [await this.debtsCommand(this.commandArgs(message))]
      case BotCommand.COLLECT:
        return [{ text: await this.collectCommand(this.commandArgs(message)) }]
      case BotCommand.EDIT:
      case BotCommand.SEARCH: // the same search: pick a result to see it or edit it
        return [await this.searchSaved(message)]
      case BotCommand.BUDGET: {
        const today = DateHelper.todayIn(APP_TIME_ZONE)
        const period = parseMonthArg(this.commandArgs(message), today)
        if (!period) return [{ text: BUDGET_TEXTS.monthUsage }]
        const view = await this.budgetService.month(period.month, period.year)
        return [{ text: formatBudget(period.month, period.year, view) }]
      }
      case BotCommand.ALERTS:
        return [await this.notificationsBotService.settingsReply()]
      case BotCommand.CALENDAR:
        return [await this.notificationsBotService.calendarReply()]
      case BotCommand.INSTALLMENTS:
        return [await this.notificationsBotService.installmentsReply()]
      case BotCommand.FORECAST: {
        const today = DateHelper.todayIn(APP_TIME_ZONE)
        const [year, month, day] = today.split('-').map(Number)
        const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
        const view = await this.budgetService.month(month, year)
        return [{ text: formatForecast(month, year, day, daysInMonth, view) }]
      }
      default:
        // The groups of the menu and the commands inside them (P18); anything else shows the help
        return (await this.botToolsService.handleCommand(message)) ?? [helpHub()]
    }
  }

  // "/deudas dany" -> "dany" (channels keep the full text of commands)
  private commandArgs(message: ChannelMessage): string {
    return (message.text ?? '').trim().split(/\s+/).slice(1).join(' ')
  }

  // /deudas: everyone; /deudas dany: that person, installment by installment
  private async debtsCommand(args: string): Promise<BotReply> {
    if (!args) {
      const summary = await this.debtsService.summary()
      return { text: formatDebtSummary(summary), buttons: summary.length ? debtReportButtons() : undefined }
    }

    const person = matchCatalogEntry(await this.expenseExtractionService.loadCatalog(), CatalogKind.PERSON, args)
    if (!person) return { text: DEBT_TEXTS.unknownPerson(args) }
    const open = await this.debtsService.findOpen(person.id)
    return {
      text: formatPersonDebts(person.name, open),
      buttons: open.length ? debtReportButtons(person.id) : undefined,
    }
  }

  // 📥 Excel · 📄 PDF of /deudas (D39): "rep:<format>-<personId|all>"
  private async sendDebtReport({ draftId }: BotActionPayload): Promise<ConversationResult> {
    const [format, personId] = [draftId.slice(0, draftId.indexOf('-')), draftId.slice(draftId.indexOf('-') + 1)]
    if (!(Object.values(ReportFormat) as string[]).includes(format) || !personId) return { replies: [] }
    const file = await this.reportsService.debts(
      format as ReportFormat,
      personId === REPORT_FOR_EVERYONE ? undefined : personId,
    )
    return { replies: [{ text: `📎 ${file.filename}`, document: file }], notice: DEBT_TEXTS.reportSent }
  }

  // /cobrar dany: what Danery owes, as a message to forward
  private async collectCommand(args: string): Promise<string> {
    if (!args) return DEBT_TEXTS.collectUsage

    const person = matchCatalogEntry(await this.expenseExtractionService.loadCatalog(), CatalogKind.PERSON, args)
    if (!person) return DEBT_TEXTS.unknownPerson(args)
    return formatCollectMessage(person.name, await this.debtsService.findOpen(person.id, DebtDirection.OWED_TO_ME))
  }

  // Same receipt (operation number) or, without one, the same card + day + amount + merchant of an overlapping
  // screenshot in the last 60 days (P21). Only a warning: the user decides.
  private async withDuplicateWarning(expenseDraft: ExpenseDraftDbDto, reply: BotReply): Promise<BotReply> {
    const warning = await this.duplicateWarning(expenseDraft)
    return warning ? { ...reply, text: `${warning}\n\n${reply.text}` } : reply
  }

  private async duplicateWarning(expenseDraft: ExpenseDraftDbDto): Promise<string | null> {
    const { id, operationNumber, paymentMethodId, amount, spentAt } = expenseDraft
    if (operationNumber) {
      const duplicated = await this.expenseDraftDBRepository.existsSavedWithOperationNumber(operationNumber, id)
      return duplicated ? TEXTS.possibleDuplicate(operationNumber) : null
    }
    if (!paymentMethodId || amount == null || !spentAt) return null

    const since = new Date(Date.now() - DUPLICATE_LOOKBACK_DAYS * 24 * 60 * 60_000)
    const candidates = await this.expenseDraftDBRepository.findSameCardDayAmount(
      { id, paymentMethodId, amount, spentAt },
      since,
    )
    const concept = expenseDraft.merchant ?? expenseDraft.description
    const match = candidates.find((candidate) => sameMerchant(candidate.merchant ?? candidate.description, concept))
    if (!match) return null
    return TEXTS.possibleRepeat(
      match.merchant ?? match.description ?? '',
      formatAmount(amount, expenseDraft.currency),
      spentAt.toISOString().slice(0, 10).split('-').reverse().join('/'),
    )
  }

  // A short text without digits ("bbva", "tarjeta ripley"); anything with an amount is a new expense
  private looksLikeName(text: string): boolean {
    return !/\d/.test(text) && text.split(/\s+/).length <= 3
  }

  // kogane-app "Reintentar" (P7): runs the AI again on a failed draft (the image or voice note is downloaded
  // again from its channel). The result stays in Borrador, so it does not reopen the chat conversation.
  async retryExtraction(expenseDraft: ExpenseDraftDbDto): Promise<void> {
    await this.extractInto(expenseDraft)
    await this.expenseDraftDBRepository.parkMessage(
      expenseDraft.channel as ExpenseDraftChannel,
      expenseDraft.chatId,
      expenseDraft.messageId,
    )
  }

  // Called when the app starts: drafts left without extraction by a restart become failed (retry from /borrador)
  recoverInterrupted(channel: ExpenseDraftChannel, before: Date): Promise<{ chatId: string; count: number }[]> {
    return this.expenseDraftDBRepository.failInterruptedUpdatedBefore(channel, before)
  }

  // The latest open expense draft is the one text corrections apply to; stale ones go to Borrador first
  // (pending_review, or failed when the AI never finished)
  private async findActive(message: ChannelMessage): Promise<ExpenseDraftDbDto | null> {
    const cutoff = new Date(Date.now() - EXPENSE_DRAFT_EXPIRATION_MINUTES * 60_000)
    await this.expenseDraftDBRepository.failInterruptedUpdatedBefore(message.channel, cutoff, message.chatId)
    await this.expenseDraftDBRepository.moveStaleOpenToReview(message.channel, message.chatId, cutoff)
    return this.expenseDraftDBRepository.findOpenByChat(message.channel, message.chatId, cutoff)
  }

  // ✅ Guardar: the summary is closed in place (or sent again when it came from another message) plus a new notice
  private async saveAndReply(
    expenseDraft: ExpenseDraftDbDto,
    catalog: ExtractionCatalog,
    edit = true,
  ): Promise<ConversationResult> {
    let result: SavedExpense
    try {
      result = await this.expenseSaverService.save(expenseDraft)
    } catch (error) {
      if (error instanceof SavedExpenseLockedException) return { replies: [{ text: TEXTS.editLocked }] }
      throw error
    }
    const { installments, budget, trip } = result
    const saved = { ...expenseDraft, status: ExpenseDraftStatus.SAVED }
    const label = DESTINATION_LABELS[expenseDraft.destination as ExpenseDestination]
    const closed = buildClosedReply(`✅ <b>Guardado en ${label}</b>`, saved, catalog)
    const notice = buildSavedNotice(saved, label, installments, formatSharedDebts(expenseDraft, catalog))
    const alert = await this.budgetAlert(budget)
    // ↩️ Deshacer and the commands as buttons instead of the "Ver: /ultimos · /resumen" line (P18)
    const undo = { label: '↩️ Deshacer', data: encodeBotAction({ name: BotAction.UNDO, draftId: expenseDraft.id }) }
    const withButtons = {
      ...notice,
      text: `${notice.text.replace(/\nVer: .*$/, '')}${trip ? `\n${TRIP_TEXTS.label(trip)}` : ''}`,
      buttons: [[undo], ...commandButtons(BotCommand.RECENT, BotCommand.SUMMARY)],
    }
    return {
      replies: [
        { ...closed, edit },
        ...this.closeShare(saved, catalog),
        alert ? { ...withButtons, text: `${alert}\n${withButtons.text}` } : withButtons,
      ],
      notice: TEXTS.saved,
    }
  }

  // "⚠️ Comida: 85 % del presupuesto" when this expense crossed 80 % or 100 % of its category (P19). The expense is
  // already saved: a failure only logs.
  private async budgetAlert(budget: BudgetImpact | null): Promise<string | null> {
    if (!budget) return null
    try {
      const alert = await this.budgetService.alertAfterSave(
        budget.categoryId,
        budget.period,
        budget.amount,
        budget.personId,
      )
      return alert ? formatBudgetAlert(alert) : null
    } catch (error) {
      this.logger.warn(`[budgetAlert] ${(error as Error).message}`)
      return null
    }
  }

  // The split message of a shared expense (D75), once the expense is complete (card, period… chosen): what each
  // one owes depends on them. None for discarded or saved ones.
  private shareReplies(expenseDraft: ExpenseDraftDbDto, catalog: ExtractionCatalog): BotReply[] {
    const closed = [ExpenseDraftStatus.DISCARDED, ExpenseDraftStatus.SAVED] as string[]
    return expenseDraft.sharedWith?.shares.length &&
      !expenseDraft.missingFields.length &&
      !closed.includes(expenseDraft.status)
      ? this.newShareMessage(expenseDraft, catalog)
      : []
  }

  // A new split message; the previous one (if the channel told us its id) loses its buttons, so only one is editable
  private newShareMessage(expenseDraft: ExpenseDraftDbDto, catalog: ExtractionCatalog): BotReply[] {
    const previous: BotReply[] = expenseDraft.shareMessageId
      ? [{ text: TEXTS.shareReplaced, editMessageId: expenseDraft.shareMessageId }]
      : []
    return [...previous, buildShareReply(expenseDraft, catalog)]
  }

  // The split message of a closed expense (saved, in Borrador, discarded) shows what was kept, without buttons (D75)
  private closeShare(expenseDraft: ExpenseDraftDbDto, catalog: ExtractionCatalog): BotReply[] {
    return expenseDraft.shareMessageId && expenseDraft.sharedWith
      ? [buildClosedShareReply(expenseDraft, catalog, { editMessageId: expenseDraft.shareMessageId })]
      : []
  }

  // Telegram tells the id of a split message it sent (trackShareOf), so it can be closed later
  async rememberShareMessage(draftId: string, messageId: string): Promise<void> {
    await this.expenseDraftDBRepository.update(draftId, { shareMessageId: messageId })
  }

  // After a correction: the split message is sent again only when the expense just became complete or its amount or
  // installment changed (the parts depend on them); otherwise the one in the chat is still right
  private shareRepliesAfter(
    before: ExpenseDraftDbDto,
    updated: ExpenseDraftDbDto,
    catalog: ExtractionCatalog,
  ): BotReply[] {
    const changed =
      before.missingFields.length > 0 || before.amount !== updated.amount || before.installment !== updated.installment
    return changed ? this.shareReplies(updated, catalog) : []
  }

  private async shareOpenExpense(expenseDraft: ExpenseDraftDbDto, sharedWith: SharedExpense): Promise<BotReply[]> {
    const catalog = await this.expenseExtractionService.loadCatalog()
    const payer = findDefaultPerson(catalog)?.id ?? expenseDraft.personId
    const updated = await this.expenseDraftDBRepository.update(expenseDraft.id, {
      sharedWith,
      personId: payer,
      pendingField: expenseDraft.pendingField === FREE_CORRECTION_FIELD ? null : expenseDraft.pendingField,
    })
    return [this.replyFor(updated, catalog), ...this.shareReplies(updated, catalog)]
  }

  // ½ · ⅓ · 20 % · ✏️ · 🗑️ of one person in the split message: edits that message only
  private async setShareFromButton(
    expenseDraft: ExpenseDraftDbDto,
    { field, value }: BotActionPayload,
    catalog: ExtractionCatalog,
  ): Promise<ConversationResult> {
    const index = Number(field)
    const shares = expenseDraft.sharedWith?.shares ?? []
    const share = shares[index]
    if (!share) return { replies: [], notice: TEXTS.alreadyProcessed }

    if (value === ShareChoice.AMOUNT) {
      await this.expenseDraftDBRepository.update(expenseDraft.id, { pendingField: `${SHARE_FIELD_PREFIX}${index}` })
      const name = findCatalogEntryById(catalog, share.personId)?.name ?? '—'
      // The split message becomes the question: its old buttons go away and the answer brings a new one
      return { replies: [{ text: TEXTS.askShare(name), edit: true }] }
    }

    const ratio = SHARE_CHOICE_RATIOS[value as ShareChoice]
    const next =
      value === ShareChoice.REMOVE
        ? shares.filter((_, position) => position !== index)
        : shares.map((current, position) =>
            position === index && ratio ? { personId: current.personId, ratio } : current,
          )
    const updated = await this.expenseDraftDBRepository.update(expenseDraft.id, {
      sharedWith: next.length ? { shares: next } : null,
    })
    if (!next.length) return { replies: [{ text: TEXTS.notShared, edit: true }] }
    return { replies: [buildShareReply(updated, catalog, true)] }
  }

  // The answer to ✏️: "20", "30%", "la mitad", "un tercio"
  private async setShareFromText(expenseDraft: ExpenseDraftDbDto, text: string): Promise<BotReply[]> {
    const index = Number((expenseDraft.pendingField as string).slice(SHARE_FIELD_PREFIX.length))
    const shares = expenseDraft.sharedWith?.shares ?? []
    const catalog = await this.expenseExtractionService.loadCatalog()
    const total = expenseDraft.amount ?? 0
    const parsed = shareOfTotal(parseShare(normalizeText(text).replace(/^s\/\.?\s*/, '')), total)
    if (!shares[index] || !parsed) return [{ text: TEXTS.shareNotUnderstood }]
    if (parsed === SHARE_OVER_TOTAL) {
      const name = findCatalogEntryById(catalog, shares[index].personId)?.name ?? '—'
      return [{ text: TEXTS.shareTooMuch(name, formatAmount(total, expenseDraft.currency)) }]
    }

    const next = shares.map((share, position) => (position === index ? { personId: share.personId, ...parsed } : share))
    const updated = await this.expenseDraftDBRepository.update(expenseDraft.id, {
      sharedWith: { shares: next },
      pendingField: expenseDraft.missingFields[0] ?? null,
    })
    return this.newShareMessage(updated, catalog)
  }

  // /editar <texto> (D76): saved expenses matching the amount, date, catalog names and the rest of the text
  private async searchSaved(message: ChannelMessage): Promise<BotReply> {
    const args = this.commandArgs(message)
    if (!args) {
      // From a button: ask what to search and take the next message as the text
      this.botToolsService.await(message.chatId, message.command as BotCommand)
      return { text: TEXTS.editUsage }
    }
    const catalog = await this.expenseExtractionService.loadCatalog()
    const filters = parseSavedSearch(args, catalog, DateHelper.todayIn(APP_TIME_ZONE))
    const results = await this.expenseDraftDBRepository.searchSaved(
      message.channel,
      message.chatId,
      filters,
      SAVED_SEARCH_LIMIT,
    )
    return buildSavedSearchReply(results, args, catalog)
  }

  // ✏️ of a search result: an EDITING copy with the expense and split messages; the original stays saved
  private async startEdit(message: ChannelMessage, draftId: string): Promise<ConversationResult> {
    const original = await this.expenseDraftDBRepository.findById(draftId)
    if (!original || original.chatId !== message.chatId || original.status !== ExpenseDraftStatus.SAVED) {
      return { replies: [], notice: TEXTS.alreadyProcessed }
    }
    // Only one edit at a time: an unfinished one is dropped
    await this.expenseDraftDBRepository.discardOpenByChat(message.channel, message.chatId)
    const copy = await this.expenseDraftDBRepository.createEditCopy(original, `edit:${randomUUID()}`)
    const catalog = await this.expenseExtractionService.loadCatalog()
    return { replies: [this.replyFor(copy, catalog), ...this.shareReplies(copy, catalog)] }
  }

  // The buttons of the tools (P18): ⚡ a repeated expense, ↩️ /deshacer
  private async handleToolAction(message: ChannelMessage, action: BotActionPayload): Promise<ConversationResult> {
    switch (action.name) {
      case BotAction.QUICK:
        return this.saveQuick(message, action.draftId)
      case BotAction.UNDO:
        return { replies: [await this.botToolsService.undoConfirm(message.chatId, action.draftId)] }
      case BotAction.UNDO_CANCEL:
        return { replies: [this.botToolsService.undoCancel()] }
      case BotAction.RULE_DELETE: {
        const { reply, notice } = await this.botToolsService.removeRule(action.draftId)
        return { replies: [reply], notice }
      }
      case BotAction.EXPORT: {
        const file = await this.botToolsService.exportFile(action)
        return file ? { replies: [file], notice: EXPORT_TEXTS.sent } : { replies: [], notice: TEXTS.alreadyProcessed }
      }
      default:
        return { replies: [], notice: TEXTS.alreadyProcessed }
    }
  }

  // ⚡ of /rapido: the same expense again, today, saved at once (no AI, no questions)
  private async saveQuick(message: ChannelMessage, key: string): Promise<ConversationResult> {
    const source = await this.botToolsService.quickExpense(key)
    if (!source) return { replies: [], notice: 'Ese gasto ya no está en tus rápidos' }

    const copy = await this.expenseDraftDBRepository.createQuickCopy(
      source,
      { channel: message.channel, chatId: message.chatId, messageId: `quick:${randomUUID()}` },
      dayStart(DateHelper.todayIn(APP_TIME_ZONE)),
    )
    const [catalog, result] = await Promise.all([
      this.expenseExtractionService.loadCatalog(),
      this.expenseSaverService.save(copy),
    ])
    const saved = { ...copy, status: ExpenseDraftStatus.SAVED }
    const alert = await this.budgetAlert(result.budget)
    const text = `⚡ Guardado: ${conceptOf(saved)} · ${nameOf(catalog, saved.paymentMethodId)}${result.trip ? `\n${TRIP_TEXTS.label(result.trip)}` : ''}${alert ? `\n${alert}` : ''}`
    return {
      replies: [
        {
          text,
          buttons: [[{ label: '↩️ Deshacer', data: encodeBotAction({ name: BotAction.UNDO, draftId: copy.id }) }]],
        },
      ],
      notice: TEXTS.saved,
    }
  }

  private replyFor(expenseDraft: ExpenseDraftDbDto, catalog: ExtractionCatalog, edit = false): BotReply {
    if (expenseDraft.status === ExpenseDraftStatus.DISCARDED) {
      return { text: TEXTS.notAnExpense, edit }
    }
    return buildExpenseReply(expenseDraft, catalog, edit)
  }
}
