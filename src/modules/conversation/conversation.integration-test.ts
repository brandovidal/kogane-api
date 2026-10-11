import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Test, TestingModule } from '@nestjs/testing'
import { vi } from 'vitest'

import { AiProvider } from '@/commons/constants/ai.constant'
import { AiInputPartType } from '@/commons/constants/ai.constant'
import { BotCommand, ChannelMessageType } from '@/commons/constants/conversation.constant'
import { ExpenseDraftChannel, ExpenseDraftStatus } from '@/commons/constants/expense-draft.constant'
import { StoredFileStatus } from '@/commons/constants/stored-file.constant'
import { PrismaModule } from '@/db/prisma/prisma.module'
import { RedisModule } from '@/providers/redis/redis.module'
import { NotificationQueueModule } from '@/modules/notifications/notification-queue.module'
import { PrismaService } from '@/db/prisma/prisma.service'
import { seedCatalogs } from '@/db/seed/catalog.seed'
import { ExpenseExtractionService } from '@/modules/expense-extraction/expense-extraction.service'
import { OcrService } from '@/modules/recognition/ocr.service'
import { StoredFilesService } from '@/modules/stored-files/stored-files.service'
import { GroqTranscriberService } from '@/providers/ai/groq/groq-transcriber.service'
import { AiExtractorProviderStrategy } from '@/providers/ai/ai-extractor-provider.strategy'
import { AiExtractorProvider, GenerateJsonRequest } from '@/providers/ai/dto/ai-extractor.dto'
import { SettingsModule } from '@/settings/settings.module'

import { decodeBotAction } from './bot-action.codec'
import { AuthModule } from '@/modules/auth/auth.module'
import { ConversationModule } from './conversation.module'
import { ConversationService } from './conversation.service'
import { MediaDownloaderRegistry } from './media-downloader.registry'
import { BotReply } from './dto/conversation.types'

// Real AI answers recorded by `make eval-ai CONFIRM=yes RECORD=1` (P9): the flows run the real prompt output through the
// resolver, the state machine and SQLite without calling the AI
const fixtures = JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/ai-responses.json'), 'utf8')) as {
  recordedAt: string
  responses: Record<string, string>
}

// Synthetic answer for a Yape screenshot (no real receipt is committed: they carry personal data)
let yapeRef = ''
const yapeScreenshotAnswer = () =>
  JSON.stringify({
    expenses: [
      {
        destination: 'daily',
        description: 'Yape a Bodega Don Lucho',
        amount: 18,
        currency: 'PEN',
        spentAt: '2026-09-23',
        expenseType: 'essential',
        installment: null,
        period: null,
        personRef: null,
        paymentMethodRef: yapeRef,
        categoryRef: null,
        merchant: 'Bodega Don Lucho',
        operationNumber: '04567812',
        notes: null,
        confidence: {
          destination: 0.9,
          description: 0.8,
          amount: 0.99,
          spentAt: 0.95,
          merchant: 0.95,
          operationNumber: 0.99,
        },
      },
    ],
  })

class RecordedAiProvider implements AiExtractorProvider {
  readonly supportsImages = true

  constructor(readonly provider: AiProvider) {}

  async generateJson({ parts }: GenerateJsonRequest) {
    if (parts.some((part) => part.type === AiInputPartType.IMAGE)) return { text: yapeScreenshotAnswer() }

    const message = parts.find((part) => part.type === AiInputPartType.TEXT)
    const text = message && 'text' in message ? fixtures.responses[message.text] : undefined
    if (!text) throw new Error('AI unavailable (no recorded answer)')
    return { text }
  }
}

describe('Conversation flows (integration)', () => {
  let moduleRef: TestingModule
  let conversation: ConversationService
  let prisma: PrismaService
  let chatCount = 0
  let messageCount = 0
  let chatId: string
  // tesseract.js stand-in: off (every screenshot goes to the AI) unless a test gives it the text of a screen
  const ocr = { enabled: false, read: vi.fn<() => Promise<string>>() }

  // The clock is frozen on the recording day: move it one second per message so drafts keep their order
  const tick = () => vi.setSystemTime(new Date(Date.now() + 1_000))
  const text = async (body: string, messageId = String(++messageCount)) => {
    tick()
    return (
      await conversation.handle({
        channel: ExpenseDraftChannel.TELEGRAM,
        chatId,
        messageId,
        type: ChannelMessageType.TEXT,
        text: body,
      })
    ).replies
  }
  const command = async (name: BotCommand) => {
    tick()
    return (
      await conversation.handle({
        channel: ExpenseDraftChannel.TELEGRAM,
        chatId,
        messageId: String(++messageCount),
        type: ChannelMessageType.COMMAND,
        command: name,
      })
    ).replies
  }
  const press = async (reply: BotReply, label: string) => {
    const button = reply.buttons?.flat().find((candidate) => candidate.label.includes(label))
    if (!button) throw new Error(`No "${label}" button in: ${reply.text}`)
    tick()
    const { replies } = await conversation.handle({
      channel: ExpenseDraftChannel.TELEGRAM,
      chatId,
      messageId: `cb-${++messageCount}`,
      type: ChannelMessageType.ACTION,
      action: decodeBotAction(button.data)!,
    })
    return replies
  }
  const lastDraft = () =>
    prisma.expenseDraft.findFirstOrThrow({
      where: { chatId },
      orderBy: { createdAt: 'desc' },
      include: {
        dailyExpense: true,
        fixedCost: true,
        subscription: true,
        creditCardExpense: true,
        debt: true,
      },
    })
  const onDisk = (key: string) => join(process.cwd(), process.env.STORAGE_LOCAL_DIR ?? '.data/storage', key)
  const storedFileOf = async (draftId: string) => {
    const { fileId } = await prisma.expenseDraft.findUniqueOrThrow({ where: { id: draftId } })
    return prisma.storedFile.findUniqueOrThrow({ where: { id: fileId! } })
  }
  const paymentMethodId = async (name: string) => (await prisma.paymentMethod.findFirstOrThrow({ where: { name } })).id

  beforeAll(async () => {
    // Same day as the recording: relative dates ("ayer") and card billing months stay valid
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`${fixtures.recordedAt}T17:00:00.000Z`))

    moduleRef = await Test.createTestingModule({
      // Redis stays off without REDIS_URL (.env.test): reminders are unit tested
      imports: [SettingsModule, PrismaModule, AuthModule, RedisModule, NotificationQueueModule, ConversationModule],
    })
      .overrideProvider(AiExtractorProviderStrategy)
      .useValue({ getProvider: (type: AiProvider) => new RecordedAiProvider(type) })
      // Whisper stand-in: every voice note says a sentence of the golden set
      .overrideProvider(GroqTranscriberService)
      .useValue({ transcribe: async () => 'cafe 8 con plin' })
      .overrideProvider(OcrService)
      .useValue(ocr)
      .compile()
    await moduleRef.init()

    conversation = moduleRef.get(ConversationService)
    prisma = moduleRef.get(PrismaService)
    // Different bytes per Telegram file, so each screenshot is its own stored file (D58)
    moduleRef.get(MediaDownloaderRegistry).register(ExpenseDraftChannel.TELEGRAM, async (fileId) => ({
      mimeType: 'image/jpeg',
      data: Buffer.from(`fake-jpeg-${fileId}`).toString('base64'),
    }))
    await seedCatalogs(prisma, 'test-user')
    yapeRef = (await moduleRef.get(ExpenseExtractionService).loadCatalog()).entries.find(
      (entry) => entry.name === 'Yape',
    )!.ref
  })

  afterAll(async () => {
    await moduleRef.close()
    vi.useRealTimers()
  })

  beforeEach(() => {
    chatId = `flow-chat-${++chatCount}`
  })

  it('should save a day-to-day expense paid with Yape in exp_daily_expenses', async () => {
    const [summary] = await text('almuerzo 25 soles con yape')
    await press(summary, 'Guardar')

    const draft = await lastDraft()
    expect(draft.status).toBe(ExpenseDraftStatus.SAVED)
    expect(draft.dailyExpense).toMatchObject({
      amount: 25,
      paymentMethodId: await paymentMethodId('Yape'),
    })
  })

  it('should ask for the payment method, take the quick reply and keep "ayer" as the date', async () => {
    const [question] = await text('uber 18.50 ayer')
    expect(question.text).toContain('¿Con qué pagaste?')

    const [summary] = await press(question, 'Efectivo')
    await press(summary, 'Guardar')

    const { dailyExpense } = await lastDraft()
    expect(dailyExpense?.paymentMethodId).toBe(await paymentMethodId('Efectivo'))
    expect(dailyExpense?.spentAt.toISOString().slice(0, 10)).toBe('2026-09-22')
  })

  it('should save a card purchase in installments in the billing month of the card', async () => {
    const [summary] = await text('zapatillas 300 con io en 3 cuotas')
    await press(summary, 'Guardar')

    // IO closes on the 25th: a purchase on the 23rd is billed in September
    expect((await lastDraft()).creditCardExpense).toMatchObject({
      installment: '1/3',
      paymentMonth: 9,
      paymentYear: 2026,
    })
  })

  it('should route a fixed cost, a subscription and a receivable to their tables', async () => {
    let [summary] = await text('luz 120 soles con bcp')
    await press(summary, 'Guardar')
    expect((await lastDraft()).fixedCost).not.toBeNull()
    ;[summary] = await text('netflix 45 mensual con la oh')
    await press(summary, 'Guardar')
    expect((await lastDraft()).subscription?.period).toBe('monthly')
    ;[summary] = await text('le presté 100 a dany')
    await press(summary, 'Guardar')
    const danery = await prisma.person.findFirstOrThrow({ where: { name: 'Danery' } })
    expect((await lastDraft()).debt).toMatchObject({ personId: danery.id, direction: 'owed_to_me', amount: 100 })
  })

  // P17: the payment is read without the AI and only counts after ✅ Confirmar
  it('should lend to Danery, register her payment with "dany me pagó", confirm it and show it in /deudas', async () => {
    const [summary] = await text('le presté 100 a dany')
    await press(summary, 'Guardar')
    const danery = await prisma.person.findFirstOrThrow({ where: { name: 'Danery' } })
    const paidByDanery = async () =>
      (await prisma.debt.aggregate({ where: { personId: danery.id }, _sum: { paidAmount: true } }))._sum.paidAmount

    const [proposal] = await text('dany me pagó 60')
    expect(proposal.text).toContain('Abono de Danery')
    expect(await paidByDanery()).toBe(0)

    const [saved] = await press(proposal, 'Confirmar')
    expect(saved.text).toContain('Abono guardado')
    expect(await paidByDanery()).toBe(60)

    const [debts] = await command(BotCommand.DEBTS)
    expect(debts.text).toContain('• Danery: te debe')
    tick()
    const [detail] = (
      await conversation.handle({
        channel: ExpenseDraftChannel.TELEGRAM,
        chatId,
        messageId: String(++messageCount),
        type: ChannelMessageType.COMMAND,
        command: BotCommand.DEBTS,
        text: '/deudas dany',
      })
    ).replies
    expect(detail.text).toContain('<b>Danery</b>')
    expect(detail.text).toContain('(abonado S/ 60.00)')
  })

  it('should apply a local correction without calling the AI', async () => {
    await text('cafe 8 con plin')
    const [summary] = await text('monto 10')

    expect(summary.text).toContain('10')
    await press(summary, 'Guardar')
    expect((await lastDraft()).dailyExpense?.amount).toBe(10)
  })

  it('should offer to add an unknown payment method and use it', async () => {
    await text('pasaje 5 soles')
    const [offer] = await text('bbva')
    expect(offer.text).toContain('No conozco')

    const created = await press(offer, 'Billetera')
    await press(created[created.length - 1], 'Guardar')

    expect((await lastDraft()).dailyExpense?.paymentMethodId).toBe(await paymentMethodId('bbva'))
  })

  it('should send an expense to /borrador and save it after Retomar', async () => {
    const [summary] = await text('cafe 8 con plin')
    await press(summary, 'Borrador')

    const drafts = await command(BotCommand.DRAFTS)
    const [resumed] = await press(drafts[1], 'Retomar')
    await press(resumed, 'Guardar')

    expect((await lastDraft()).dailyExpense).not.toBeNull()
  })

  it('should ignore a webhook retry of a message already handled', async () => {
    await text('almuerzo 25 soles con yape', 'same-message')

    await expect(text('almuerzo 25 soles con yape', 'same-message')).resolves.toEqual([])
    expect(await prisma.expenseDraft.count({ where: { chatId } })).toBe(1)
  })

  it('should discard a message that is not an expense', async () => {
    const [reply] = await text('hola, cómo estás?')

    expect(reply.text).toContain('No encontré un gasto')
    expect((await lastDraft()).status).toBe(ExpenseDraftStatus.DISCARDED)
  })

  it('should leave the message in /borrador as failed when the AI is down', async () => {
    const [reply] = await text('mensaje que la AI no puede leer 99')

    expect(reply.text).toContain('/borrador')
    expect((await lastDraft()).status).toBe(ExpenseDraftStatus.FAILED)
    const drafts = await command(BotCommand.DRAFTS)
    expect(drafts.some((item) => item.buttons?.flat().some((button) => button.label.includes('Retomar')))).toBe(true)
  })

  it('should answer /resumen, /ultimos and /uso', async () => {
    const [summary] = await text('almuerzo 25 soles con yape')
    await press(summary, 'Guardar')

    expect((await command(BotCommand.SUMMARY))[0].text).toContain('Día a día')
    expect((await command(BotCommand.RECENT))[0].text).toMatch(/almuerzo/i)
    expect((await command(BotCommand.USAGE))[0].text).toContain('Uso de la AI hoy')
  })

  it('should read a Yape screenshot, save it, and then spot the same image and the same operation', async () => {
    const image = (messageId: string, uniqueId: string) =>
      conversation.handle({
        channel: ExpenseDraftChannel.TELEGRAM,
        chatId,
        messageId,
        type: ChannelMessageType.IMAGE,
        media: { fileId: `file-${uniqueId}`, uniqueId },
        text: 'yape',
      })

    tick()
    const [summary] = (await image('img-1', 'unique-yape-1')).replies
    await press(summary, 'Guardar')
    const saved = await lastDraft()
    expect(saved).toMatchObject({ inputType: 'image', mediaUniqueId: 'unique-yape-1', operationNumber: '04567812' })
    expect(saved.dailyExpense?.paymentMethodId).toBe(await paymentMethodId('Yape'))

    // Saved: the screenshot moved from drafts/ to expenses/ and no longer expires
    const file = await storedFileOf(saved.id)
    expect(file).toMatchObject({ status: StoredFileStatus.KEPT, expiresAt: null, contentType: 'image/jpeg' })
    expect(file.storageKey).toMatch(/^test\/finance\/expenses\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/)
    expect(readFileSync(onDisk(file.storageKey)).toString()).toBe('fake-jpeg-file-unique-yape-1')

    tick()
    expect((await image('img-2', 'unique-yape-1')).replies[0].text).toContain('Ya recibí esta imagen')

    // Another screenshot of the same payment (different file, same operation number)
    tick()
    expect((await image('img-3', 'unique-yape-2')).replies[0].text).toContain('Parece que ya registraste este gasto')
  })

  // P21 (D63): the purchase detail of the IO app is read by the local template, without the AI
  // D66: the installment amount was deduced (300 / 3), so it is confirmed first and then the 3 rows are created
  it('should read an IO purchase in cuotas with the OCR template, confirm the installment and save the 3 on IO', async () => {
    ocr.enabled = true
    ocr.read.mockResolvedValue(
      [
        'Detalle de categoría',
        'RESTAURANTES',
        '1consumo',
        '14 Sep 2026',
        'CEVICHERIA',
        'Virtual / 3 cuotas',
        '-S/300.00',
      ].join('\n'),
    )
    try {
      tick()
      const { replies } = await conversation.handle({
        channel: ExpenseDraftChannel.TELEGRAM,
        chatId,
        messageId: String(++messageCount),
        type: ChannelMessageType.IMAGE,
        media: { fileId: 'file-io-detail', uniqueId: 'unique-io-detail' },
      })
      const [confirm] = await press(replies[0], 'Guardar')
      expect(confirm.text).toContain('¿Cuota de S/ 100.00 × 3?')
      const saved3 = await press(confirm, 'Sí, guardar 3 cuotas')
      expect(saved3[1].text).toContain('Cuotas 1/3 a 3/3')

      const saved = await lastDraft()
      expect(saved.documentType).toBe('io_purchase_detail')
      expect(saved.creditCardExpense).toMatchObject({
        amount: 100,
        installment: '1/3',
        paymentMethodId: await paymentMethodId('IO'),
      })
      const rows = await prisma.creditCardExpense.findMany({
        where: { description: saved.creditCardExpense?.description },
        orderBy: [{ paymentYear: 'asc' }, { paymentMonth: 'asc' }],
      })
      expect(rows.map((row) => [row.installment, row.paymentMonth, row.amount])).toEqual([
        ['1/3', 9, 100],
        ['2/3', 10, 100],
        ['3/3', 11, 100],
      ])
      const logs = await prisma.aiRequestLog.findMany({ where: { draftId: saved.id } })
      expect(logs.map((log) => [log.provider, log.success])).toEqual([['local', true]])
    } finally {
      ocr.enabled = false
      ocr.read.mockReset()
    }
  })

  it('should keep a screenshot parked in /borrador for 7 days and ask for it again once it expired', async () => {
    tick()
    const { replies } = await conversation.handle({
      channel: ExpenseDraftChannel.TELEGRAM,
      chatId,
      messageId: 'img-parked',
      type: ChannelMessageType.IMAGE,
      media: { fileId: 'file-parked', uniqueId: 'unique-parked' },
    })
    await press(replies[0], 'Borrador')

    const parked = await lastDraft()
    const file = await storedFileOf(parked.id)
    expect(parked.status).toBe(ExpenseDraftStatus.PENDING_REVIEW)
    expect(file).toMatchObject({ status: StoredFileStatus.TEMPORARY })
    expect(file.storageKey).toMatch(/^test\/finance\/drafts\//)
    expect(existsSync(onDisk(file.storageKey))).toBe(true)

    // 8 days later the daily cleanup removes it; the row stays as history
    await moduleRef.get(StoredFilesService).deleteExpired(new Date(Date.now() + 8 * 24 * 60 * 60_000))
    expect((await storedFileOf(parked.id)).status).toBe(StoredFileStatus.DELETED)
    expect(existsSync(onDisk(file.storageKey))).toBe(false)

    // Retry from the web Borrador: it cannot be read again, so the draft fails
    tick()
    await conversation.retryExtraction({ ...parked, confidence: {}, missingFields: [] })
    expect((await lastDraft()).status).toBe(ExpenseDraftStatus.FAILED)

    // Retomar from the bot says why
    const drafts = await command(BotCommand.DRAFTS)
    const failed = drafts.find((reply) => reply.buttons?.flat().some((button) => button.label.includes('Retomar')))!
    const [answer] = await press(failed, 'Retomar')
    expect(answer.text).toContain('La captura ya expiró')
  })

  it('should transcribe a voice note, show what it heard and save the expense', async () => {
    tick()
    const { replies } = await conversation.handle({
      channel: ExpenseDraftChannel.TELEGRAM,
      chatId,
      messageId: 'voice-1',
      type: ChannelMessageType.AUDIO,
      media: { fileId: 'file-voice-1', uniqueId: 'unique-voice-1', durationSeconds: 5 },
    })
    expect(replies[0].text).toContain('Entendí')

    await press(replies[0], 'Guardar')
    const saved = await lastDraft()
    expect(saved).toMatchObject({ inputType: 'audio', rawText: 'cafe 8 con plin', status: ExpenseDraftStatus.SAVED })
    expect(saved.dailyExpense?.paymentMethodId).toBe(await paymentMethodId('Plin'))
    expect(await prisma.aiRequestLog.count({ where: { draftId: saved.id } })).toBeGreaterThan(0)
  })
})
