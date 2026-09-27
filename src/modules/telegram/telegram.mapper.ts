import { ChannelMessageType, KEYBOARD_COMMANDS } from '@/commons/constants/conversation.constant'
import { ExpenseDraftChannel } from '@/commons/constants/expense-draft.constant'
import { decodeBotAction } from '@/modules/conversation/bot-action.codec'
import { BotButton, ChannelMedia, ChannelMessage } from '@/modules/conversation/dto/conversation.types'

import { TelegramMessage, TelegramReplyMarkup, TelegramUpdate } from '@/providers/telegram/telegram.types'

export interface MappedTelegramUpdate {
  message: ChannelMessage
  callbackQueryId?: string // must be answered right away
  sourceMessageId?: number // message with the pressed button, edited by "edit" replies
  mediaGroupId?: string // photos of one album arrive as separate updates with the same id
}

// "/resumen@my_bot extra" -> "resumen"
const parseCommand = (text: string) => text.slice(1).split(/\s+/)[0].split('@')[0].toLowerCase()

export function mapTelegramUpdate({
  message,
  callback_query: callbackQuery,
}: TelegramUpdate): MappedTelegramUpdate | null {
  if (callbackQuery?.message && callbackQuery.data) {
    const action = decodeBotAction(callbackQuery.data)
    if (!action) return null

    return {
      message: {
        channel: ExpenseDraftChannel.TELEGRAM,
        chatId: String(callbackQuery.message.chat.id),
        messageId: `callback:${callbackQuery.id}`,
        type: ChannelMessageType.ACTION,
        action,
      },
      callbackQueryId: callbackQuery.id,
      sourceMessageId: callbackQuery.message.message_id,
    }
  }

  if (!message) return null

  const media = imageOf(message)
  if (media) {
    return {
      message: {
        channel: ExpenseDraftChannel.TELEGRAM,
        chatId: String(message.chat.id),
        messageId: String(message.message_id),
        type: ChannelMessageType.IMAGE,
        media,
        ...(message.caption?.trim() ? { text: message.caption.trim() } : {}),
      },
      ...(message.media_group_id ? { mediaGroupId: message.media_group_id } : {}),
    }
  }

  const audio = audioOf(message)
  if (audio) {
    return {
      message: {
        channel: ExpenseDraftChannel.TELEGRAM,
        chatId: String(message.chat.id),
        messageId: String(message.message_id),
        type: ChannelMessageType.AUDIO,
        media: audio,
      },
    }
  }

  const text = message.text
  if (!text) return null // stickers and other files are ignored

  const isCommand = text.startsWith('/')

  return {
    message: {
      channel: ExpenseDraftChannel.TELEGRAM,
      chatId: String(message.chat.id),
      messageId: String(message.message_id),
      type: isCommand ? ChannelMessageType.COMMAND : ChannelMessageType.TEXT,
      // commands keep their text too: "/deudas dany" carries an argument
      ...(isCommand ? { command: parseCommand(text), text } : { text }),
    },
  }
}

// A photo (Telegram sends several sizes: the last one is the largest) or an image sent as a file
function imageOf({ photo, document }: TelegramMessage): ChannelMedia | null {
  const largest = photo?.at(-1)
  if (largest) return { fileId: largest.file_id, uniqueId: largest.file_unique_id, sizeBytes: largest.file_size }

  if (document?.mime_type?.startsWith('image/')) {
    return { fileId: document.file_id, uniqueId: document.file_unique_id, sizeBytes: document.file_size }
  }

  return null
}

// A voice note, or an audio file (e.g. forwarded from another app)
function audioOf({ voice, audio }: TelegramMessage): ChannelMedia | null {
  const file = voice ?? audio
  if (!file) return null

  return {
    fileId: file.file_id,
    uniqueId: file.file_unique_id,
    sizeBytes: file.file_size,
    durationSeconds: file.duration,
  }
}

export function toReplyMarkup(buttons?: BotButton[][]): TelegramReplyMarkup | undefined {
  if (!buttons?.length) return undefined

  return {
    inline_keyboard: buttons.map((row) =>
      row.map(({ label, data, url }) => (url ? { text: label, url } : { text: label, callback_data: data })),
    ),
  }
}

// The fixed keyboard of /teclado: the texts of its buttons arrive as a message (KEYBOARD_TEXTS)

export const toKeyboardMarkup = (keyboard: 'show' | 'hide'): TelegramReplyMarkup =>
  keyboard === 'show'
    ? {
        keyboard: [Object.keys(KEYBOARD_COMMANDS).map((text) => ({ text }))],
        resize_keyboard: true,
        is_persistent: true,
      }
    : { remove_keyboard: true }
