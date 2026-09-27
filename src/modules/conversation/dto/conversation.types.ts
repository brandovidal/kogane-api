import { BotAction, ChannelMessageType } from '@/commons/constants/conversation.constant'
import { ExpenseDraftChannel } from '@/commons/constants/expense-draft.constant'
import { PaymentPeriod } from '@/commons/helpers/payment-period.helper'

export interface BotActionPayload {
  name: BotAction
  draftId: string
  field?: string // SET_FIELD: ExpenseField
  value?: string // SET_FIELD: enum value or catalog id
}

// A file received in a channel; the bytes are downloaded later through the channel MediaDownloader
export interface ChannelMedia {
  fileId: string // id to download it (Telegram file_id)
  uniqueId: string // stable id of the file: the same image sent twice has the same one
  sizeBytes?: number
  durationSeconds?: number // audio
  storedFileId?: string // bot_files row already holding the bytes (D58): web uploads always have one
}

export interface AlbumItem {
  messageId: string
  media: ChannelMedia
  text?: string // Telegram puts the caption of an album on one of its photos
}

// A message from any channel, already translated by its adapter (Telegram now, WhatsApp later)
export interface ChannelMessage {
  channel: ExpenseDraftChannel
  chatId: string
  messageId: string
  type: ChannelMessageType
  text?: string // message text, or the caption of an image
  media?: ChannelMedia
  album?: AlbumItem[] // photos sent together (Telegram media_group_id), answered with one list (P21)
  command?: string
  action?: BotActionPayload
}

export interface BotButton {
  label: string
  data: string // encoded BotActionPayload (see bot-action.codec.ts)
  url?: string // a link button (/web): opens the page instead of sending data
}

export interface BotDocument {
  filename: string
  mimeType: string
  data: Buffer
}

export interface BotPhoto {
  filename: string
  mimeType: string
  data: Buffer
}

export interface BotReply {
  text: string // HTML: <b>, <i> and escaped user text; the caption when there is a document or a photo
  document?: BotDocument // a file to send (Excel / PDF, D39); channels without files show only the text
  photo?: BotPhoto // an image (/grafico): channels without images show only the text
  keyboard?: 'show' | 'hide' // the fixed keyboard under the chat (/teclado): ➕ Rápido · 📝 Borrador · 📊 Consultar
  buttons?: BotButton[][]
  edit?: boolean // replace the message that had the pressed button instead of sending a new one
  editMessageId?: string // edit this earlier message instead (a split message closed on save, D75); no copy if it fails
  trackShareOf?: string // the split message of this draft: the channel remembers its id (rememberShareMessage)
}

export interface ConversationResult {
  replies: BotReply[]
  notice?: string // short toast for the pressed button
}

export interface InstallmentsCreated {
  total: number // n of "1/n"
  from: PaymentPeriod
  to: PaymentPeriod
}

// What a saved expense adds to the budget of a category (P19): PEN spending only; debts and subscriptions add nothing
export interface BudgetImpact {
  personId: string // only the default person's expenses count (D71)
  categoryId: string | null
  period: PaymentPeriod // day to day: the month of the date; fixed costs and cards: the payment month
  amount: number
}

// ExpenseSaverService.save: "1/n" with n > 1 created every installment (debts D60, credit cards D66)
export interface SavedExpense {
  id: string
  installments: InstallmentsCreated | null
  budget: BudgetImpact | null
  trip: string | null // the open trip it was tagged with (/viaje, P18)
}
