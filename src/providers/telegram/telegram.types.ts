// Subset of the Telegram Bot API Update used by the bot (https://core.telegram.org/bots/api#update)
export interface TelegramChat {
  id: number
  type: string // private, group, supergroup, channel
  first_name?: string
  title?: string
}

export interface TelegramUser {
  id: number
  is_bot: boolean
  first_name: string
  language_code?: string
}

// https://core.telegram.org/bots/api#photosize: one entry per size, the last one is the largest
export interface TelegramPhotoSize {
  file_id: string
  file_unique_id: string // stable across bots and time: detects the same image sent again
  width: number
  height: number
  file_size?: number
}

export interface TelegramVoice {
  file_id: string
  file_unique_id: string
  duration: number // seconds
  mime_type?: string
  file_size?: number
}

export interface TelegramDocument {
  file_id: string
  file_unique_id: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

export interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: TelegramChat
  date: number
  edit_date?: number
  entities?: { offset: number; length: number; type: string }[]
  text?: string
  caption?: string
  photo?: TelegramPhotoSize[]
  voice?: TelegramVoice
  audio?: TelegramVoice
  document?: TelegramDocument
  media_group_id?: string // photos sent together as an album
  sticker?: { file_id: string; file_unique_id: string }
}

export interface TelegramCallbackQuery {
  id: string
  from?: TelegramUser
  chat_instance?: string
  data?: string
  message?: TelegramMessage
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage // not requested in allowed_updates; ignored if it arrives
  callback_query?: TelegramCallbackQuery
}

export interface TelegramInlineKeyboardButton {
  text: string
  callback_data?: string
  url?: string // a link button
}

// Buttons under the message, or the fixed keyboard under the chat (/teclado) and its removal
export type TelegramReplyMarkup =
  | { inline_keyboard: TelegramInlineKeyboardButton[][] }
  | { keyboard: { text: string }[][]; resize_keyboard: true; is_persistent: true }
  | { remove_keyboard: true }

// https://core.telegram.org/bots/api#webhookinfo (subset)
export interface TelegramWebhookInfo {
  url: string
  pending_update_count: number
  last_error_date?: number
  last_error_message?: string
}

// https://core.telegram.org/bots/api#file
export interface TelegramFile {
  file_id: string
  file_unique_id: string
  file_size?: number
  file_path?: string // valid for at least one hour
}
