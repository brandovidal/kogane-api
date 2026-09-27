import { Injectable } from '@nestjs/common'

import { Prisma } from '@/generated/prisma/client'

import { PrismaService } from '@/db/prisma/prisma.service'
import { PrismaErrorCode } from '@/commons/constants/database.constant'
import {
  ExpenseDraftChannel,
  ExpenseDraftStatus,
  NEW_EXPENSE_DRAFT_STATUSES,
  OPEN_EXPENSE_DRAFT_STATUSES,
} from '@/commons/constants/expense-draft.constant'
import { isPrismaError } from '@/commons/helpers/prisma-error.helper'
import { DuplicateExpenseDraftException } from '@/commons/exceptions/expense-draft/duplicate-expense-draft.exception'
import { ExpenseDraftNotFoundException } from '@/commons/exceptions/expense-draft/expense-draft-not-found.exception'

import {
  CreateExpenseDraftDbDto,
  ExpenseDraftDbDto,
  SavedExpenseFilters,
  UpdateExpenseDraftDbDto,
} from './expenseDraftDB.dto'
import { ExpenseDraftDBSerializer } from './expenseDraftDB.serializer'

@Injectable()
export class ExpenseDraftDBRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly serializer: ExpenseDraftDBSerializer,
  ) {}

  async create(data: CreateExpenseDraftDbDto): Promise<ExpenseDraftDbDto> {
    try {
      const expenseDraft = await this.prisma.expenseDraft.create({ data })
      return this.serializer.toDto(expenseDraft)
    } catch (error) {
      // The same channel message delivered twice (webhook retry) must not create a second expense draft
      if (isPrismaError(error, PrismaErrorCode.UNIQUE_CONSTRAINT)) {
        const { channel, chatId, messageId, itemIndex } = data
        throw new DuplicateExpenseDraftException({ channel, chatId, messageId, itemIndex: itemIndex ?? 0 })
      }
      throw error
    }
  }

  async findById(id: string): Promise<ExpenseDraftDbDto | null> {
    const expenseDraft = await this.prisma.expenseDraft.findUnique({ where: { id } })
    return expenseDraft ? this.serializer.toDto(expenseDraft) : null
  }

  // The open expense draft is the conversation state of a chat
  async findOpenByChat(
    channel: ExpenseDraftChannel,
    chatId: string,
    updatedAfter: Date,
  ): Promise<ExpenseDraftDbDto | null> {
    const expenseDraft = await this.prisma.expenseDraft.findFirst({
      where: { channel, chatId, status: { in: OPEN_EXPENSE_DRAFT_STATUSES }, updatedAt: { gte: updatedAfter } },
      orderBy: { updatedAt: 'desc' },
    })
    return expenseDraft ? this.serializer.toDto(expenseDraft) : null
  }

  // The open expenses of one list of screenshots (P21), in the order they arrived
  async findOpenByBatch(chatId: string, batchId: string): Promise<ExpenseDraftDbDto[]> {
    const expenseDrafts = await this.prisma.expenseDraft.findMany({
      where: { chatId, batchId, status: { in: OPEN_EXPENSE_DRAFT_STATUSES } },
      // Drafts of one album can share the millisecond: the message and then its item keep the arrival order
      orderBy: [{ createdAt: 'asc' }, { messageId: 'asc' }, { itemIndex: 'asc' }],
    })
    return expenseDrafts.map((expenseDraft) => this.serializer.toDto(expenseDraft))
  }

  async update(id: string, data: UpdateExpenseDraftDbDto): Promise<ExpenseDraftDbDto> {
    try {
      const expenseDraft = await this.prisma.expenseDraft.update({
        where: { id },
        data: this.serializer.toUpdateData(data),
      })
      return this.serializer.toDto(expenseDraft)
    } catch (error) {
      if (isPrismaError(error, PrismaErrorCode.RECORD_NOT_FOUND)) {
        throw new ExpenseDraftNotFoundException({ id })
      }
      throw error
    }
  }

  // Open drafts nobody confirmed in time go to Borrador (D50) instead of being lost
  // Stale new expenses go to Borrador; a stale edit of a saved expense is dropped (the saved one stays as it was)
  async moveStaleOpenToReview(channel: ExpenseDraftChannel, chatId: string, before: Date): Promise<number> {
    const [{ count }] = await this.prisma.$transaction([
      this.prisma.expenseDraft.updateMany({
        where: { channel, chatId, status: { in: NEW_EXPENSE_DRAFT_STATUSES }, updatedAt: { lt: before } },
        data: { status: ExpenseDraftStatus.PENDING_REVIEW, pendingField: null },
      }),
      this.prisma.expenseDraft.updateMany({
        where: { channel, chatId, status: ExpenseDraftStatus.EDITING, updatedAt: { lt: before } },
        data: { status: ExpenseDraftStatus.DISCARDED, pendingField: null },
      }),
    ])
    return count
  }

  // Drafts whose AI extraction never finished (process restarted mid-request): still `draft`, with no question
  // asked and no extracted data. They become `failed` so /borrador can retry them. Returns the affected chats.
  async failInterruptedUpdatedBefore(
    channel: ExpenseDraftChannel,
    before: Date,
    chatId?: string,
  ): Promise<{ chatId: string; count: number }[]> {
    const where = {
      channel,
      ...(chatId ? { chatId } : {}),
      status: ExpenseDraftStatus.DRAFT,
      pendingField: null,
      destination: null,
      description: null,
      amount: null,
      updatedAt: { lt: before },
    }
    const interrupted = await this.prisma.expenseDraft.findMany({ where, select: { id: true, chatId: true } })
    if (!interrupted.length) return []

    await this.prisma.expenseDraft.updateMany({
      where: { id: { in: interrupted.map(({ id }) => id) } },
      data: { status: ExpenseDraftStatus.FAILED },
    })

    const countByChat = new Map<string, number>()
    for (const draft of interrupted) countByChat.set(draft.chatId, (countByChat.get(draft.chatId) ?? 0) + 1)
    return [...countByChat].map(([chat, count]) => ({ chatId: chat, count }))
  }

  // The same image sent again (same file unique id); discarded ones do not count
  async findByMediaUniqueId(
    channel: ExpenseDraftChannel,
    chatId: string,
    mediaUniqueId: string,
  ): Promise<ExpenseDraftDbDto | null> {
    const expenseDraft = await this.prisma.expenseDraft.findFirst({
      where: { channel, chatId, mediaUniqueId, status: { not: ExpenseDraftStatus.DISCARDED } },
      orderBy: { createdAt: 'desc' },
    })
    return expenseDraft ? this.serializer.toDto(expenseDraft) : null
  }

  // A saved expense with the same receipt operation number: probably registered twice (text and screenshot)
  async existsSavedWithOperationNumber(operationNumber: string, excludeId: string): Promise<boolean> {
    const count = await this.prisma.expenseDraft.count({
      where: { operationNumber, status: ExpenseDraftStatus.SAVED, id: { not: excludeId } },
    })
    return count > 0
  }

  // P21: the same card, day and amount already registered or pending (overlapping screenshots), last 60 days
  findSameCardDayAmount(
    { id, paymentMethodId, amount, spentAt }: { id: string; paymentMethodId: string; amount: number; spentAt: Date },
    since: Date,
  ): Promise<Pick<ExpenseDraftDbDto, 'id' | 'description' | 'merchant'>[]> {
    const dayStart = new Date(`${spentAt.toISOString().slice(0, 10)}T00:00:00.000Z`)
    return this.prisma.expenseDraft.findMany({
      where: {
        id: { not: id },
        paymentMethodId,
        amount: { gte: amount - 0.005, lte: amount + 0.005 },
        spentAt: { gte: dayStart, lt: new Date(dayStart.getTime() + 24 * 60 * 60_000) },
        status: { in: [ExpenseDraftStatus.SAVED, ExpenseDraftStatus.PENDING_REVIEW, ...OPEN_EXPENSE_DRAFT_STATUSES] },
        createdAt: { gte: since },
      },
      select: { id: true, description: true, merchant: true },
    })
  }

  // /cancelar: close every open expense draft of the chat
  async discardOpenByChat(channel: ExpenseDraftChannel, chatId: string): Promise<number> {
    const { count } = await this.prisma.expenseDraft.updateMany({
      where: { channel, chatId, status: { in: OPEN_EXPENSE_DRAFT_STATUSES } },
      data: { status: ExpenseDraftStatus.DISCARDED, pendingField: null },
    })
    return count
  }

  // /editar (D76): saved expenses of the chat that match every given filter, newest first
  async searchSaved(
    channel: ExpenseDraftChannel,
    chatId: string,
    filters: SavedExpenseFilters,
    limit: number,
  ): Promise<ExpenseDraftDbDto[]> {
    const { text, amount, day, personId, paymentMethodId, categoryId, since } = filters
    const expenseDrafts = await this.prisma.expenseDraft.findMany({
      where: {
        channel,
        chatId,
        status: ExpenseDraftStatus.SAVED,
        confirmedAt: { gte: since },
        ...(text ? { description: { contains: text } } : {}),
        ...(amount != null ? { amount: { gte: amount - 0.01, lte: amount + 0.01 } } : {}),
        ...(day ? { spentAt: { gte: day, lt: new Date(day.getTime() + 86_400_000) } } : {}),
        ...(personId ? { personId } : {}),
        ...(paymentMethodId ? { paymentMethodId } : {}),
        ...(categoryId ? { categoryId } : {}),
      },
      orderBy: { confirmedAt: 'desc' },
      take: limit,
    })
    return expenseDrafts.map((expenseDraft) => this.serializer.toDto(expenseDraft))
  }

  // /editar (D76): an EDITING copy of a saved expense; the original stays saved until the copy is saved
  async createEditCopy(original: ExpenseDraftDbDto, messageId: string): Promise<ExpenseDraftDbDto> {
    const {
      id,
      messageId: _messageId,
      itemIndex: _itemIndex,
      status: _status,
      pendingField: _pendingField,
      confirmedAt: _confirmedAt,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      batchId: _batchId,
      shareMessageId: _shareMessageId,
      ...fields
    } = original
    const expenseDraft = await this.prisma.expenseDraft.create({
      data: {
        ...this.serializer.toUpdateData(fields),
        channel: original.channel,
        chatId: original.chatId,
        inputType: original.inputType,
        messageId,
        status: ExpenseDraftStatus.EDITING,
        replacesDraftId: id,
      } as Prisma.ExpenseDraftUncheckedCreateInput,
    })
    return this.serializer.toDto(expenseDraft)
  }

  // /rapido (P18): what was saved since a date, from any chat, newest first
  async findSavedSince(since: Date, limit: number): Promise<ExpenseDraftDbDto[]> {
    const expenseDrafts = await this.prisma.expenseDraft.findMany({
      where: { status: ExpenseDraftStatus.SAVED, confirmedAt: { gte: since } },
      orderBy: { confirmedAt: 'desc' },
      take: limit,
    })
    return expenseDrafts.map((expenseDraft) => this.serializer.toDto(expenseDraft))
  }

  // /rapido: a new draft with the fields of a saved expense, in this chat and dated `spentAt`; it is saved right away
  async createQuickCopy(
    original: ExpenseDraftDbDto,
    target: { channel: ExpenseDraftChannel; chatId: string; messageId: string },
    spentAt: Date,
  ): Promise<ExpenseDraftDbDto> {
    const {
      id: _id,
      channel: _channel,
      chatId: _chatId,
      messageId: _messageId,
      itemIndex: _itemIndex,
      status: _status,
      pendingField: _pendingField,
      confirmedAt: _confirmedAt,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      batchId: _batchId,
      shareMessageId: _shareMessageId,
      fileId: _fileId,
      mediaFileId: _mediaFileId,
      mediaUniqueId: _mediaUniqueId,
      operationNumber: _operationNumber,
      replacesDraftId: _replacesDraftId,
      ...fields
    } = original
    const expenseDraft = await this.prisma.expenseDraft.create({
      data: {
        ...this.serializer.toUpdateData({ ...fields, spentAt }),
        channel: target.channel,
        chatId: target.chatId,
        messageId: target.messageId,
        inputType: original.inputType,
        status: ExpenseDraftStatus.DRAFT,
      } as Prisma.ExpenseDraftUncheckedCreateInput,
    })
    return this.serializer.toDto(expenseDraft)
  }

  // /ultimos
  async findRecentSaved(channel: ExpenseDraftChannel, chatId: string, limit: number): Promise<ExpenseDraftDbDto[]> {
    const expenseDrafts = await this.prisma.expenseDraft.findMany({
      where: { channel, chatId, status: ExpenseDraftStatus.SAVED },
      orderBy: { confirmedAt: 'desc' },
      take: limit,
    })
    return expenseDrafts.map((expenseDraft) => this.serializer.toDto(expenseDraft))
  }

  // /borrador: expenses pending review of the chat, newest first
  async findByStatuses(
    channel: ExpenseDraftChannel,
    chatId: string,
    statuses: ExpenseDraftStatus[],
    limit: number,
  ): Promise<{ items: ExpenseDraftDbDto[]; total: number }> {
    const where = { channel, chatId, status: { in: statuses } }
    const [expenseDrafts, total] = await Promise.all([
      this.prisma.expenseDraft.findMany({ where, orderBy: { updatedAt: 'desc' }, take: limit }),
      this.prisma.expenseDraft.count({ where }),
    ])
    return { items: expenseDrafts.map((expenseDraft) => this.serializer.toDto(expenseDraft)), total }
  }

  // Borrador in kogane-app (P7): every channel, newest first
  async findForReview(
    statuses: ExpenseDraftStatus[],
    limit: number,
    offset: number,
  ): Promise<{ items: ExpenseDraftDbDto[]; total: number }> {
    const where = { status: { in: statuses } }
    const [expenseDrafts, total] = await Promise.all([
      this.prisma.expenseDraft.findMany({ where, orderBy: { updatedAt: 'desc' }, take: limit, skip: offset }),
      this.prisma.expenseDraft.count({ where }),
    ])
    return { items: expenseDrafts.map((expenseDraft) => this.serializer.toDto(expenseDraft)), total }
  }

  // Open drafts of one message go back to Borrador (after a retry from the web)
  async parkMessage(channel: ExpenseDraftChannel, chatId: string, messageId: string): Promise<number> {
    const { count } = await this.prisma.expenseDraft.updateMany({
      where: { channel, chatId, messageId, status: { in: OPEN_EXPENSE_DRAFT_STATUSES } },
      data: { status: ExpenseDraftStatus.PENDING_REVIEW, pendingField: null },
    })
    return count
  }
}
