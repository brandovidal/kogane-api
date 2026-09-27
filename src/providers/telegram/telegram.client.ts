import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

import {
  TELEGRAM_API_URL,
  TELEGRAM_DOWNLOAD_TIMEOUT_MS,
  TELEGRAM_FILE_URL,
  TELEGRAM_MAX_RETRIES,
  TELEGRAM_MAX_RETRY_AFTER_SECONDS,
  TELEGRAM_PARSE_MODE,
  TELEGRAM_REQUEST_TIMEOUT_MS,
  TELEGRAM_RETRY_DELAY_MS,
} from '@/commons/constants/telegram.constant'
import { TelegramRequestFailedException } from '@/commons/exceptions/telegram/telegram-request-failed.exception'
import { TelegramConfig } from '@/settings/settings.model'
import { TelegramFile, TelegramReplyMarkup, TelegramWebhookInfo } from './telegram.types'

interface TelegramResponse<T> {
  ok: boolean
  result?: T
  description?: string
  parameters?: { retry_after?: number }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Minimal Bot API client over fetch: the bot only needs a handful of methods
@Injectable()
export class TelegramClient {
  constructor(private readonly configService: ConfigService) {}

  sendMessage(chatId: string, text: string, replyMarkup?: TelegramReplyMarkup) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: TELEGRAM_PARSE_MODE,
      reply_markup: replyMarkup,
    })
  }

  editMessageText(chatId: string, messageId: number, text: string, replyMarkup?: TelegramReplyMarkup) {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: TELEGRAM_PARSE_MODE,
      reply_markup: replyMarkup,
    })
  }

  // A file made by kogane-api (Excel / PDF, D39), uploaded as multipart
  sendDocument(chatId: string, file: { filename: string; mimeType: string; data: Buffer }, caption?: string) {
    const form = new FormData()
    form.append('chat_id', chatId)
    if (caption) {
      form.append('caption', caption)
      form.append('parse_mode', TELEGRAM_PARSE_MODE)
    }
    form.append('document', new Blob([new Uint8Array(file.data)], { type: file.mimeType }), file.filename)
    return this.call('sendDocument', form)
  }

  // An image (/grafico): a PNG or JPEG, with its caption
  sendPhoto(chatId: string, file: { filename: string; mimeType: string; data: Buffer }, caption?: string) {
    const form = new FormData()
    form.append('chat_id', chatId)
    if (caption) {
      form.append('caption', caption)
      form.append('parse_mode', TELEGRAM_PARSE_MODE)
    }
    form.append('photo', new Blob([new Uint8Array(file.data)], { type: file.mimeType }), file.filename)
    return this.call('sendPhoto', form)
  }

  answerCallbackQuery(callbackQueryId: string, text?: string) {
    return this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, text })
  }

  sendChatAction(chatId: string, action: 'typing') {
    return this.call('sendChatAction', { chat_id: chatId, action })
  }

  // Downloads a file sent to the bot; kept in memory only. The URL carries the token: never log it
  async downloadFile(fileId: string): Promise<{ data: Buffer; filePath: string }> {
    const file = await this.call<TelegramFile>('getFile', { file_id: fileId })
    if (!file.file_path) throw new TelegramRequestFailedException({ method: 'getFile', reason: 'file_path missing' })

    const response = await fetch(`${TELEGRAM_FILE_URL}/bot${this.botToken('getFile')}/${file.file_path}`, {
      signal: AbortSignal.timeout(TELEGRAM_DOWNLOAD_TIMEOUT_MS),
    }).catch((error: Error) => {
      throw new TelegramRequestFailedException({ method: 'downloadFile', reason: error.name })
    })
    if (!response.ok) {
      throw new TelegramRequestFailedException({ method: 'downloadFile', status: response.status })
    }

    return { data: Buffer.from(await response.arrayBuffer()), filePath: file.file_path }
  }

  getWebhookInfo() {
    return this.call<TelegramWebhookInfo>('getWebhookInfo', {})
  }

  async call<T = unknown>(method: string, body: Record<string, unknown> | FormData): Promise<T> {
    const isForm = body instanceof FormData
    const botToken = this.botToken(method)

    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await fetch(`${TELEGRAM_API_URL}/bot${botToken}/${method}`, {
          method: 'POST',
          // multipart sets its own content-type with the boundary
          headers: isForm ? undefined : { 'content-type': 'application/json' },
          body: isForm ? body : JSON.stringify(body),
          signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS),
        })
      } catch (error) {
        // Network error or timeout: the request may not have reached Telegram
        if (attempt < TELEGRAM_MAX_RETRIES) {
          await sleep(TELEGRAM_RETRY_DELAY_MS)
          continue
        }
        throw new TelegramRequestFailedException({ method, reason: (error as Error).name })
      }

      const payload = (await response.json()) as TelegramResponse<T>
      if (payload.ok) return payload.result as T

      const waitMs = this.retryDelayMs(response.status, payload)
      if (waitMs !== null && attempt < TELEGRAM_MAX_RETRIES) {
        await sleep(waitMs)
        continue
      }

      // Never include the token (it is part of the URL) in errors
      throw new TelegramRequestFailedException({ method, status: response.status, reason: payload.description })
    }
  }

  private botToken(method: string): string {
    const botToken = this.configService.get<TelegramConfig>('telegram')?.botToken
    if (!botToken) throw new TelegramRequestFailedException({ method, reason: 'TELEGRAM_BOT_TOKEN is not set' })
    return botToken
  }

  // 429 waits what Telegram asks (up to a limit) and 5xx a fixed delay; anything else is not retried
  private retryDelayMs(status: number, payload: TelegramResponse<unknown>): number | null {
    if (status === 429) {
      const retryAfter = payload.parameters?.retry_after ?? 1
      return retryAfter <= TELEGRAM_MAX_RETRY_AFTER_SECONDS ? retryAfter * 1_000 : null
    }
    return status >= 500 ? TELEGRAM_RETRY_DELAY_MS : null
  }
}
