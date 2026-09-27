import { Logger } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { vi } from 'vitest'

import {
  BotAction,
  BotCommand,
  ChannelMessageType,
  FREE_CORRECTION_FIELD,
} from '@/commons/constants/conversation.constant'
import { DebtDirection, DebtTiming } from '@/commons/constants/debt.constant'
import { ExpenseDestination } from '@/commons/constants/expense.constant'
import { PaymentMethodType } from '@/commons/constants/catalog.constant'
import { ExpenseDraftChannel, ExpenseDraftStatus } from '@/commons/constants/expense-draft.constant'
import { ExpenseField } from '@/commons/constants/expense-extraction.constant'
import { DuplicateExpenseDraftException } from '@/commons/exceptions/expense-draft/duplicate-expense-draft.exception'
import { StoredFileExpiredException } from '@/commons/exceptions/stored-file/stored-file-expired.exception'
import { SavedExpenseLockedException } from '@/commons/exceptions/expense/saved-expense-locked.exception'
import { ExpenseExtractionFailedException } from '@/commons/exceptions/expense-extraction/expense-extraction-failed.exception'
import { ExpenseDraftDBRepository } from '@/db/models/expense-draft/expenseDraftDB.repository'
import { ExpenseDBRepository } from '@/db/models/expense/expenseDB.repository'
import { PaymentMethodDBRepository } from '@/db/models/payment-method/paymentMethodDB.repository'
import { ExpenseExtractionService } from '@/modules/expense-extraction/expense-extraction.service'
import { buildExtractionCatalog } from '@/modules/expense-extraction/expense-extraction.catalog'
import { completeExpense } from '@/modules/expense-extraction/expense-extraction.resolver'
import { mockCatalogSource } from '@/modules/expense-extraction/mocks/expense-extraction.mock'
import { StoredFilesService } from '@/modules/stored-files/stored-files.service'
import { DebtsService } from '@/modules/debts/debts.service'
import { RecognitionService } from '@/modules/recognition/recognition.service'
import { BudgetService } from '@/modules/budget/budget.service'
import { ReportsService } from '@/modules/reports/reports.service'
import { NotificationsBotService } from '@/modules/notifications/notifications-bot.service'
import { BotToolsService } from './tools/bot-tools.service'
import { RecognizedScreen } from '@/modules/recognition/recognition.templates'

import { ConversationService } from './conversation.service'
import { MediaDownloaderRegistry } from './media-downloader.registry'
import { ExpenseSaverService } from './expense-saver.service'
import { ChannelMessage } from './dto/conversation.types'
import {
  buildExpenseDraft,
  buildResolvedExpense,
  CHAT_ID,
  FILE_ID,
  mockCatalog,
  textMessage,
} from './mocks/conversation.mock'

const mockExpenseDraftDB = {
  create: vi.fn(),
  update: vi.fn(),
  findById: vi.fn(),
  findOpenByChat: vi.fn(),
  moveStaleOpenToReview: vi.fn(),
  failInterruptedUpdatedBefore: vi.fn(),
  discardOpenByChat: vi.fn(),
  findRecentSaved: vi.fn(),
  findByStatuses: vi.fn(),
  findByMediaUniqueId: vi.fn(),
  existsSavedWithOperationNumber: vi.fn(),
  findSameCardDayAmount: vi.fn(),
  parkMessage: vi.fn(),
  findOpenByBatch: vi.fn(),
  searchSaved: vi.fn(),
  createEditCopy: vi.fn(),
  createQuickCopy: vi.fn(),
}
const mockExpenseDB = { findMonthlyTotals: vi.fn() }
const mockMediaDownloader = { download: vi.fn() }
const mockStoredFiles = { download: vi.fn(), storeTemporary: vi.fn() }
const mockDebts = {
  proposePayment: vi.fn(),
  findProposal: vi.fn(),
  pickInstallment: vi.fn(),
  confirmPayment: vi.fn(),
  cancelPayment: vi.fn(),
  findOpen: vi.fn(),
  summary: vi.fn(),
}
const mockRecognition = {
  recognize: vi.fn(),
  toExpenses: vi.fn(),
  reconcile: vi.fn(),
  todayStats: vi.fn(),
}
const mockExtraction = {
  extract: vi.fn(),
  parseLocalCorrection: vi.fn(),
  loadCatalog: vi.fn(),
  getUsage: vi.fn(),
  transcribe: vi.fn(),
}
const mockSaver = { save: vi.fn() }
const mockBudget = { alertAfterSave: vi.fn(), month: vi.fn() }
const mockReports = { debts: vi.fn() }
const mockNotificationsBot = {
  answerAmount: vi.fn(),
  handleAction: vi.fn(),
  settingsReply: vi.fn(),
  calendarReply: vi.fn(),
  installmentsReply: vi.fn(),
}
const mockPaymentMethodDB = { create: vi.fn(), updateBillingDays: vi.fn() }
// The groups of the menu and their commands (P18) have their own tests: here only how the conversation hands over to them
const mockBotTools = {
  handleCommand: vi.fn(),
  takeAwaiting: vi.fn(),
  clearAwaiting: vi.fn(),
  await: vi.fn(),
  quickExpense: vi.fn(),
  undoConfirm: vi.fn(),
  undoCancel: vi.fn(),
  applyRules: vi.fn(),
  learnRule: vi.fn(),
  removeRule: vi.fn(),
  exportFile: vi.fn(),
}

const action = (name: BotAction, field?: string, value?: string): ChannelMessage => ({
  channel: ExpenseDraftChannel.TELEGRAM,
  chatId: CHAT_ID,
  messageId: 'callback:1',
  type: ChannelMessageType.ACTION,
  action: { name, draftId: FILE_ID, field, value },
})

const command = (name: BotCommand): ChannelMessage => ({
  channel: ExpenseDraftChannel.TELEGRAM,
  chatId: CHAT_ID,
  messageId: '12',
  type: ChannelMessageType.COMMAND,
  command: name,
})

describe('ConversationService', () => {
  let service: ConversationService

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationService,
        { provide: ExpenseDraftDBRepository, useValue: mockExpenseDraftDB },
        { provide: ExpenseDBRepository, useValue: mockExpenseDB },
        { provide: PaymentMethodDBRepository, useValue: mockPaymentMethodDB },
        { provide: ExpenseExtractionService, useValue: mockExtraction },
        { provide: ExpenseSaverService, useValue: mockSaver },
        { provide: MediaDownloaderRegistry, useValue: mockMediaDownloader },
        { provide: StoredFilesService, useValue: mockStoredFiles },
        { provide: DebtsService, useValue: mockDebts },
        { provide: RecognitionService, useValue: mockRecognition },
        { provide: BudgetService, useValue: mockBudget },
        { provide: ReportsService, useValue: mockReports },
        { provide: NotificationsBotService, useValue: mockNotificationsBot },
        { provide: BotToolsService, useValue: mockBotTools },
      ],
    }).compile()

    service = module.get<ConversationService>(ConversationService)

    mockExtraction.loadCatalog.mockResolvedValue(mockCatalog)
    mockNotificationsBot.answerAmount.mockResolvedValue(null)
    mockBotTools.handleCommand.mockResolvedValue(null)
    mockBotTools.takeAwaiting.mockReturnValue(null)
    mockBotTools.applyRules.mockImplementation(async (expenses: unknown) => expenses)
    mockSaver.save.mockResolvedValue({ id: 'expense-1', installments: null, budget: null })
    mockBudget.alertAfterSave.mockResolvedValue(null)
    mockExpenseDraftDB.findOpenByChat.mockResolvedValue(null)
    mockExpenseDraftDB.moveStaleOpenToReview.mockResolvedValue(0)
    mockExpenseDraftDB.failInterruptedUpdatedBefore.mockResolvedValue([])
    mockExpenseDraftDB.findByMediaUniqueId.mockResolvedValue(null)
    mockExpenseDraftDB.existsSavedWithOperationNumber.mockResolvedValue(false)
    mockExpenseDraftDB.findSameCardDayAmount.mockResolvedValue([])
    mockExpenseDraftDB.findOpenByBatch.mockResolvedValue([])
    mockExpenseDraftDB.create.mockImplementation(async (data) =>
      buildExpenseDraft({ ...data, id: `file-${data.itemIndex ?? 0}` }),
    )
    mockExpenseDraftDB.update.mockImplementation(async (id, data) => buildExpenseDraft({ id, ...data }))
    mockStoredFiles.storeTemporary.mockResolvedValue({ id: 'stored-1' })
    mockDebts.proposePayment.mockResolvedValue(null)
    mockRecognition.recognize.mockResolvedValue(null)
    mockRecognition.todayStats.mockResolvedValue({ attempts: 0, resolved: 0 })
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('new expenses', () => {
    it('should extract the message and show the summary with the confirmation buttons', async () => {
      mockExtraction.extract.mockResolvedValue({ expenses: [buildResolvedExpense()] })

      const { replies } = await service.handle(textMessage('almuerzo 25 soles con yape'))

      expect(mockExpenseDraftDB.create).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: CHAT_ID, messageId: '11', rawText: 'almuerzo 25 soles con yape' }),
      )
      expect(mockExtraction.extract).toHaveBeenCalledWith({
        text: 'almuerzo 25 soles con yape',
        draftId: 'file-0',
      })
      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith(
        'file-0',
        expect.objectContaining({ status: ExpenseDraftStatus.AWAITING_CONFIRMATION, pendingField: null }),
      )
      expect(replies).toHaveLength(1)
      expect(replies[0].text).toContain('Almuerzo')
      expect(replies[0].buttons?.[0][0].label).toBe('✅ Guardar')
    })

    it('should create one expense draft per expense in the message', async () => {
      mockExtraction.extract.mockResolvedValue({
        expenses: [buildResolvedExpense(), buildResolvedExpense({ description: 'Taxi', amount: 12 })],
      })

      const { replies } = await service.handle(textMessage('almuerzo 25 y taxi 12'))

      expect(mockExpenseDraftDB.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ itemIndex: 1 }))
      expect(replies).toHaveLength(2)
      expect(replies[1].text).toContain('Taxi')
    })

    it('should ask the first missing field', async () => {
      mockExtraction.extract.mockResolvedValue({
        expenses: [buildResolvedExpense({ categoryId: null, missingFields: [ExpenseField.CATEGORY] })],
      })

      const { replies } = await service.handle(textMessage('almuerzo 25'))

      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith(
        'file-0',
        expect.objectContaining({ status: ExpenseDraftStatus.DRAFT, pendingField: ExpenseField.CATEGORY }),
      )
      expect(replies[0].text).toContain('¿Qué categoría?')
    })

    it('should ignore a webhook retry of a message already received', async () => {
      mockExpenseDraftDB.create.mockRejectedValue(new DuplicateExpenseDraftException())

      const { replies } = await service.handle(textMessage('almuerzo 25'))

      expect(replies).toEqual([])
      expect(mockExtraction.extract).not.toHaveBeenCalled()
    })

    it('should leave the expense draft as failed when no AI can extract it', async () => {
      mockExtraction.extract.mockRejectedValue(new ExpenseExtractionFailedException())

      const { replies } = await service.handle(textMessage('almuerzo 25'))

      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith('file-0', { status: ExpenseDraftStatus.FAILED })
      expect(replies[0].text).toContain('borrador')
    })

    it('should discard messages without expenses', async () => {
      mockExtraction.extract.mockResolvedValue({ expenses: [] })

      const { replies } = await service.handle(textMessage('hola'))

      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith('file-0', { status: ExpenseDraftStatus.DISCARDED })
      expect(replies[0].text).toContain('No encontré un gasto')
    })
  })

  describe('images', () => {
    const imageMessage = (overrides: Partial<ChannelMessage> = {}): ChannelMessage => ({
      channel: ExpenseDraftChannel.TELEGRAM,
      chatId: CHAT_ID,
      messageId: '77',
      type: ChannelMessageType.IMAGE,
      media: { fileId: 'file-1', uniqueId: 'unique-1', sizeBytes: 150_000 },
      text: 'persona dany',
      ...overrides,
    })

    it('should download the image and send it to the AI with its caption', async () => {
      mockMediaDownloader.download.mockResolvedValue({ mimeType: 'image/jpeg', data: 'base64' })
      mockExtraction.extract.mockResolvedValue({ expenses: [buildResolvedExpense()] })

      const { replies } = await service.handle(imageMessage())

      expect(mockExpenseDraftDB.create).toHaveBeenCalledWith(
        expect.objectContaining({
          inputType: 'image',
          mediaFileId: 'file-1',
          mediaUniqueId: 'unique-1',
          rawText: 'persona dany',
        }),
      )
      expect(mockMediaDownloader.download).toHaveBeenCalledWith(ExpenseDraftChannel.TELEGRAM, 'file-1')
      expect(mockExtraction.extract).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'persona dany', images: [{ mimeType: 'image/jpeg', data: 'base64' }] }),
      )
      expect(replies).toHaveLength(1)
    })

    it('should use the expenses a local template read, without calling the AI (D63)', async () => {
      mockMediaDownloader.download.mockResolvedValue({ mimeType: 'image/jpeg', data: 'base64' })
      const recognized = { screen: RecognizedScreen.BANK_MOVEMENT, expenses: [{ merchant: 'Plin-Rosa' }] }
      mockRecognition.recognize.mockResolvedValue(recognized)
      mockRecognition.toExpenses.mockReturnValue([buildResolvedExpense({ description: 'Plin a Rosa' })])

      const { replies } = await service.handle(imageMessage())

      expect(mockRecognition.recognize).toHaveBeenCalledWith({ mimeType: 'image/jpeg', data: 'base64' }, 'file-0')
      expect(mockRecognition.toExpenses).toHaveBeenCalledWith(recognized.expenses, mockCatalog)
      expect(mockExtraction.extract).not.toHaveBeenCalled()
      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith(
        'file-0',
        expect.objectContaining({ description: 'Plin a Rosa', documentType: RecognizedScreen.BANK_MOVEMENT }),
      )
      expect(replies[0].text).toContain('Plin a Rosa')
    })

    it('should answer the IO summary by category with how the month adds up, without an expense', async () => {
      mockMediaDownloader.download.mockResolvedValue({ mimeType: 'image/jpeg', data: 'base64' })
      mockRecognition.recognize.mockResolvedValue({
        screen: RecognizedScreen.IO_CATEGORY_SUMMARY,
        month: 9,
        total: 3000.5,
        categories: [{ name: 'DELIVERY', amount: 300.25, count: 14 }],
      })
      mockRecognition.reconcile.mockResolvedValue({
        card: 'IO',
        month: 9,
        year: 2026,
        appTotal: 3000.5,
        registered: 2800.5,
        categories: [{ name: 'DELIVERY', amount: 300.25, count: 14 }],
      })

      const { replies } = await service.handle(imageMessage())

      expect(mockExtraction.extract).not.toHaveBeenCalled()
      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith('file-0', {
        status: ExpenseDraftStatus.DISCARDED,
        documentType: RecognizedScreen.IO_CATEGORY_SUMMARY,
      })
      expect(replies[0].text).toContain('IO · setiembre 2026')
      expect(replies[0].text).toContain('Faltan S/ 200.00')
      expect(replies[0].text).toContain('DELIVERY: S/ 300.25 (14)')
    })

    it('should give a card expense of a screenshot without a card to the primary card (D47)', async () => {
      const catalog = buildExtractionCatalog({
        ...mockCatalogSource,
        paymentMethods: mockCatalogSource.paymentMethods.map((method) =>
          method.id === 'method-ohpay' ? { ...method, isPrimary: true } : method,
        ),
      })
      mockExtraction.loadCatalog.mockResolvedValue(catalog)
      mockMediaDownloader.download.mockResolvedValue({ mimeType: 'image/jpeg', data: 'base64' })
      mockExtraction.extract.mockResolvedValue({
        expenses: [
          completeExpense(
            { ...buildResolvedExpense({ destination: ExpenseDestination.CREDIT_CARD, paymentMethodId: null }) },
            {},
            catalog,
          ),
        ],
      })

      await service.handle(imageMessage())

      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith(
        'file-0',
        expect.objectContaining({ paymentMethodId: 'method-ohpay', destination: ExpenseDestination.CREDIT_CARD }),
      )
    })

    it('should warn about the same card, day, amount and merchant of an overlapping screenshot', async () => {
      mockMediaDownloader.download.mockResolvedValue({ mimeType: 'image/jpeg', data: 'base64' })
      mockExtraction.extract.mockResolvedValue({
        expenses: [buildResolvedExpense({ merchant: 'PEDIDOSYA FO...', amount: 30.9, operationNumber: null })],
      })
      mockExpenseDraftDB.findSameCardDayAmount.mockResolvedValue([
        { id: 'older', description: 'Delivery', merchant: 'PEDIDOSYA FOOD' },
      ])

      const { replies } = await service.handle(imageMessage())

      const [query, since] = mockExpenseDraftDB.findSameCardDayAmount.mock.calls[0]
      expect(query).toMatchObject({ id: 'file-0', paymentMethodId: 'method-yape', amount: 30.9 })
      expect(Date.now() - since.getTime()).toBeCloseTo(60 * 24 * 60 * 60_000, -5)
      expect(replies[0].text).toContain(
        '⚠️ Parece repetido: ya hay <b>PEDIDOSYA FOOD</b> de S/ 30.90 con esa tarjeta el 22/09/2026.',
      )
    })

    it('should not warn when the same amount that day is another merchant', async () => {
      mockMediaDownloader.download.mockResolvedValue({ mimeType: 'image/jpeg', data: 'base64' })
      mockExtraction.extract.mockResolvedValue({ expenses: [buildResolvedExpense({ merchant: 'YANGO' })] })
      mockExpenseDraftDB.findSameCardDayAmount.mockResolvedValue([
        { id: 'older', description: 'Uber', merchant: 'UBER' },
      ])

      const { replies } = await service.handle(imageMessage())

      expect(replies[0].text).not.toContain('Parece repetido')
    })

    it('should not read the same image twice', async () => {
      mockExpenseDraftDB.findByMediaUniqueId.mockResolvedValue(buildExpenseDraft())

      const { replies } = await service.handle(imageMessage())

      expect(replies[0].text).toContain('Ya recibí esta imagen')
      expect(mockExpenseDraftDB.create).not.toHaveBeenCalled()
      expect(mockMediaDownloader.download).not.toHaveBeenCalled()
    })

    it('should reject an image file that is too large before downloading it', async () => {
      const { replies } = await service.handle(
        imageMessage({ media: { fileId: 'f', uniqueId: 'u', sizeBytes: 30_000_000 } }),
      )

      expect(replies[0].text).toContain('pesa demasiado')
      expect(mockMediaDownloader.download).not.toHaveBeenCalled()
    })

    it('should leave the image in /borrador as failed when it cannot be downloaded', async () => {
      mockMediaDownloader.download.mockRejectedValue(new Error('telegram down'))

      const { replies } = await service.handle(imageMessage())

      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith('file-0', { status: ExpenseDraftStatus.FAILED })
      expect(replies[0].text).toContain('/borrador')
      expect(mockExtraction.extract).not.toHaveBeenCalled()
    })

    it('should warn when a receipt with the same operation number was already saved', async () => {
      mockMediaDownloader.download.mockResolvedValue({ mimeType: 'image/jpeg', data: 'base64' })
      mockExtraction.extract.mockResolvedValue({ expenses: [buildResolvedExpense({ operationNumber: '12345678' })] })
      mockExpenseDraftDB.existsSavedWithOperationNumber.mockResolvedValue(true)

      const { replies } = await service.handle(imageMessage())

      expect(mockExpenseDraftDB.existsSavedWithOperationNumber).toHaveBeenCalledWith('12345678', 'file-0')
      expect(replies[0].text).toContain('Parece que ya registraste este gasto')
    })
  })

  // D58: the bytes live in R2 (bot_files); the draft only keeps fileId
  describe('stored files', () => {
    const imageMessage = (overrides: Partial<ChannelMessage> = {}): ChannelMessage => ({
      channel: ExpenseDraftChannel.TELEGRAM,
      chatId: CHAT_ID,
      messageId: '77',
      type: ChannelMessageType.IMAGE,
      media: { fileId: 'file-1', uniqueId: 'unique-1', sizeBytes: 150_000 },
      ...overrides,
    })

    beforeEach(() => {
      mockMediaDownloader.download.mockResolvedValue({ mimeType: 'image/jpeg', data: 'aW1hZ2U=' })
      mockExtraction.extract.mockResolvedValue({ expenses: [buildResolvedExpense()] })
    })

    it('should keep a Telegram image as a temporary file the first time it is downloaded', async () => {
      await service.handle(imageMessage())

      expect(mockExpenseDraftDB.create).toHaveBeenCalledWith(expect.objectContaining({ fileId: null }))
      expect(mockStoredFiles.storeTemporary).toHaveBeenCalledWith(
        ExpenseDraftChannel.TELEGRAM,
        Buffer.from('aW1hZ2U=', 'base64'),
        'image/jpeg',
      )
      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith('file-0', { fileId: 'stored-1' })
      expect(mockExtraction.extract).toHaveBeenCalledWith(
        expect.objectContaining({ images: [{ mimeType: 'image/jpeg', data: 'aW1hZ2U=' }] }),
      )
    })

    it('should read a web upload from storage instead of the channel', async () => {
      mockStoredFiles.download.mockResolvedValue({ mimeType: 'image/png', data: 'cG5n' })

      await service.handle(
        imageMessage({
          channel: ExpenseDraftChannel.WEB,
          media: { fileId: 'stored-9', uniqueId: 'sha-9', storedFileId: 'stored-9' },
        }),
      )

      expect(mockExpenseDraftDB.create).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'stored-9' }))
      expect(mockStoredFiles.download).toHaveBeenCalledWith('stored-9')
      expect(mockMediaDownloader.download).not.toHaveBeenCalled()
      expect(mockStoredFiles.storeTemporary).not.toHaveBeenCalled()
      expect(mockExtraction.extract).toHaveBeenCalledWith(
        expect.objectContaining({ images: [{ mimeType: 'image/png', data: 'cG5n' }] }),
      )
    })

    it('should go on with the extraction when the file cannot be stored', async () => {
      mockStoredFiles.storeTemporary.mockRejectedValue(new Error('R2 down'))

      const { replies } = await service.handle(imageMessage())

      expect(mockExpenseDraftDB.update).not.toHaveBeenCalledWith(
        'file-0',
        expect.objectContaining({ fileId: expect.anything() }),
      )
      expect(mockExtraction.extract).toHaveBeenCalled()
      expect(replies[0].buttons).toBeDefined()
    })

    it('should share the file with every expense read from the same screenshot', async () => {
      mockExtraction.extract.mockResolvedValue({
        expenses: [buildResolvedExpense(), buildResolvedExpense({ description: 'Pasaje', amount: 5 })],
      })

      const { replies } = await service.handle(imageMessage())

      expect(replies).toHaveLength(2)
      expect(mockExpenseDraftDB.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ itemIndex: 1, mediaFileId: 'file-1', fileId: 'stored-1' }),
      )
    })

    it('should fail the draft and ask for the screenshot again when its file expired', async () => {
      mockStoredFiles.download.mockRejectedValue(new StoredFileExpiredException({ fileId: 'stored-old' }))

      const { replies } = await service.handle(
        imageMessage({ media: { fileId: 'stored-old', uniqueId: 'sha-old', storedFileId: 'stored-old' } }),
      )

      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith('file-0', { status: ExpenseDraftStatus.FAILED })
      expect(replies[0].text).toContain('La captura ya expiró')
      expect(mockExtraction.extract).not.toHaveBeenCalled()
    })

    it('should transcribe a voice note from its stored file on a retry', async () => {
      mockStoredFiles.download.mockResolvedValue({ mimeType: 'audio/ogg', data: 'b2dn' })
      mockExtraction.transcribe.mockResolvedValue('cafe 8 con plin')

      await service.retryExtraction(
        buildExpenseDraft({
          id: 'draft-voice',
          inputType: 'audio',
          rawText: null,
          mediaFileId: 'voice-1',
          fileId: 'stored-voice',
          status: ExpenseDraftStatus.FAILED,
        }),
      )

      expect(mockStoredFiles.download).toHaveBeenCalledWith('stored-voice')
      expect(mockMediaDownloader.download).not.toHaveBeenCalled()
      expect(mockExtraction.transcribe).toHaveBeenCalledWith({
        audio: { mimeType: 'audio/ogg', data: 'b2dn' },
        draftId: 'draft-voice',
      })
    })
  })

  describe('voice notes', () => {
    const voiceMessage = (durationSeconds = 6): ChannelMessage => ({
      channel: ExpenseDraftChannel.TELEGRAM,
      chatId: CHAT_ID,
      messageId: '88',
      type: ChannelMessageType.AUDIO,
      media: { fileId: 'voice-1', uniqueId: 'voice-unique-1', durationSeconds },
    })

    beforeEach(() => {
      mockMediaDownloader.download.mockResolvedValue({ mimeType: 'audio/ogg', data: 'ogg-b64' })
    })

    it('should transcribe the voice note, keep the text and read it like a typed message', async () => {
      mockExtraction.transcribe.mockResolvedValue('almuerzo 25 soles con yape')
      mockExtraction.extract.mockResolvedValue({ expenses: [buildResolvedExpense()] })

      const { replies } = await service.handle(voiceMessage())

      expect(mockExpenseDraftDB.create).toHaveBeenCalledWith(
        expect.objectContaining({ inputType: 'audio', rawText: null, mediaUniqueId: 'voice-unique-1' }),
      )
      expect(mockExtraction.transcribe).toHaveBeenCalledWith({
        audio: { mimeType: 'audio/ogg', data: 'ogg-b64' },
        draftId: 'file-0',
      })
      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith('file-0', { rawText: 'almuerzo 25 soles con yape' })
      expect(mockExtraction.extract).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'almuerzo 25 soles con yape' }),
      )
      expect(mockExtraction.extract.mock.calls[0][0]).not.toHaveProperty('images')
      expect(replies[0].text).toContain('Entendí: <i>«almuerzo 25 soles con yape»</i>')
    })

    it('should reject a voice note longer than a minute before downloading it', async () => {
      const { replies } = await service.handle(voiceMessage(95))

      expect(replies[0].text).toContain('hasta 60 segundos')
      expect(mockMediaDownloader.download).not.toHaveBeenCalled()
    })

    it('should discard a voice note without words', async () => {
      mockExtraction.transcribe.mockResolvedValue('')

      const { replies } = await service.handle(voiceMessage())

      expect(replies[0].text).toContain('No entendí el audio')
      expect(mockExtraction.extract).not.toHaveBeenCalled()
    })

    it('should leave it in /borrador as failed when Whisper fails', async () => {
      mockExtraction.transcribe.mockRejectedValue(new Error('429'))

      const { replies } = await service.handle(voiceMessage())

      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith('file-0', { status: ExpenseDraftStatus.FAILED })
      expect(replies[0].text).toContain('/borrador')
    })

    it('should not transcribe again when a failed voice note already has its text', async () => {
      const failed = buildExpenseDraft({
        status: ExpenseDraftStatus.FAILED,
        inputType: 'audio',
        mediaFileId: 'voice-1',
        rawText: 'cafe 8 con plin',
      })
      mockExpenseDraftDB.findById.mockResolvedValue(failed)
      mockExtraction.extract.mockResolvedValue({ expenses: [buildResolvedExpense()] })

      await service.handle(action(BotAction.RESUME))

      expect(mockExtraction.transcribe).not.toHaveBeenCalled()
      expect(mockExtraction.extract).toHaveBeenCalledWith(expect.objectContaining({ text: 'cafe 8 con plin' }))
    })
  })

  describe('open draft', () => {
    it('should move stale drafts to Borrador before looking for the active one', async () => {
      mockExtraction.extract.mockResolvedValue({ expenses: [buildResolvedExpense()] })

      await service.handle(textMessage('almuerzo 25'))

      const cutoff = mockExpenseDraftDB.moveStaleOpenToReview.mock.calls[0][2] as Date
      expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(30 * 60_000 - 1000)
      expect(mockExpenseDraftDB.findOpenByChat).toHaveBeenCalledWith(ExpenseDraftChannel.TELEGRAM, CHAT_ID, cutoff)
    })

    it('should send stale drafts the AI never finished to /borrador as failed before moving the rest to Borrador', async () => {
      mockExtraction.extract.mockResolvedValue({ expenses: [buildResolvedExpense()] })

      await service.handle(textMessage('almuerzo 25'))

      const cutoff = mockExpenseDraftDB.moveStaleOpenToReview.mock.calls[0][2] as Date
      expect(mockExpenseDraftDB.failInterruptedUpdatedBefore).toHaveBeenCalledWith(
        ExpenseDraftChannel.TELEGRAM,
        cutoff,
        CHAT_ID,
      )
      expect(mockExpenseDraftDB.failInterruptedUpdatedBefore.mock.invocationCallOrder[0]).toBeLessThan(
        mockExpenseDraftDB.moveStaleOpenToReview.mock.invocationCallOrder[0],
      )
    })

    it('should apply a local correction without calling the AI and trust the corrected field', async () => {
      mockExpenseDraftDB.findOpenByChat.mockResolvedValue(buildExpenseDraft({ confidence: { amount: 0.3 } }))
      mockExtraction.parseLocalCorrection.mockResolvedValue({ amount: 30 })

      const { replies } = await service.handle(textMessage('monto 30'))

      expect(mockExtraction.parseLocalCorrection).toHaveBeenCalledWith('monto 30', null)
      expect(mockExtraction.extract).not.toHaveBeenCalled()
      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith(
        FILE_ID,
        expect.objectContaining({ amount: 30, confidence: { amount: 1 } }),
      )
      expect(replies[0].text).toContain('S/ 30.00')
    })

    it('should answer the pending question and move to the next missing field', async () => {
      mockExpenseDraftDB.findOpenByChat.mockResolvedValue(
        buildExpenseDraft({
          status: ExpenseDraftStatus.DRAFT,
          categoryId: null,
          paymentMethodId: null,
          pendingField: ExpenseField.CATEGORY,
          missingFields: [ExpenseField.CATEGORY, ExpenseField.PAYMENT_METHOD],
        }),
      )
      mockExtraction.parseLocalCorrection.mockResolvedValue({ categoryId: 'category-food' })

      await service.handle(textMessage('comida'))

      expect(mockExtraction.parseLocalCorrection).toHaveBeenCalledWith('comida', ExpenseField.CATEGORY)
      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith(
        FILE_ID,
        expect.objectContaining({
          categoryId: 'category-food',
          status: ExpenseDraftStatus.DRAFT,
          pendingField: ExpenseField.PAYMENT_METHOD,
        }),
      )
    })

    it('should treat a message that is not a correction as a new expense', async () => {
      mockExpenseDraftDB.findOpenByChat.mockResolvedValue(buildExpenseDraft())
      mockExtraction.parseLocalCorrection.mockResolvedValue(null)
      mockExtraction.extract.mockResolvedValue({ expenses: [buildResolvedExpense({ description: 'Taxi' })] })

      const { replies } = await service.handle(textMessage('taxi 15 soles'))

      expect(mockExpenseDraftDB.create).toHaveBeenCalled()
      expect(replies[0].text).toContain('Taxi')
    })

    it('should send the message to the AI with the draft after ✏️ Corregir', async () => {
      const draft = buildExpenseDraft({ pendingField: FREE_CORRECTION_FIELD })
      mockExpenseDraftDB.findOpenByChat.mockResolvedValue(draft)
      mockExtraction.extract.mockResolvedValue({ expenses: [buildResolvedExpense({ amount: 30 })] })

      await service.handle(textMessage('eran 30 y fue con la oh'))

      expect(mockExtraction.parseLocalCorrection).not.toHaveBeenCalled()
      expect(mockExtraction.extract).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'eran 30 y fue con la oh',
          draftId: FILE_ID,
          draft: expect.any(Object),
        }),
      )
      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith(
        FILE_ID,
        expect.objectContaining({ amount: 30, pendingField: null }),
      )
    })

    it('should leave correction mode when the AI correction fails', async () => {
      mockExpenseDraftDB.findOpenByChat.mockResolvedValue(buildExpenseDraft({ pendingField: FREE_CORRECTION_FIELD }))
      mockExtraction.extract.mockRejectedValue(new ExpenseExtractionFailedException())

      const { replies } = await service.handle(textMessage('cambia todo'))

      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith(FILE_ID, { pendingField: null })
      expect(replies[0].text).toContain('No pude aplicar la corrección')
    })
  })

  describe('buttons', () => {
    beforeEach(() => {
      mockExpenseDraftDB.findById.mockResolvedValue(buildExpenseDraft())
    })

    it('should save the expense and close the summary', async () => {
      const result = await service.handle(action(BotAction.SAVE))

      expect(mockSaver.save).toHaveBeenCalledWith(expect.objectContaining({ id: FILE_ID }))
      expect(result.notice).toBe('Guardado')
      expect(result.replies[0]).toMatchObject({ edit: true, text: expect.stringContaining('Guardado en Costo fijo') })
      expect(result.replies[0].buttons).toBeUndefined()
      // and a new message at the end of the chat, which does notify
      // "Ver: /ultimos · /resumen" becomes buttons, after ↩️ Deshacer (P18)
      expect(result.replies[1]).toEqual({
        text: '✅ Guardado: Almuerzo S/ 25.00 en Costo fijo.',
        buttons: [
          [{ label: '↩️ Deshacer', data: `und:${FILE_ID}` }],
          [
            { label: '🧾 Últimos', data: 'cmd:ultimos' },
            { label: '📊 Resumen', data: 'cmd:resumen' },
          ],
        ],
      })
    })

    it('should ask the missing field instead of saving an incomplete expense', async () => {
      mockExpenseDraftDB.findById.mockResolvedValue(
        buildExpenseDraft({
          status: ExpenseDraftStatus.DRAFT,
          pendingField: ExpenseField.CATEGORY,
          missingFields: [ExpenseField.CATEGORY],
        }),
      )

      const result = await service.handle(action(BotAction.SAVE))

      expect(mockSaver.save).not.toHaveBeenCalled()
      expect(result.replies[0].text).toContain('¿Qué categoría?')
    })

    it('should enter correction mode with ✏️', async () => {
      const result = await service.handle(action(BotAction.EDIT))

      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith(FILE_ID, { pendingField: FREE_CORRECTION_FIELD })
      expect(result.replies[0].text).toContain('Escribe la corrección')
    })

    it.each([
      [BotAction.LATER, ExpenseDraftStatus.PENDING_REVIEW, 'En borrador', 2],
      [BotAction.DISCARD, ExpenseDraftStatus.DISCARDED, 'Descartado', 1],
    ])('%s should close the expense as %s', async (name, status, text, replies) => {
      const result = await service.handle(action(name))

      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith(FILE_ID, { status, pendingField: null })
      expect(result.replies[0]).toMatchObject({ edit: true, text: expect.stringContaining(text) })
      expect(result.replies).toHaveLength(replies)
    })

    it('should send a new message when an expense goes to Borrador', async () => {
      const { replies } = await service.handle(action(BotAction.LATER))

      expect(replies[1]).toEqual({
        text: '📝 Quedó en /borrador: Almuerzo S/ 25.00. Retómalo cuando quieras.',
        buttons: [[{ label: '📝 Borrador', data: 'cmd:borrador' }]],
      })
    })

    it('should set a field from a quick reply and edit the same message', async () => {
      mockExpenseDraftDB.findById.mockResolvedValue(
        buildExpenseDraft({
          status: ExpenseDraftStatus.DRAFT,
          paymentMethodId: null,
          destination: null,
          pendingField: ExpenseField.PAYMENT_METHOD,
          missingFields: [ExpenseField.DESTINATION, ExpenseField.PAYMENT_METHOD],
        }),
      )

      const result = await service.handle(action(BotAction.SET_FIELD, ExpenseField.PAYMENT_METHOD, 'method-ohpay'))

      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith(
        FILE_ID,
        expect.objectContaining({
          paymentMethodId: 'method-ohpay',
          destination: ExpenseDestination.CREDIT_CARD,
          status: ExpenseDraftStatus.AWAITING_CONFIRMATION,
        }),
      )
      expect(result.replies[0].edit).toBe(true)
    })

    it('should reject quick replies with values that no longer exist', async () => {
      const result = await service.handle(action(BotAction.SET_FIELD, ExpenseField.CATEGORY, 'category-gone'))

      expect(mockExpenseDraftDB.update).not.toHaveBeenCalled()
      expect(result.notice).toBe('Este gasto ya fue procesado')
    })

    it.each([
      ['already saved', buildExpenseDraft({ status: ExpenseDraftStatus.SAVED })],
      ['from another chat', buildExpenseDraft({ chatId: '999' })],
      ['missing', null],
    ])('should ignore buttons of an expense %s', async (_case, expenseDraft) => {
      mockExpenseDraftDB.findById.mockResolvedValue(expenseDraft)

      const result = await service.handle(action(BotAction.SAVE))

      expect(mockSaver.save).not.toHaveBeenCalled()
      expect(result).toEqual({ replies: [], notice: 'Este gasto ya fue procesado' })
    })
  })

  describe('the tools of the menu groups (P18)', () => {
    it('should save a ⚡ quick expense at once, dated today, and offer to undo it', async () => {
      const source = buildExpenseDraft({ description: 'Café', amount: 8 })
      mockBotTools.quickExpense.mockResolvedValue(source)
      mockExpenseDraftDB.createQuickCopy.mockResolvedValue({ ...source, id: 'copy-1' })

      const result = await service.handle({
        ...action(BotAction.QUICK),
        action: { name: BotAction.QUICK, draftId: 'abc123' },
      })

      expect(mockBotTools.quickExpense).toHaveBeenCalledWith('abc123')
      expect(mockExpenseDraftDB.createQuickCopy).toHaveBeenCalledWith(
        source,
        { channel: ExpenseDraftChannel.TELEGRAM, chatId: CHAT_ID, messageId: expect.stringMatching(/^quick:/) },
        expect.any(Date),
      )
      expect(mockSaver.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'copy-1' }))
      expect(result.replies[0].text).toContain('⚡ Guardado')
      expect(result.replies[0].buttons).toEqual([[{ label: '↩️ Deshacer', data: 'und:copy-1' }]])
      expect(mockExpenseDraftDB.update).not.toHaveBeenCalled()
    })

    it('should say a ⚡ button is old when the expense is no longer repeated, and save nothing', async () => {
      mockBotTools.quickExpense.mockResolvedValue(null)

      const result = await service.handle({
        ...action(BotAction.QUICK),
        action: { name: BotAction.QUICK, draftId: 'old' },
      })

      expect(result.notice).toContain('ya no está')
      expect(mockSaver.save).not.toHaveBeenCalled()
    })

    it('should confirm or cancel /deshacer through its buttons', async () => {
      mockBotTools.undoConfirm.mockResolvedValue({ text: '↩️ Anulé' })
      mockBotTools.undoCancel.mockReturnValue({ text: '👍' })

      expect((await service.handle(action(BotAction.UNDO))).replies[0].text).toBe('↩️ Anulé')
      expect(mockBotTools.undoConfirm).toHaveBeenCalledWith(CHAT_ID, FILE_ID)
      expect((await service.handle(action(BotAction.UNDO_CANCEL))).replies[0].text).toBe('👍')
    })

    it('should remember the category or the method the user chose for that merchant', async () => {
      mockExpenseDraftDB.findById.mockResolvedValue(
        buildExpenseDraft({ status: ExpenseDraftStatus.AWAITING_CONFIRMATION, merchant: 'Bembos' }),
      )

      await service.handle(action(BotAction.SET_FIELD, ExpenseField.PAYMENT_METHOD, 'method-ohpay'))

      expect(mockBotTools.learnRule).toHaveBeenCalledWith(
        expect.objectContaining({ merchant: 'Bembos' }),
        expect.objectContaining({ paymentMethodId: 'method-ohpay' }),
      )
    })

    it('should delete a rule from its 🗑️ button and show what is left', async () => {
      mockBotTools.removeRule.mockResolvedValue({ reply: { text: 'quedan', edit: true }, notice: 'Regla borrada' })

      const result = await service.handle(action(BotAction.RULE_DELETE))

      expect(mockBotTools.removeRule).toHaveBeenCalledWith(FILE_ID)
      expect(result).toEqual({ replies: [{ text: 'quedan', edit: true }], notice: 'Regla borrada' })
    })

    it('should send the file of the 📥 buttons of /exportar, and say so when the button is not valid', async () => {
      mockBotTools.exportFile.mockResolvedValueOnce({ text: '📎 gastos.xlsx' }).mockResolvedValueOnce(null)

      const sent = await service.handle(action(BotAction.EXPORT))
      const invalid = await service.handle(action(BotAction.EXPORT))

      expect(sent.replies[0].text).toBe('📎 gastos.xlsx')
      expect(invalid).toEqual({ replies: [], notice: 'Este gasto ya fue procesado' })
    })

    it('should run the command of a key of the fixed keyboard', async () => {
      mockBotTools.handleCommand.mockResolvedValueOnce([{ text: '⚡ Rápido' }])

      const { replies } = await service.handle({
        ...command(BotCommand.START),
        type: ChannelMessageType.TEXT,
        text: '⚡ Rápido',
      })

      expect(mockBotTools.handleCommand).toHaveBeenCalledWith(expect.objectContaining({ command: 'rapido' }))
      expect(replies[0].text).toBe('⚡ Rápido')
    })
  })

  describe('commands', () => {
    it('should hand the groups of the menu and their commands over to the tools, and show the help for unknown ones', async () => {
      mockBotTools.handleCommand.mockResolvedValueOnce([{ text: '📊 Consultar' }])

      const { replies } = await service.handle(command(BotCommand.QUERY))
      const [unknown] = (await service.handle({ ...command(BotCommand.START), command: 'foo' })).replies

      expect(mockBotTools.handleCommand).toHaveBeenCalledWith(expect.objectContaining({ command: 'consultar' }))
      expect(replies[0].text).toBe('📊 Consultar')
      expect(unknown.text).toContain('Escríbeme tus gastos')
      expect(mockBotTools.clearAwaiting).toHaveBeenCalledWith(CHAT_ID)
    })

    it('should take the text of a command that was waiting for it (a button of a group) as its argument', async () => {
      mockBotTools.takeAwaiting.mockReturnValueOnce(BotCommand.SEARCH)
      mockExpenseDraftDB.searchSaved.mockResolvedValue([])

      const { replies } = await service.handle({
        ...command(BotCommand.START),
        type: ChannelMessageType.TEXT,
        text: 'netflix',
      })

      expect(mockExpenseDraftDB.searchSaved).toHaveBeenCalled()
      expect(replies[0].text).toContain('No encontré gastos guardados con «netflix»')
    })

    it('should ask what to search when /buscar or /editar comes without text, and wait for it', async () => {
      const { replies } = await service.handle({ ...command(BotCommand.SEARCH), text: '/buscar' })

      expect(replies[0].text).toContain('Dime qué gasto buscar')
      expect(mockBotTools.await).toHaveBeenCalledWith(CHAT_ID, BotCommand.SEARCH)
    })

    it('should discard the open draft with /cancelar', async () => {
      mockExpenseDraftDB.discardOpenByChat.mockResolvedValue(1)

      const { replies } = await service.handle(command(BotCommand.CANCEL))

      expect(mockExpenseDraftDB.discardOpenByChat).toHaveBeenCalledWith(ExpenseDraftChannel.TELEGRAM, CHAT_ID)
      expect(replies[0].text).toContain('Descarté el borrador')
    })

    it('should list the last saved expenses with /ultimos', async () => {
      mockExpenseDraftDB.findRecentSaved.mockResolvedValue([buildExpenseDraft()])

      const { replies } = await service.handle(command(BotCommand.RECENT))

      expect(mockExpenseDraftDB.findRecentSaved).toHaveBeenCalledWith(ExpenseDraftChannel.TELEGRAM, CHAT_ID, 5)
      expect(replies[0].text).toContain('Almuerzo')
    })

    it('should total the current month with /resumen', async () => {
      mockExpenseDB.findMonthlyTotals.mockResolvedValue([])

      const { replies } = await service.handle(command(BotCommand.SUMMARY))

      expect(mockExpenseDB.findMonthlyTotals).toHaveBeenCalledWith(expect.any(Number), expect.any(Number))
      expect(replies[0].text).toBe('No hay gastos registrados este mes.')
    })

    it('should total any month with /resumen agosto 2026, and explain the format when it is not one', async () => {
      mockExpenseDB.findMonthlyTotals.mockResolvedValue([])

      await service.handle({ ...command(BotCommand.SUMMARY), text: '/resumen agosto 2026' })
      const { replies } = await service.handle({ ...command(BotCommand.SUMMARY), text: '/resumen hola' })

      expect(mockExpenseDB.findMonthlyTotals).toHaveBeenCalledWith(8, 2026)
      expect(mockExpenseDB.findMonthlyTotals).toHaveBeenCalledTimes(1)
      expect(replies[0].text).toContain('/resumen agosto')
    })
  })

  describe('lists of screenshots (P21)', () => {
    const BATCH_ID = '0b6f5a1e-7c4d-4f7e-9a51-3d2f0c8e1b27'
    const listed = [
      buildExpenseDraft({ id: 'draft-a', batchId: BATCH_ID, description: 'Tienda', amount: 120, installment: '1/10' }),
      buildExpenseDraft({
        id: 'draft-b',
        batchId: BATCH_ID,
        description: 'Delivery',
        amount: 30.9,
        missingFields: ['categoryId'],
      }),
      buildExpenseDraft({ id: 'draft-c', batchId: BATCH_ID, description: 'Taxi', amount: 12, operationNumber: '555' }),
    ]
    const batchAction = (name: BotAction): ChannelMessage => ({
      channel: ExpenseDraftChannel.TELEGRAM,
      chatId: CHAT_ID,
      messageId: 'callback:9',
      type: ChannelMessageType.ACTION,
      action: { name, draftId: BATCH_ID },
    })

    beforeEach(() => {
      // draft-c is a receipt already saved
      mockExpenseDraftDB.existsSavedWithOperationNumber.mockImplementation(
        async (operationNumber) => operationNumber === '555',
      )
    })

    it('should read each photo of an album as its own draft and answer with one list', async () => {
      mockMediaDownloader.download.mockResolvedValue({ mimeType: 'image/jpeg', data: 'base64' })
      mockExtraction.extract.mockResolvedValue({ expenses: [buildResolvedExpense()] })
      mockExpenseDraftDB.findOpenByBatch.mockResolvedValue(listed)

      const { replies } = await service.handle({
        channel: ExpenseDraftChannel.TELEGRAM,
        chatId: CHAT_ID,
        messageId: '40',
        type: ChannelMessageType.IMAGE,
        media: { fileId: 'file-a', uniqueId: 'unique-a' },
        album: [
          { messageId: '40', media: { fileId: 'file-a', uniqueId: 'unique-a' } },
          { messageId: '41', media: { fileId: 'file-b', uniqueId: 'unique-b' }, text: 'io' },
        ],
      })

      const created = mockExpenseDraftDB.create.mock.calls.map(([data]) => data)
      expect(created.map((data) => [data.messageId, data.mediaUniqueId, data.rawText])).toEqual([
        ['40', 'unique-a', null],
        ['41', 'unique-b', 'io'],
      ])
      expect(created[0].batchId).toBeTruthy()
      expect(created[1].batchId).toBe(created[0].batchId)
      expect(mockExpenseDraftDB.findOpenByBatch).toHaveBeenCalledWith(CHAT_ID, created[0].batchId)

      expect(replies).toHaveLength(1)
      expect(replies[0].text).toContain('📋 <b>3 gastos</b> · total S/ 162.90')
      expect(replies[0].text).toContain('1. 22/09 · <b>Tienda</b> · S/ 120.00 · cuota 1/10 · Yape')
      expect(replies[0].text).toContain('❓ falta categoría')
      expect(replies[0].text).toContain('<b>Taxi</b> · S/ 12.00 · Yape ⚠️ repetido')
      expect(replies[0].buttons?.flat().map((button) => button.data)).toEqual([
        `all:${created[0].batchId}`,
        `each:${created[0].batchId}`,
        `park:${created[0].batchId}`,
      ])
    })

    it('should keep the summary of a single expense when the list has only one', async () => {
      mockMediaDownloader.download.mockResolvedValue({ mimeType: 'image/jpeg', data: 'base64' })
      mockExtraction.extract.mockResolvedValue({ expenses: [buildResolvedExpense()] })
      mockExpenseDraftDB.findOpenByBatch.mockResolvedValue([listed[0]])

      const { replies } = await service.handle({
        channel: ExpenseDraftChannel.TELEGRAM,
        chatId: CHAT_ID,
        messageId: '42',
        type: ChannelMessageType.IMAGE,
        media: { fileId: 'file-a', uniqueId: 'unique-a' },
      })

      expect(replies[0].buttons?.flat().map((button) => button.label)).toContain('✅ Guardar')
    })

    it('should save the complete ones with Guardar todos and leave the repeated and incomplete in Borrador', async () => {
      mockExpenseDraftDB.findOpenByBatch.mockResolvedValue(listed)

      const { replies } = await service.handle(batchAction(BotAction.SAVE_ALL))

      expect(mockSaver.save).toHaveBeenCalledTimes(1)
      expect(mockSaver.save).toHaveBeenCalledWith(listed[0])
      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith('draft-b', {
        status: ExpenseDraftStatus.PENDING_REVIEW,
        pendingField: null,
      })
      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith('draft-c', {
        status: ExpenseDraftStatus.PENDING_REVIEW,
        pendingField: null,
      })
      expect(replies[0]).toMatchObject({ edit: true })
      expect(replies[1].text).toContain('✅ Guardé 1 gasto.')
      expect(replies[1].text).toContain('📝 2 quedaron en /borrador')
    })

    it('should park an expense whose save fails instead of losing the rest', async () => {
      mockExpenseDraftDB.findOpenByBatch.mockResolvedValue([listed[0]])
      mockSaver.save.mockRejectedValueOnce(new Error('db down'))

      const { replies } = await service.handle(batchAction(BotAction.SAVE_ALL))

      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith(
        'draft-a',
        expect.objectContaining({ status: 'pending_review' }),
      )
      expect(replies[1].text).toContain('📝 1 quedó en /borrador')
    })

    it('should show each summary with Revisar uno por uno', async () => {
      mockExpenseDraftDB.findOpenByBatch.mockResolvedValue(listed)

      const { replies } = await service.handle(batchAction(BotAction.REVIEW_ALL))

      expect(replies).toHaveLength(4)
      expect(replies[0]).toMatchObject({ text: '👇 Revisa cada uno:', edit: true })
      expect(replies[3].text).toContain('Parece que ya registraste este gasto')
      expect(mockSaver.save).not.toHaveBeenCalled()
    })

    it('should park every expense with Borrador', async () => {
      mockExpenseDraftDB.findOpenByBatch.mockResolvedValue(listed)

      const { replies } = await service.handle(batchAction(BotAction.LATER_ALL))

      expect(mockExpenseDraftDB.update).toHaveBeenCalledTimes(3)
      expect(replies[1].text).toContain('Dejé 3 gastos en /borrador')
    })

    it('should ignore a list already processed or from another chat', async () => {
      const result = await service.handle(batchAction(BotAction.SAVE_ALL))

      expect(result).toEqual({ replies: [], notice: 'Este gasto ya fue procesado' })
    })
  })

  describe('AI usage (/uso)', () => {
    it('should show each model against its usable limit', async () => {
      mockExtraction.getUsage.mockResolvedValue([
        { provider: 'gemini', model: 'gemini-lite', used: 12, dailyLimit: 500, usableLimit: 450 },
        { provider: 'groq', model: 'qwen', used: 900, dailyLimit: 1000, usableLimit: 900 },
      ])

      const { replies } = await service.handle(command(BotCommand.USAGE))

      expect(replies[0].text).toContain('🟢 <b>gemini</b> gemini-lite: 12 de 450')
      expect(replies[0].text).toContain('🔴 <b>groq</b> qwen: 900 de 900')
      expect(replies[0].text).not.toContain('OCR')
    })

    it('should show the screenshots the local OCR read without AI (P21)', async () => {
      mockExtraction.getUsage.mockResolvedValue([])
      mockRecognition.todayStats.mockResolvedValue({ attempts: 5, resolved: 3 })

      const { replies } = await service.handle(command(BotCommand.USAGE))

      expect(replies[0].text).toContain('🔎 <b>OCR local</b>: 3 de 5 capturas sin AI')
    })
  })

  describe('Borrador (/borrador)', () => {
    it('should list every expense pending review', async () => {
      mockExpenseDraftDB.findByStatuses.mockResolvedValue({
        items: [buildExpenseDraft({ status: ExpenseDraftStatus.PENDING_REVIEW })],
        total: 1,
      })

      const { replies } = await service.handle(command(BotCommand.DRAFTS))

      expect(mockExpenseDraftDB.findByStatuses).toHaveBeenCalledWith(
        ExpenseDraftChannel.TELEGRAM,
        CHAT_ID,
        [
          ExpenseDraftStatus.DRAFT,
          ExpenseDraftStatus.AWAITING_CONFIRMATION,
          ExpenseDraftStatus.PENDING_REVIEW,
          ExpenseDraftStatus.FAILED,
        ],
        5,
      )
      expect(replies[0].text).toContain('Borrador')
      expect(replies[1].buttons?.[0][0].label).toBe('↩️ Retomar')
    })

    it('should reopen a pending expense with its confirmation buttons', async () => {
      mockExpenseDraftDB.findById.mockResolvedValue(buildExpenseDraft({ status: ExpenseDraftStatus.PENDING_REVIEW }))

      const result = await service.handle(action(BotAction.RESUME))

      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith(
        FILE_ID,
        expect.objectContaining({ status: ExpenseDraftStatus.AWAITING_CONFIRMATION }),
      )
      expect(result.notice).toBe('Retomado')
      expect(result.replies[0]).toMatchObject({ edit: true })
      expect(result.replies[0].buttons?.[0][0].label).toBe('✅ Guardar')
    })

    it('should retry the AI on a failed expense', async () => {
      mockExpenseDraftDB.findById.mockResolvedValue(
        buildExpenseDraft({ status: ExpenseDraftStatus.FAILED, rawText: 'almuerzo 25 con yape' }),
      )
      mockExtraction.extract.mockResolvedValue({ expenses: [buildResolvedExpense()] })

      const result = await service.handle(action(BotAction.RESUME))

      expect(mockExtraction.extract).toHaveBeenCalledWith({ text: 'almuerzo 25 con yape', draftId: FILE_ID })
      expect(result.replies[0].text).toContain('Almuerzo')
    })

    it('should only accept Retomar and Descartar on pending expenses', async () => {
      mockExpenseDraftDB.findById.mockResolvedValue(buildExpenseDraft({ status: ExpenseDraftStatus.PENDING_REVIEW }))

      const saved = await service.handle(action(BotAction.SAVE))
      const discarded = await service.handle(action(BotAction.DISCARD))

      expect(saved).toEqual({ replies: [], notice: 'Este gasto ya fue procesado' })
      expect(mockSaver.save).not.toHaveBeenCalled()
      expect(discarded.replies[0].text).toContain('Descartado')
    })
  })

  describe('payment methods typed in the chat', () => {
    const askingPayment = () =>
      buildExpenseDraft({
        status: ExpenseDraftStatus.DRAFT,
        destination: ExpenseDestination.DAILY,
        paymentMethodId: null,
        pendingField: ExpenseField.PAYMENT_METHOD,
        missingFields: [ExpenseField.PAYMENT_METHOD],
      })

    it('should offer to add a payment method it does not know', async () => {
      mockExpenseDraftDB.findOpenByChat.mockResolvedValue(askingPayment())
      mockExtraction.parseLocalCorrection.mockResolvedValue(null)

      const { replies } = await service.handle(textMessage('bbva'))

      expect(replies[0].text).toContain('No conozco <b>bbva</b>')
      expect(mockExpenseDraftDB.create).not.toHaveBeenCalled()
    })

    it('should treat an answer with an amount as a new expense', async () => {
      mockExpenseDraftDB.findOpenByChat.mockResolvedValue(askingPayment())
      mockExtraction.parseLocalCorrection.mockResolvedValue(null)
      mockExtraction.extract.mockResolvedValue({ expenses: [buildResolvedExpense({ description: 'Taxi' })] })

      await service.handle(textMessage('taxi 15'))

      expect(mockExpenseDraftDB.create).toHaveBeenCalled()
    })

    it('should create a wallet and use it for the expense', async () => {
      mockExpenseDraftDB.findById.mockResolvedValue(askingPayment())
      mockPaymentMethodDB.create.mockResolvedValue({ id: 'method-yape', name: 'bbva' })

      const result = await service.handle(action(BotAction.NEW_PAYMENT_METHOD, 'wallet', 'bbva'))

      expect(mockPaymentMethodDB.create).toHaveBeenCalledWith('bbva', PaymentMethodType.WALLET)
      expect(result.replies[0]).toMatchObject({ edit: true, text: expect.stringContaining('Agregué <b>bbva</b>') })
      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith(
        FILE_ID,
        expect.objectContaining({ paymentMethodId: 'method-yape' }),
      )
    })

    it('should ask the billing days of a new credit card and save them', async () => {
      mockExpenseDraftDB.findById.mockResolvedValue(askingPayment())
      mockPaymentMethodDB.create.mockResolvedValue({ id: 'method-ohpay', name: 'Ripley' })

      const created = await service.handle(action(BotAction.NEW_PAYMENT_METHOD, 'credit_card', 'Ripley'))

      expect(mockExpenseDraftDB.update).toHaveBeenLastCalledWith(FILE_ID, { pendingField: 'card_days:method-ohpay' })
      expect(created.replies[1].text).toContain('cierra la facturación')

      mockExpenseDraftDB.findOpenByChat.mockResolvedValue(buildExpenseDraft({ pendingField: 'card_days:method-ohpay' }))
      mockPaymentMethodDB.updateBillingDays.mockResolvedValue({ id: 'method-ohpay', name: 'Ripley' })

      const invalid = await service.handle(textMessage('no sé'))
      expect(invalid.replies[0].text).toContain('No entendí los días')

      const { replies } = await service.handle(textMessage('cierre 15, pago 5'))
      expect(mockPaymentMethodDB.updateBillingDays).toHaveBeenCalledWith('method-ohpay', 15, 5)
      expect(replies[0].text).toContain('Guardé los días de <b>Ripley</b>')
    })

    it('should not create anything when the user answers "No"', async () => {
      mockExpenseDraftDB.findById.mockResolvedValue(askingPayment())

      const result = await service.handle(action(BotAction.NEW_PAYMENT_METHOD))

      expect(mockPaymentMethodDB.create).not.toHaveBeenCalled()
      expect(result.replies[0].text).toContain('no lo agregué')
    })
  })
  // P17: loans and debts in the chat
  describe('debts', () => {
    const danery = { id: 'person-danery', name: 'Danery' }
    const debtView = (overrides = {}) => ({
      id: 'debt-aug',
      direction: DebtDirection.OWED_TO_ME,
      description: 'Iphone 16',
      amount: 400,
      currency: 'PEN',
      installment: '2/3',
      paymentMonth: 8,
      paymentYear: 2026,
      paidAmount: 0,
      balance: 400,
      timing: DebtTiming.LATE,
      personId: danery.id,
      person: danery,
      ...overrides,
    })
    const proposal = (overrides = {}) => ({
      batchId: 'batch1',
      personId: danery.id,
      direction: DebtDirection.OWED_TO_ME,
      items: [{ debt: debtView(), amount: 150 }],
      excess: 0,
      ...overrides,
    })
    const payAction = (name: BotAction, value?: string): ChannelMessage => ({
      channel: ExpenseDraftChannel.TELEGRAM,
      chatId: CHAT_ID,
      messageId: 'callback:9',
      type: ChannelMessageType.ACTION,
      action: { name, draftId: 'batch1', value },
    })
    const commandWith = (name: BotCommand, text: string): ChannelMessage => ({ ...command(name), text })

    it('should propose a payment for "dany me pagó 150" without calling the AI', async () => {
      mockDebts.proposePayment.mockResolvedValue(proposal())

      const { replies } = await service.handle(textMessage('dany me pagó 150'))

      expect(mockDebts.proposePayment).toHaveBeenCalledWith(danery.id, DebtDirection.OWED_TO_ME, 150)
      expect(replies[0].text).toContain('Abono de Danery')
      expect(replies[0].text).toContain('Iphone 16 2/3 (ago 2026): S/ 150.00 → saldo S/ 250.00')
      expect(replies[0].buttons?.flat().map((button) => button.data)).toEqual([
        'pay:batch1',
        'payl:batch1',
        'payx:batch1',
      ])
      expect(mockExtraction.extract).not.toHaveBeenCalled()
      expect(mockExpenseDraftDB.create).not.toHaveBeenCalled()
    })

    it('should warn about what exceeds every installment', async () => {
      mockDebts.proposePayment.mockResolvedValue(proposal({ items: [{ debt: debtView(), amount: 400 }], excess: 50 }))

      const { replies } = await service.handle(textMessage('dany me pagó 450'))

      expect(replies[0].text).toContain('pagada ✅')
      expect(replies[0].text).toContain('Sobran S/ 50.00')
    })

    it('should read the text as a new expense when the person owes nothing', async () => {
      mockDebts.proposePayment.mockResolvedValue(null)
      mockExtraction.extract.mockResolvedValue({ expenses: [buildResolvedExpense()] })

      await service.handle(textMessage('le pagué 50 a dany'))

      expect(mockDebts.proposePayment).toHaveBeenCalledWith(danery.id, DebtDirection.I_OWE, 50)
      expect(mockExtraction.extract).toHaveBeenCalled()
    })

    it('should save the payment with ✅ Confirmar and show the new balance', async () => {
      mockDebts.confirmPayment.mockResolvedValue([debtView({ paidAmount: 150, balance: 250 })])

      const result = await service.handle(payAction(BotAction.PAY_CONFIRM))

      expect(mockDebts.confirmPayment).toHaveBeenCalledWith('batch1')
      expect(result.notice).toBe('Guardado')
      expect(result.replies[0]).toMatchObject({ edit: true })
      expect(result.replies[0].text).toContain('Abono guardado')
      expect(result.replies[0].text).toContain('saldo S/ 250.00')
    })

    it('should list the open installments with ✏️ Elegir cuota and move the payment to the one picked', async () => {
      mockDebts.findProposal.mockResolvedValue(proposal())
      mockDebts.findOpen.mockResolvedValue([
        debtView(),
        debtView({ id: 'debt-sep', installment: '3/3', paymentMonth: 9 }),
      ])

      const list = await service.handle(payAction(BotAction.PAY_LIST))

      expect(mockDebts.findOpen).toHaveBeenCalledWith(danery.id, DebtDirection.OWED_TO_ME)
      expect(list.replies[0].buttons?.flat().map((button) => button.data)).toEqual([
        'payp:batch1:debt-aug',
        'payp:batch1:debt-sep',
        'payx:batch1',
      ])

      mockDebts.pickInstallment.mockResolvedValue(
        proposal({ items: [{ debt: debtView({ id: 'debt-sep', installment: '3/3', paymentMonth: 9 }), amount: 150 }] }),
      )
      const picked = await service.handle(payAction(BotAction.PAY_PICK, 'debt-sep'))

      expect(mockDebts.pickInstallment).toHaveBeenCalledWith('batch1', 'debt-sep')
      expect(picked.replies[0].text).toContain('Iphone 16 3/3 (set 2026)')
    })

    it('should cancel a payment and ignore an expired one', async () => {
      const cancelled = await service.handle(payAction(BotAction.PAY_CANCEL))
      expect(mockDebts.cancelPayment).toHaveBeenCalledWith('batch1')
      expect(cancelled.replies[0].text).toContain('Abono cancelado')

      mockDebts.confirmPayment.mockResolvedValue(null)
      const expired = await service.handle(payAction(BotAction.PAY_CONFIRM))
      expect(expired).toEqual({ replies: [], notice: 'Este abono ya no está pendiente. Escríbelo de nuevo.' })
      expect(mockExpenseDraftDB.findById).not.toHaveBeenCalled()
    })

    it('should total everyone with /deudas', async () => {
      mockDebts.summary.mockResolvedValue([
        { personId: danery.id, name: 'Danery', owedToMe: 800, iOwe: 50, net: 750, late: 400, dueThisMonth: 0 },
      ])

      const { replies } = await service.handle(command(BotCommand.DEBTS))

      expect(replies[0].text).toContain('• Danery: te debe S/ 800.00 · le debes S/ 50.00 · ⚠️ S/ 400.00 vencido')
      expect(replies[0].text).toContain('neto S/ 750.00')
    })

    it('should detail one person with /deudas dany', async () => {
      mockDebts.findOpen.mockResolvedValue([debtView({ paidAmount: 100, balance: 300 })])

      const { replies } = await service.handle(commandWith(BotCommand.DEBTS, '/deudas dany'))

      expect(mockDebts.findOpen).toHaveBeenCalledWith(danery.id)
      expect(replies[0].text).toContain('<b>Danery</b>')
      expect(replies[0].text).toContain('• Iphone 16 2/3 · ago 2026 · S/ 300.00 (abonado S/ 100.00) ⚠️ vencida')
    })

    it('should write a message to forward with /cobrar dany', async () => {
      mockDebts.findOpen.mockResolvedValue([
        debtView(),
        debtView({ id: 'debt-sep', installment: '3/3', paymentMonth: 9 }),
      ])

      const { replies } = await service.handle(commandWith(BotCommand.COLLECT, '/cobrar dany'))

      expect(mockDebts.findOpen).toHaveBeenCalledWith(danery.id, DebtDirection.OWED_TO_ME)
      expect(replies[0].text).toContain('Hola Danery 👋')
      expect(replies[0].text).toContain('• Iphone 16 (cuota 3/3), set 2026: S/ 400.00')
      expect(replies[0].text).toContain('<b>Total: S/ 800.00</b>')
      expect(replies[0].buttons).toBeUndefined()
    })

    it('should ask who with /cobrar and say when the person is unknown', async () => {
      expect((await service.handle(command(BotCommand.COLLECT))).replies[0].text).toContain('/cobrar dany')
      expect((await service.handle(commandWith(BotCommand.DEBTS, '/deudas pedro'))).replies[0].text).toContain(
        'No encontré a <b>pedro</b>',
      )
      expect(mockDebts.findOpen).not.toHaveBeenCalled()
    })
  })

  describe('card installments (D66)', () => {
    const deduced = () =>
      buildExpenseDraft({
        destination: ExpenseDestination.CREDIT_CARD,
        paymentMethodId: 'method-ohpay',
        installment: '1/10',
        amount: 164.9,
        confidence: { [ExpenseField.AMOUNT]: 0.4 },
      })

    it('should ask to confirm an installment amount that was only deduced before creating the rows', async () => {
      mockExpenseDraftDB.findById.mockResolvedValue(deduced())

      const { replies } = await service.handle(action(BotAction.SAVE))

      expect(mockSaver.save).not.toHaveBeenCalled()
      expect(replies[0].text).toContain('¿Cuota de S/ 164.90 × 10?')
      expect(replies[0].text).toContain('Total S/ 1649.00')
      expect(replies[0].buttons?.[0].map((button) => button.data)).toEqual([`cuo:${FILE_ID}`, `cuoe:${FILE_ID}`])
    })

    it('should save the n installments once confirmed and say which months were created', async () => {
      mockExpenseDraftDB.findById.mockResolvedValue(deduced())
      mockSaver.save.mockResolvedValue({
        id: 'expense-1',
        installments: {
          total: 10,
          from: { paymentMonth: 10, paymentYear: 2026 },
          to: { paymentMonth: 7, paymentYear: 2027 },
        },
        budget: null,
      })

      mockExpenseDraftDB.update.mockImplementationOnce(async (_id, data) => ({ ...deduced(), ...data }))

      const { replies } = await service.handle(action(BotAction.INSTALLMENTS_OK))

      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith(FILE_ID, {
        confidence: { [ExpenseField.AMOUNT]: 1 },
      })
      expect(mockSaver.save).toHaveBeenCalled()
      expect(replies[0]).toMatchObject({ edit: false, text: expect.stringContaining('Guardado en Tarjeta') })
      expect(replies[1].text).toContain('📆 Cuotas 1/10 a 10/10 (oct 2026 – jul 2027).')
    })

    it('should ask the installment amount with ✏️ Otro monto', async () => {
      mockExpenseDraftDB.findById.mockResolvedValue(deduced())

      const { replies } = await service.handle(action(BotAction.INSTALLMENTS_EDIT))

      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith(FILE_ID, { pendingField: ExpenseField.AMOUNT })
      expect(replies[0]).toEqual({ text: expect.stringContaining('¿Cuánto es cada cuota?'), edit: true })
    })

    it('should save without asking when the amount was said (not deduced)', async () => {
      mockExpenseDraftDB.findById.mockResolvedValue(buildExpenseDraft({ ...deduced(), confidence: {} }))

      await service.handle(action(BotAction.SAVE))

      expect(mockSaver.save).toHaveBeenCalled()
    })
  })

  describe('budget (P19)', () => {
    const month = {
      budget: { salary: 4000, limitPercent: 100, limit: 4000, isProposal: false },
      spentPen: 3120,
      extraIncome: 500,
      surplus: 1380,
      incomes: [],
      budgetGroups: [],
      byCategory: [
        {
          categoryId: 'food',
          name: 'Comida',
          spent: 425,
          limit: 500,
          alertThreshold: 80,
          percent: 85,
          status: 'warning',
        },
        { categoryId: 'fun', name: 'Ocio', spent: 104, limit: 100, alertThreshold: 80, percent: 104, status: 'over' },
        {
          categoryId: 'taxi',
          name: 'Transporte',
          spent: 40,
          limit: null,
          alertThreshold: 80,
          percent: null,
          status: null,
        },
      ],
    }

    it('should add the alert to the saved notice when the expense crossed 80 % of its category', async () => {
      mockExpenseDraftDB.findById.mockResolvedValue(buildExpenseDraft())
      const budget = {
        personId: 'person-brando',
        categoryId: 'category-food',
        period: { paymentMonth: 9, paymentYear: 2026 },
        amount: 25,
      }
      mockSaver.save.mockResolvedValue({ id: 'expense-1', installments: null, budget })
      mockBudget.alertAfterSave.mockResolvedValue({ category: 'Comida', percent: 85, status: 'warning' })

      const { replies } = await service.handle(action(BotAction.SAVE))

      expect(mockBudget.alertAfterSave).toHaveBeenCalledWith('category-food', budget.period, 25, 'person-brando')
      expect(replies[1].text).toMatch(/^⚠️ Comida: 85 % del presupuesto\n✅ Guardado/)
    })

    it('should show /presupuesto with one bar per category with a limit and the surplus', async () => {
      mockBudget.month.mockResolvedValue(month)

      const { replies } = await service.handle({ ...command(BotCommand.BUDGET), text: '/presupuesto octubre' })

      expect(mockBudget.month).toHaveBeenCalledWith(10, 2026)
      expect(replies[0].text).toContain('📊 <b>Presupuesto de octubre 2026</b>')
      expect(replies[0].text).toContain('Gastado S/ 3120.00 de S/ 4000.00 (78 %)')
      expect(replies[0].text).toContain('Comida       ▓▓▓▓▓▓▓▓░░  85 %')
      expect(replies[0].text).toContain('Ocio         ▓▓▓▓▓▓▓▓▓▓ 104 %')
      expect(replies[0].text).toContain('Sin límite: Transporte S/ 40.00')
      expect(replies[0].text).toContain('💰 <b>Excedente: S/ 1380.00</b>')
    })

    it('should explain the format of /presupuesto when the month cannot be read', async () => {
      const { replies } = await service.handle({ ...command(BotCommand.BUDGET), text: '/presupuesto comida' })

      expect(mockBudget.month).not.toHaveBeenCalled()
      expect(replies[0].text).toContain('/presupuesto octubre')
    })

    it('should forecast which categories go over at this pace', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-09-10T15:00:00.000Z'))
      try {
        mockBudget.month.mockResolvedValue(month)

        const { replies } = await service.handle(command(BotCommand.FORECAST))

        expect(mockBudget.month).toHaveBeenCalledWith(9, 2026)
        expect(replies[0].text).toContain('🔮 <b>Pronóstico de setiembre 2026</b> (día 10 de 30)')
        expect(replies[0].text).toContain('🔴 Ocio: ya pasó el límite')
        // Comida: 425 in 10 days → 1,275 by the end, reaches 500 on day 12
        expect(replies[0].text).toContain('⚠️ Comida: a este ritmo se pasa S/ 775.00 y llega al límite el día 12.')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('shared expenses and money received (P17)', () => {
    it('should send only the expense to the AI and show the split in a second message (D75)', async () => {
      mockExtraction.extract.mockResolvedValue({
        expenses: [buildResolvedExpense({ description: 'Cena', amount: 120 })],
      })
      const half = { shares: [{ personId: 'person-danery', ratio: 0.5 }] }
      mockExpenseDraftDB.update.mockImplementation(async (id, data) =>
        buildExpenseDraft({ id, description: 'Cena', amount: 120, ...data }),
      )

      const { replies } = await service.handle(textMessage('cena 120 con dany, mitad'))

      expect(mockExtraction.extract).toHaveBeenCalledWith(expect.objectContaining({ text: 'cena 120' }))
      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith('file-0', expect.objectContaining({ sharedWith: half }))
      expect(replies).toHaveLength(2)
      expect(replies[0].text).toContain('🧾 <b>Cena</b> — S/ 120.00 (pagas tú)')
      expect(replies[1].text).toContain('👥 <b>Reparto</b>: pagas tú S/ 120.00')
      expect(replies[1].text).toContain('• Danery te debe S/ 60.00 (50 %)')
      expect(replies[1].text).toContain('Tu parte: S/ 60.00')
      expect(replies[1].buttons?.map((row) => row.map((button) => `${button.label}=${button.data}`))).toEqual([
        ['Danery ½=shr:file-0:0:h', '⅓=shr:file-0:0:t', '20 %=shr:file-0:0:p20'],
        ['✏️ Editar (Danery)=shr:file-0:0:m', '🗑️ Quitar (Danery)=shr:file-0:0:x'],
      ])
    })

    it('should show the split only after the expense is complete (card, period…)', async () => {
      mockExtraction.extract.mockResolvedValue({
        expenses: [buildResolvedExpense({ description: 'HBO', amount: 28, period: null, missingFields: ['period'] })],
      })
      const pending = {
        description: 'HBO',
        amount: 28,
        destination: ExpenseDestination.SUBSCRIPTION,
        missingFields: ['period'],
        pendingField: 'period',
        status: 'draft',
      }
      mockExpenseDraftDB.update.mockImplementation(async (id, data) => buildExpenseDraft({ id, ...pending, ...data }))

      const first = await service.handle(textMessage('hbo 28 con dany a medias'))
      expect(first.replies).toHaveLength(1)
      expect(first.replies[0].text).toContain('¿Cada cuánto se paga?')

      // the period button completes it: the summary is edited and the split arrives after it
      mockExpenseDraftDB.findById.mockResolvedValue(
        buildExpenseDraft({ ...pending, sharedWith: { shares: [{ personId: 'person-danery', ratio: 0.5 }] } }),
      )
      mockExpenseDraftDB.update.mockImplementation(async (id, data) =>
        buildExpenseDraft({
          id,
          ...pending,
          sharedWith: { shares: [{ personId: 'person-danery', ratio: 0.5 }] },
          ...data,
        }),
      )
      const { replies } = await service.handle(action(BotAction.SET_FIELD, ExpenseField.PERIOD, 'monthly'))

      expect(replies).toHaveLength(2)
      expect(replies[0].edit).toBe(true)
      expect(replies[1].text).toContain('Danery te debe S/ 14.00 (50 %)')
    })

    it("should change one person's part from the split message, editing only that message", async () => {
      mockExpenseDraftDB.findById.mockResolvedValue(
        buildExpenseDraft({ amount: 64, sharedWith: { shares: [{ personId: 'person-danery', ratio: 0.5 }] } }),
      )
      mockExpenseDraftDB.update.mockImplementation(async (id, data) => buildExpenseDraft({ id, amount: 64, ...data }))

      const { replies } = await service.handle({
        ...action(BotAction.SHARE),
        action: { name: BotAction.SHARE, draftId: FILE_ID, field: '0', value: 't' },
      })

      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith(FILE_ID, {
        sharedWith: { shares: [{ personId: 'person-danery', ratio: 1 / 3 }] },
      })
      expect(replies[0]).toMatchObject({ edit: true, text: expect.stringContaining('Danery te debe S/ 21.33 (33 %)') })
    })

    it('should ask and read a typed part after ✏️ of the split message', async () => {
      const shared = { shares: [{ personId: 'person-danery', ratio: 0.5 }] }
      mockExpenseDraftDB.findById.mockResolvedValue(buildExpenseDraft({ amount: 64, sharedWith: shared }))

      const asked = await service.handle({
        ...action(BotAction.SHARE),
        action: { name: BotAction.SHARE, draftId: FILE_ID, field: '0', value: 'm' },
      })
      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith(FILE_ID, { pendingField: 'share:0' })
      // the split message becomes the question, so its old buttons go away
      expect(asked.replies[0]).toMatchObject({ edit: true, text: expect.stringContaining('¿Cuánto te debe Danery?') })

      mockExpenseDraftDB.findOpenByChat.mockResolvedValue(
        buildExpenseDraft({ amount: 64, sharedWith: shared, pendingField: 'share:0' }),
      )
      mockExpenseDraftDB.update.mockImplementation(async (id, data) => buildExpenseDraft({ id, amount: 64, ...data }))
      const { replies } = await service.handle(textMessage('20'))

      expect(mockExpenseDraftDB.update).toHaveBeenLastCalledWith(FILE_ID, {
        sharedWith: { shares: [{ personId: 'person-danery', amount: 20 }] },
        pendingField: null,
      })
      expect(replies[0].text).toContain('Danery te debe S/ 20.00')
    })

    it('should stop sharing when the last person is removed', async () => {
      mockExpenseDraftDB.findById.mockResolvedValue(
        buildExpenseDraft({ sharedWith: { shares: [{ personId: 'person-danery', ratio: 0.5 }] } }),
      )

      const { replies } = await service.handle({
        ...action(BotAction.SHARE),
        action: { name: BotAction.SHARE, draftId: FILE_ID, field: '0', value: 'x' },
      })

      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith(FILE_ID, { sharedWith: null })
      expect(replies[0].text).toContain('Ya no se comparte')
    })

    it('should share the open expense when the message only says the split (D74)', async () => {
      // /editar netflix → "compartido con dany a medias": Netflix was saved as Danery's
      mockExpenseDraftDB.findOpenByChat.mockResolvedValue(
        buildExpenseDraft({ id: 'draft-copy', status: 'editing', amount: 64, personId: 'person-danery' }),
      )
      mockExpenseDraftDB.update.mockImplementation(async (id, data) =>
        buildExpenseDraft({ id, status: 'editing', amount: 64, ...data }),
      )

      const { replies } = await service.handle(textMessage('compartido con dany a medias'))

      expect(mockExtraction.extract).not.toHaveBeenCalled()
      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith('draft-copy', {
        sharedWith: { shares: [{ personId: 'person-danery', ratio: 0.5 }] },
        personId: 'person-brando',
        pendingField: null,
      })
      expect(replies[1].text).toContain('Danery te debe S/ 32.00 (50 %)')
    })

    it('should close the split message with what was saved and show it under the saved summary', async () => {
      mockExpenseDraftDB.findById.mockResolvedValue(
        buildExpenseDraft({
          amount: 65,
          shareMessageId: '901',
          sharedWith: {
            shares: [
              { personId: 'person-danery', ratio: 0.3 },
              { personId: 'person-brando', ratio: 0.3 },
            ],
          },
        }),
      )

      const { replies } = await service.handle(action(BotAction.SAVE))

      expect(replies[0].text).toContain('👥 Danery te debe S/ 19.50 · Brando te debe S/ 19.50 · tu parte S/ 26.00')
      expect(replies[1]).toEqual({
        editMessageId: '901',
        text: '✅ <b>Reparto guardado</b>\n• Danery te debe S/ 19.50 (30 %)\n• Brando te debe S/ 19.50 (30 %)\nTu parte: S/ 26.00',
      })
    })

    it('should answer an old split button of a saved expense with the final split, without buttons', async () => {
      mockExpenseDraftDB.findById.mockResolvedValue(
        buildExpenseDraft({
          status: 'saved',
          amount: 20,
          sharedWith: { shares: [{ personId: 'person-danery', ratio: 0.5 }] },
        }),
      )

      const { replies } = await service.handle({
        ...action(BotAction.SHARE),
        action: { name: BotAction.SHARE, draftId: FILE_ID, field: '0', value: 't' },
      })

      expect(mockExpenseDraftDB.update).not.toHaveBeenCalled()
      expect(replies[0]).toMatchObject({ edit: true, text: expect.stringContaining('✅ <b>Reparto guardado</b>') })
      expect(replies[0].buttons).toBeUndefined()
    })

    it.each([
      ['10', { amount: 10 }, 'Danery te debe S/ 10.00 (50 %)'],
      ['50', { ratio: 0.5 }, 'Danery te debe S/ 10.00 (50 %)'], // above the total of S/ 20: a percentage
    ])('should read "%s" typed after ✏️ Editar against the total', async (text, share, line) => {
      mockExpenseDraftDB.findOpenByChat.mockResolvedValue(
        buildExpenseDraft({
          amount: 20,
          pendingField: 'share:0',
          shareMessageId: '902',
          sharedWith: { shares: [{ personId: 'person-danery', ratio: 1 / 3 }] },
        }),
      )
      mockExpenseDraftDB.update.mockImplementation(async (id, data) =>
        buildExpenseDraft({ id, amount: 20, shareMessageId: '902', ...data }),
      )

      const { replies } = await service.handle(textMessage(text))

      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith(FILE_ID, {
        sharedWith: { shares: [{ personId: 'person-danery', ...share }] },
        pendingField: null,
      })
      // the old split message (now the question) is closed and a new one comes
      expect(replies[0]).toEqual({ text: '↩️ Reparto actualizado abajo.', editMessageId: '902' })
      expect(replies[1]).toMatchObject({ text: expect.stringContaining(line), trackShareOf: FILE_ID })
    })

    it('should not accept more than the total after ✏️ Editar', async () => {
      mockExpenseDraftDB.findOpenByChat.mockResolvedValue(
        buildExpenseDraft({
          amount: 20,
          pendingField: 'share:0',
          sharedWith: { shares: [{ personId: 'person-danery', ratio: 0.5 }] },
        }),
      )

      const { replies } = await service.handle(textMessage('150'))

      expect(mockExpenseDraftDB.update).not.toHaveBeenCalled()
      expect(replies[0].text).toContain('Danery no puede deber más que el total (S/ 20.00)')
    })

    it('should tell who owes what when a shared expense is saved', async () => {
      mockExpenseDraftDB.findById.mockResolvedValue(
        buildExpenseDraft({ amount: 64, sharedWith: { shares: [{ personId: 'person-danery', ratio: 0.5 }] } }),
      )

      const { replies } = await service.handle(action(BotAction.SAVE))

      expect(replies[1].text).toContain('👥 Danery te debe S/ 32.00.')
    })

    it('should propose a payment of what the sender owes for a "Te yapearon" screenshot', async () => {
      mockMediaDownloader.download.mockResolvedValue({ mimeType: 'image/jpeg', data: 'base64' })
      mockExtraction.extract.mockResolvedValue({
        expenses: [],
        received: [{ amount: 150, currency: 'PEN', sender: 'Danery Vi*', spentAt: null, operationNumber: null }],
      })
      mockDebts.proposePayment.mockResolvedValue({
        batchId: 'batch1',
        personId: 'person-danery',
        direction: DebtDirection.OWED_TO_ME,
        items: [],
        excess: 0,
      })

      await service.handle({
        channel: ExpenseDraftChannel.TELEGRAM,
        chatId: CHAT_ID,
        messageId: '78',
        type: ChannelMessageType.IMAGE,
        media: { fileId: 'file-2', uniqueId: 'unique-2' },
      })

      expect(mockDebts.proposePayment).toHaveBeenCalledWith('person-danery', DebtDirection.OWED_TO_ME, 150)
    })

    it('should say that money received from someone without debts is not an expense', async () => {
      mockMediaDownloader.download.mockResolvedValue({ mimeType: 'image/jpeg', data: 'base64' })
      mockExtraction.extract.mockResolvedValue({
        expenses: [],
        received: [{ amount: 50, currency: 'PEN', sender: 'Rosa', spentAt: null, operationNumber: null }],
      })

      const { replies } = await service.handle({
        channel: ExpenseDraftChannel.TELEGRAM,
        chatId: CHAT_ID,
        messageId: '79',
        type: ChannelMessageType.IMAGE,
        media: { fileId: 'file-3', uniqueId: 'unique-3' },
      })

      expect(mockDebts.proposePayment).not.toHaveBeenCalled()
      expect(replies[0].text).toContain('💸 Recibiste S/ 50.00 de <b>Rosa</b>: no es un gasto')
    })

    it('should name the list items the AI could not read (P21)', async () => {
      mockMediaDownloader.download.mockResolvedValue({ mimeType: 'image/jpeg', data: 'base64' })
      mockExtraction.extract.mockResolvedValue({
        expenses: [buildResolvedExpense()],
        unreadable: ['NINTENDO ESH…', 'YANGO'],
      })

      const { replies } = await service.handle({
        channel: ExpenseDraftChannel.TELEGRAM,
        chatId: CHAT_ID,
        messageId: '80',
        type: ChannelMessageType.IMAGE,
        media: { fileId: 'file-4', uniqueId: 'unique-4' },
      })

      expect(replies.at(-1)?.text).toBe('⚠️ No pude leer: NINTENDO ESH…, YANGO. Mándalos en otra captura o escríbelos.')
    })

    it('should offer the debts as Excel and PDF, and send the file when pressed (D39)', async () => {
      mockDebts.summary.mockResolvedValue([
        { personId: 'person-danery', name: 'Danery', owedToMe: 400, iOwe: 0, net: 400, late: 0, dueThisMonth: 0 },
      ])
      const { replies } = await service.handle(command(BotCommand.DEBTS))
      expect(replies[0].buttons?.[0].map((button) => button.data)).toEqual(['rep:xlsx-all', 'rep:pdf-all'])

      const file = { filename: 'deudas-todas-2026-09-23.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-') }
      mockReports.debts.mockResolvedValue(file)
      const result = await service.handle({
        ...action(BotAction.REPORT),
        action: { name: BotAction.REPORT, draftId: 'pdf-all' },
      })

      expect(mockReports.debts).toHaveBeenCalledWith('pdf', undefined)
      expect(result.replies[0]).toEqual({ text: '📎 deudas-todas-2026-09-23.pdf', document: file })
    })
  })

  describe('command buttons', () => {
    it('should run the command of a help button as if it was typed', async () => {
      mockExpenseDraftDB.findRecentSaved.mockResolvedValue([])

      await service.handle({ ...action(BotAction.COMMAND), action: { name: BotAction.COMMAND, draftId: 'ultimos' } })

      expect(mockExpenseDraftDB.findRecentSaved).toHaveBeenCalled()
    })

    it('should ignore a button of an unknown command', async () => {
      const { replies } = await service.handle({
        ...action(BotAction.COMMAND),
        action: { name: BotAction.COMMAND, draftId: 'borrar-todo' },
      })

      expect(replies).toEqual([])
    })
  })

  describe('/editar (D76)', () => {
    const saved = buildExpenseDraft({
      id: 'draft-saved',
      status: 'saved',
      description: 'Netflix',
      amount: 64,
      personId: 'person-brando',
      paymentMethodId: 'method-ohpay',
      destination: ExpenseDestination.SUBSCRIPTION,
    })

    it('should find saved expenses by concept, amount and catalog names, with a ✏️ button each', async () => {
      mockExpenseDraftDB.searchSaved.mockResolvedValue([saved])

      const { replies } = await service.handle({ ...command(BotCommand.EDIT), text: '/editar netflix 64 la oh' })

      expect(mockExpenseDraftDB.searchSaved).toHaveBeenCalledWith(
        ExpenseDraftChannel.TELEGRAM,
        CHAT_ID,
        expect.objectContaining({ text: 'netflix', amount: 64, paymentMethodId: 'method-ohpay' }),
        5,
      )
      expect(replies[0].text).toContain('1. 22/09/2026 <b>Netflix</b> — S/ 64.00 · Plataforma · OhPay')
      expect(replies[0].buttons).toEqual([[{ label: '✏️ 1', data: 'eds:draft-saved' }]])
    })

    it('should explain how to search and say when nothing matches', async () => {
      expect((await service.handle(command(BotCommand.EDIT))).replies[0].text).toContain('netflix')

      mockExpenseDraftDB.searchSaved.mockResolvedValue([])
      const { replies } = await service.handle({ ...command(BotCommand.EDIT), text: '/editar pizza' })
      expect(replies[0].text).toContain('No encontré gastos guardados con «pizza»')
    })

    it('should open an editing copy with "Guardar cambios" and leave the saved one untouched', async () => {
      mockExpenseDraftDB.findById.mockResolvedValue(saved)
      mockExpenseDraftDB.createEditCopy.mockResolvedValue({
        ...saved,
        id: 'draft-copy',
        status: 'editing',
        replacesDraftId: 'draft-saved',
      })

      const { replies } = await service.handle({
        ...action(BotAction.EDIT_SAVED),
        action: { name: BotAction.EDIT_SAVED, draftId: 'draft-saved' },
      })

      expect(mockExpenseDraftDB.discardOpenByChat).toHaveBeenCalledWith(ExpenseDraftChannel.TELEGRAM, CHAT_ID)
      expect(mockExpenseDraftDB.createEditCopy).toHaveBeenCalledWith(saved, expect.stringMatching(/^edit:/))
      expect(replies[0].text).toContain('✏️ <b>Editando</b>')
      expect(replies[0].buttons?.flat().map((button) => button.label)).toEqual([
        '✅ Guardar cambios',
        '✏️ Editar',
        '❌ Cancelar',
      ])
    })

    it('should keep the copy in editing when it is corrected', async () => {
      mockExpenseDraftDB.findOpenByChat.mockResolvedValue({ ...saved, id: 'draft-copy', status: 'editing' })
      mockExtraction.parseLocalCorrection.mockResolvedValue({ amount: 70 })

      await service.handle(textMessage('monto 70'))

      expect(mockExpenseDraftDB.update).toHaveBeenCalledWith(
        'draft-copy',
        expect.objectContaining({ amount: 70, status: 'editing' }),
      )
    })

    it('should drop the copy with ❌ Cancelar', async () => {
      mockExpenseDraftDB.findById.mockResolvedValue({ ...saved, id: 'draft-copy', status: 'editing' })

      const { replies } = await service.handle(action(BotAction.DISCARD))

      expect(replies[0].text).toContain('Edición cancelada')
    })

    it('should not replace an expense whose debts have payments', async () => {
      mockExpenseDraftDB.findById.mockResolvedValue({ ...saved, id: 'draft-copy', status: 'editing' })
      mockSaver.save.mockRejectedValue(new SavedExpenseLockedException())

      const { replies } = await service.handle(action(BotAction.SAVE))

      expect(replies[0].text).toContain('tiene deudas con abonos')
    })

    it('should not open a result that is no longer saved', async () => {
      mockExpenseDraftDB.findById.mockResolvedValue({ ...saved, status: 'discarded' })

      const result = await service.handle({
        ...action(BotAction.EDIT_SAVED),
        action: { name: BotAction.EDIT_SAVED, draftId: 'draft-saved' },
      })

      expect(result.replies).toEqual([])
      expect(mockExpenseDraftDB.createEditCopy).not.toHaveBeenCalled()
    })
  })
  describe('reminders (P20)', () => {
    it('should hand the buttons of a notice and of /avisos to the notifications', async () => {
      const result = { replies: [{ text: 'ok', edit: true }], notice: '✅ Pagado' }
      mockNotificationsBot.handleAction.mockResolvedValue(result)
      const payload = { name: BotAction.NOTIFY, draftId: 'n1', value: 'p' }

      const answer = await service.handle({ ...action(BotAction.NOTIFY), action: payload })

      expect(mockNotificationsBot.handleAction).toHaveBeenCalledWith(CHAT_ID, payload)
      expect(answer).toEqual(result)
      expect(mockExpenseDraftDB.findById).not.toHaveBeenCalled()
    })

    it('should answer /avisos, /calendario and /cuotas', async () => {
      mockNotificationsBot.settingsReply.mockResolvedValue({ text: 'avisos' })
      mockNotificationsBot.calendarReply.mockResolvedValue({ text: 'calendario' })
      mockNotificationsBot.installmentsReply.mockResolvedValue({ text: 'cuotas' })

      const texts = await Promise.all(
        [BotCommand.ALERTS, BotCommand.CALENDAR, BotCommand.INSTALLMENTS].map(
          async (name) => (await service.handle(command(name))).replies[0].text,
        ),
      )

      expect(texts).toEqual(['avisos', 'calendario', 'cuotas'])
    })

    it('should take the amount asked by ✏️ Editar monto before reading a new expense', async () => {
      mockNotificationsBot.answerAmount.mockResolvedValue([{ text: '✅ Luz: el monto ahora es S/ 130.00.' }])

      const { replies } = await service.handle({
        channel: ExpenseDraftChannel.TELEGRAM,
        chatId: CHAT_ID,
        messageId: '90',
        type: ChannelMessageType.TEXT,
        text: '130',
      })

      expect(mockNotificationsBot.answerAmount).toHaveBeenCalledWith(CHAT_ID, '130')
      expect(replies).toEqual([{ text: '✅ Luz: el monto ahora es S/ 130.00.' }])
      expect(mockExpenseDraftDB.findOpenByChat).not.toHaveBeenCalled()
    })
  })
})
