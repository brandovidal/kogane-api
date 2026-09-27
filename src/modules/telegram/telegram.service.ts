import {
  BeforeApplicationShutdown,
  HttpException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleInit,
} from '@nestjs/common'

import { AuditSource } from '@/commons/constants/audit.constant'
import { AuditContextService } from '@/db/audit/audit-context.service'
import { runAsSystem, runWithUser } from '@/db/tenant/tenant-context'
import { AuthService } from '@/modules/auth/auth.service'
import { LinkCodeInvalidException } from '@/commons/exceptions/auth/link-code-invalid.exception'
import { ChannelMessageType } from '@/commons/constants/conversation.constant'
import { ExpenseDraftChannel } from '@/commons/constants/expense-draft.constant'
import {
  ALBUM_WAIT_MS,
  INTERRUPTED_DRAFT_MIN_AGE_MS,
  SHUTDOWN_DRAIN_TIMEOUT_MS,
} from '@/commons/constants/telegram.constant'
import { KeyedQueue } from '@/commons/helpers/keyed-queue.helper'
import { TelegramClient } from '@/providers/telegram/telegram.client'
import { ConversationService } from '@/modules/conversation/conversation.service'
import { TEXTS, withCommandButtons } from '@/modules/conversation/conversation.messages'
import { MediaDownloaderRegistry } from '@/modules/conversation/media-downloader.registry'

import { mapTelegramUpdate, MappedTelegramUpdate, toKeyboardMarkup, toReplyMarkup } from './telegram.mapper'
import { TelegramReplyMarkup, TelegramUpdate } from '@/providers/telegram/telegram.types'

const ERROR_TEXT = '⚠️ Algo salió mal procesando tu mensaje. Intenta de nuevo en un momento.'
const UNLINKED_TEXT =
  '👋 Este chat todavía no está vinculado a una cuenta de Kogane.\n\nEntra a la web, abre <b>Perfil</b> y toca <b>Vincular Telegram</b>: se abre este chat con tu código.'
const LINKED_TEXT = '✅ Listo: este chat quedó vinculado a tu cuenta.'
const LINK_INVALID_TEXT =
  '⚠️ Ese código ya no sirve. Genera uno nuevo desde <b>Perfil ▸ Vincular Telegram</b> en la web.'

// editMessageText answers 400 "message is not modified" when the text and buttons are the same
function isNotModified(error: unknown): boolean {
  const reason =
    error instanceof HttpException ? (error.getResponse() as { details?: { reason?: string } }).details?.reason : null
  return /message is not modified/i.test(reason ?? (error as Error).message ?? '')
}

// Telegram photos are JPEG; voice notes are .oga; other files keep their extension in file_path
const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  oga: 'audio/ogg', // voice notes (OGG/Opus)
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
}

interface PendingAlbum {
  updates: MappedTelegramUpdate[]
  timer: NodeJS.Timeout
  done: Promise<void>
  flush: () => void
}

@Injectable()
export class TelegramService implements OnModuleInit, OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(TelegramService.name)
  private readonly queue = new KeyedQueue()
  private readonly albums = new Map<string, PendingAlbum>()

  constructor(
    private readonly telegramClient: TelegramClient,
    private readonly conversationService: ConversationService,
    private readonly mediaDownloaderRegistry: MediaDownloaderRegistry,
    private readonly auditContext: AuditContextService,
    private readonly authService: AuthService,
  ) {}

  // The conversation downloads images through this (also again when a failed one is resumed from /borrador)
  onModuleInit() {
    this.mediaDownloaderRegistry.register(ExpenseDraftChannel.TELEGRAM, async (fileId) => {
      const { data, filePath } = await this.telegramClient.downloadFile(fileId)
      const extension = filePath.split('.').pop()?.toLowerCase() ?? ''
      return { mimeType: MIME_BY_EXTENSION[extension] ?? 'image/jpeg', data: data.toString('base64') }
    })
  }

  // Messages already answered with 200 whose processing a restart cut: move them to /borrador and tell the chat.
  // Not awaited, so a slow database or Telegram never delays startup
  onApplicationBootstrap() {
    void this.recoverInterrupted()
  }

  // Let queued messages finish (AI calls included) before the process exits
  async beforeApplicationShutdown() {
    for (const album of [...this.albums.values()]) album.flush()
    const drained = await this.queue.drain(SHUTDOWN_DRAIN_TIMEOUT_MS)
    if (!drained) this.logger.warn('[beforeApplicationShutdown] exiting with messages still in process')
  }

  // Called by the webhook: returns at once so Telegram gets its 200; the work runs in the chat queue
  enqueue(update: TelegramUpdate): Promise<void> | null {
    const mapped = mapTelegramUpdate(update)
    if (!mapped) return null

    if (mapped.mediaGroupId) return this.collectAlbum(mapped, mapped.mediaGroupId)
    return this.queue.run(mapped.message.chatId, () => this.process(mapped))
  }

  // Each photo of an album is its own update: keep them until none arrives for ALBUM_WAIT_MS and handle them as one
  // message, so the chat gets one list instead of one summary per photo
  private collectAlbum(mapped: MappedTelegramUpdate, groupId: string): Promise<void> {
    const key = `${mapped.message.chatId}:${groupId}`
    const pending = this.albums.get(key)
    if (pending) {
      pending.updates.push(mapped)
      pending.timer.refresh()
      return pending.done
    }

    let resolve!: () => void
    const done = new Promise<void>((settle) => (resolve = settle))
    const album: PendingAlbum = {
      updates: [mapped],
      done,
      timer: setTimeout(() => album.flush(), ALBUM_WAIT_MS),
      flush: () => {
        clearTimeout(album.timer)
        this.albums.delete(key)
        const [first] = album.updates
        const message = {
          ...first.message,
          album: album.updates
            .sort((a, b) => Number(a.message.messageId) - Number(b.message.messageId))
            .map(({ message: { messageId, media, text } }) => ({ messageId, media: media!, text })),
        }
        void this.queue.run(message.chatId, () => this.process({ message })).then(resolve, resolve)
      },
    }
    this.albums.set(key, album)
    return done
  }

  // Whose chat it is decides whose data the message touches (P23, D85): a linked chat is its user; a chat in
  // TELEGRAM_ALLOWED_CHAT_IDS without a link is still the owner of the data that existed before; anyone else is told how to
  // link (or links with /start <code>)
  private async process(mapped: MappedTelegramUpdate): Promise<void> {
    const { chatId } = mapped.message
    try {
      const code = this.linkCodeOf(mapped.message)
      if (code) return await this.linkChat(mapped, code)

      const user = await this.authService.userOfChat(chatId)
      if (!user) {
        await this.telegramClient.sendMessage(chatId, UNLINKED_TEXT).catch(() => undefined)
        return
      }
      await runWithUser(user.id, () => this.processForUser(mapped, user.id))
    } catch (error) {
      this.logger.error(`[process] ${(error as Error).message}`)
      await this.telegramClient.sendMessage(chatId, ERROR_TEXT).catch(() => undefined)
    }
  }

  // "/start <code>": the code that Perfil ▸ Vincular Telegram put in the t.me link
  private linkCodeOf(message: MappedTelegramUpdate['message']): string | null {
    if (message.type !== ChannelMessageType.COMMAND || message.command !== 'start') return null
    return message.text?.trim().split(/\s+/)[1] ?? null
  }

  private async linkChat(mapped: MappedTelegramUpdate, code: string): Promise<void> {
    const { chatId } = mapped.message
    try {
      const user = await this.authService.linkTelegram(code, chatId)
      await this.telegramClient.sendMessage(chatId, LINKED_TEXT)
      // and the usual welcome, now as that user
      await runWithUser(user.id, () => this.processForUser({ message: { ...mapped.message, text: '/start' } }, user.id))
    } catch (error) {
      if (!(error instanceof LinkCodeInvalidException)) throw error
      await this.telegramClient.sendMessage(chatId, LINK_INVALID_TEXT).catch(() => undefined)
    }
  }

  private async processForUser(
    { message, callbackQueryId, sourceMessageId }: MappedTelegramUpdate,
    userId: string,
  ): Promise<void> {
    const { chatId } = message

    try {
      // The history says these changes came from the bot (P29)
      await this.auditContext.enter(AuditSource.BOT, { actorId: userId })
      if (message.type !== ChannelMessageType.COMMAND && message.type !== ChannelMessageType.ACTION) {
        await this.telegramClient.sendChatAction(chatId, 'typing').catch(() => undefined)
      }

      const { replies, notice } = await this.conversationService.handle(message)

      if (callbackQueryId) {
        await this.telegramClient.answerCallbackQuery(callbackQueryId, notice).catch(() => undefined)
      }

      for (const reply of replies) {
        const markup = toReplyMarkup(reply.buttons)

        if (reply.document) {
          await this.telegramClient.sendDocument(chatId, reply.document, reply.text)
        } else if (reply.photo) {
          await this.telegramClient.sendPhoto(chatId, reply.photo, reply.text)
        } else if (reply.keyboard) {
          await this.telegramClient.sendMessage(chatId, reply.text, toKeyboardMarkup(reply.keyboard))
        } else if (reply.editMessageId) {
          // Closing an earlier message (a split message on save): nothing new to say if it cannot be edited
          await this.telegramClient
            .editMessageText(chatId, Number(reply.editMessageId), reply.text, markup)
            .catch((error: Error) => this.logger.warn(`[process] earlier message not edited: ${error.message}`))
        } else if (reply.edit && sourceMessageId) {
          await this.editOrSend(chatId, sourceMessageId, reply.text, markup)
        } else {
          const sent = await this.telegramClient.sendMessage(chatId, reply.text, markup)
          if (reply.trackShareOf) await this.rememberShareMessage(reply.trackShareOf, sent)
        }
      }
    } catch (error) {
      this.logger.error(`[process] ${(error as Error).message}`)

      if (callbackQueryId) {
        await this.telegramClient.answerCallbackQuery(callbackQueryId).catch(() => undefined)
      }
      await this.telegramClient.sendMessage(chatId, ERROR_TEXT).catch(() => undefined)
    }
  }

  // The work behind the reply is already done: if the old message cannot be edited (deleted, unchanged…),
  // send the reply as a new message instead of reporting an error
  private async editOrSend(chatId: string, messageId: number, text: string, markup?: TelegramReplyMarkup) {
    try {
      await this.telegramClient.editMessageText(chatId, messageId, text, markup)
    } catch (error) {
      // Same text and buttons (a button pressed twice): the message is already right, a copy would only duplicate it
      if (isNotModified(error)) return
      this.logger.warn(`[editOrSend] could not edit, sending instead: ${(error as Error).message}`)
      await this.telegramClient.sendMessage(chatId, text, markup)
    }
  }

  // The id of a split message, so it can be closed when its expense is saved (D75). The message is already out: a
  // failure only logs
  private async rememberShareMessage(draftId: string, sent: unknown) {
    const messageId = (sent as { message_id?: number } | undefined)?.message_id
    if (!messageId) return
    await this.conversationService
      .rememberShareMessage(draftId, String(messageId))
      .catch((error: Error) => this.logger.warn(`[rememberShareMessage] ${error.message}`))
  }

  private async recoverInterrupted() {
    try {
      const before = new Date(Date.now() - INTERRUPTED_DRAFT_MIN_AGE_MS)
      // Drafts of every user: a job of the process, not of a request
      const affected = await runAsSystem(() =>
        this.conversationService.recoverInterrupted(ExpenseDraftChannel.TELEGRAM, before),
      )

      for (const { chatId, count } of affected) {
        if (!(await this.authService.userOfChat(chatId))) continue
        const reply = withCommandButtons({ text: TEXTS.interrupted(count) })
        await this.telegramClient.sendMessage(chatId, reply.text, toReplyMarkup(reply.buttons)).catch(() => undefined)
      }
      if (affected.length)
        this.logger.warn(`[recoverInterrupted] moved interrupted drafts of ${affected.length} chat(s) to failed`)
    } catch (error) {
      this.logger.error(`[recoverInterrupted] ${(error as Error).message}`)
    }
  }
}
