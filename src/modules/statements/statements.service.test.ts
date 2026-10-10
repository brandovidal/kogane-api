import { Test } from '@nestjs/testing'
import { vi } from 'vitest'

import { AiOperation } from '@/commons/constants/ai.constant'
import { PaymentStatus } from '@/commons/constants/expense.constant'
import { NotificationKind } from '@/commons/constants/notification.constant'
import { StatementRowResult, StatementSource, StatementStatus } from '@/commons/constants/statement.constant'
import { StatementPasswordException } from '@/commons/exceptions/statement/statement-password.exception'
import { StatementUnreadableException } from '@/commons/exceptions/statement/statement-unreadable.exception'
import { CardHolderDBRepository } from '@/db/models/card-holder/cardHolderDB.repository'
import { PaymentMethodDBRepository } from '@/db/models/payment-method/paymentMethodDB.repository'
import { PersonDBRepository } from '@/db/models/person/personDB.repository'
import { StatementDBRepository } from '@/db/models/statement/statementDB.repository'
import { ExpenseExtractionService } from '@/modules/expense-extraction/expense-extraction.service'
import { NotificationsService } from '@/modules/notifications/notifications.service'
import { StoredFilesService } from '@/modules/stored-files/stored-files.service'

import { readPdfLines } from './statement-pdf.reader'
import { StatementsService } from './statements.service'

vi.mock('./statement-pdf.reader', () => ({ readPdfLines: vi.fn() }))

const SIP_LINES = [
  'ESTADO DE CUENTA - TARJETA SIP',
  'Fecha de cierre 10/09/2026',
  'Ultimo dia de pago 05/10/2026',
  'Total a pagar S/ 200.40',
  '15/08 16/08 MP*MERCADOLI 1/3 164.90',
  '20/08 20/08 TAMBO VIRREY 35.50',
]

const OH = {
  id: 'oh',
  name: 'Sip',
  aliases: ['oh', 'oh pay'],
  type: 'credit_card',
  code: 'OH',
  isActive: true,
  billingCloseDay: 10,
  paymentDueDay: 5,
}

const mockStatementDB = {
  create: vi.fn(),
  findById: vi.fn(),
  findMany: vi.fn(),
  findCardExpenses: vi.fn(),
  createExpenses: vi.fn(),
  updateRow: vi.fn(),
  assignPerson: vi.fn(),
  assignRows: vi.fn(),
  changeCard: vi.fn(),
  delete: vi.fn(),
}
const mockPaymentMethods = {
  findAll: vi.fn(),
  findById: vi.fn(),
  findStatementPasswords: vi.fn(),
  setStatementPassword: vi.fn(),
}
const mockPeople = { findDefault: vi.fn(), findActive: vi.fn(), update: vi.fn() }
const mockExtraction = { generateStructured: vi.fn() }
const mockFiles = { storeTemporary: vi.fn(), keep: vi.fn(), signedUrl: vi.fn() }
const mockNotifications = { notify: vi.fn() }
const mockHolders = { findByCard: vi.fn() }

const saved = (rows: Record<string, unknown>[]) => ({
  id: 's1',
  paymentMethodId: 'oh',
  paymentMonth: 9,
  paymentYear: 2026,
  totalDue: 200.4,
  dueDate: new Date('2026-10-05T00:00:00Z'),
  rows,
})

describe('StatementsService', () => {
  let service: StatementsService

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        StatementsService,
        { provide: StatementDBRepository, useValue: mockStatementDB },
        { provide: PaymentMethodDBRepository, useValue: mockPaymentMethods },
        { provide: PersonDBRepository, useValue: mockPeople },
        { provide: ExpenseExtractionService, useValue: mockExtraction },
        { provide: StoredFilesService, useValue: mockFiles },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: CardHolderDBRepository, useValue: mockHolders },
      ],
    }).compile()
    service = module.get(StatementsService)

    mockPeople.findDefault.mockResolvedValue({ id: 'me', documentNumber: '44556677' })
    mockPeople.findActive.mockResolvedValue([{ id: 'me', name: 'Brando', aliases: [] }])
    mockPaymentMethods.findAll.mockResolvedValue([OH, { id: 'yape', type: 'wallet', code: null }])
    mockPaymentMethods.findById.mockResolvedValue(OH)
    mockPaymentMethods.findStatementPasswords.mockResolvedValue([])
    mockStatementDB.findCardExpenses.mockResolvedValue([
      {
        id: 'e1',
        description: 'Mercado Libre',
        amount: 164.9,
        processDate: new Date('2026-08-15T00:00:00Z'),
        installment: '1/3',
      },
      { id: 'e2', description: 'Uber', amount: 20, processDate: new Date('2026-08-21T00:00:00Z'), installment: null },
    ])
    mockStatementDB.create.mockImplementation(async (data) => ({ id: 's1', ...data }))
    mockFiles.storeTemporary.mockResolvedValue({ id: 'file-1' })
    mockNotifications.notify.mockResolvedValue({})
    mockHolders.findByCard.mockResolvedValue([])
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('should open the PDF with the document number, read it without AI and reconcile it with the card month', async () => {
    vi.mocked(readPdfLines).mockResolvedValue(SIP_LINES)
    mockStatementDB.findById.mockImplementation(async () => ({
      ...saved([
        { result: StatementRowResult.MATCHED, expenseId: 'e1' },
        { result: StatementRowResult.NEW, expenseId: null },
      ]),
    }))

    const view = await service.upload({ data: Buffer.from('pdf') })

    expect(readPdfLines).toHaveBeenCalledWith(Buffer.from('pdf'), '44556677')
    expect(mockExtraction.generateStructured).not.toHaveBeenCalled()
    expect(mockStatementDB.findCardExpenses).toHaveBeenCalledWith('oh', { paymentMonth: 9, paymentYear: 2026 })
    expect(mockStatementDB.create).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMethodId: 'oh',
        paymentMonth: 9,
        paymentYear: 2026,
        totalDue: 200.4,
        dueDate: new Date('2026-10-05T00:00:00.000Z'),
        source: StatementSource.TEMPLATE,
        fileId: 'file-1',
        status: StatementStatus.REVIEW,
        rows: [
          expect.objectContaining({ description: 'MP*MERCADOLI', result: StatementRowResult.MATCHED, expenseId: 'e1' }),
          expect.objectContaining({ description: 'TAMBO VIRREY', result: StatementRowResult.NEW, expenseId: null }),
        ],
      }),
    )
    expect(mockFiles.keep).toHaveBeenCalledWith('file-1')
    expect(view).toMatchObject({ cardName: 'Sip', koganeTotal: 184.9, difference: 15.5 })
    expect(view.missing.map((expense) => expense.id)).toEqual(['e2'])
    expect(mockNotifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: NotificationKind.STATEMENT, dedupeKey: 'statement:s1' }),
    )
  })

  it('should send only the masked text to the AI when the template does not add up', async () => {
    vi.mocked(readPdfLines).mockResolvedValue(['Tarjeta SIP', 'Titular 44556677', 'Total a pagar 999.00'])
    mockExtraction.generateStructured.mockResolvedValue({
      cardName: 'Sip',
      periodEnd: '2026-09-10',
      dueDate: '2026-10-05',
      totalDue: 999,
      minimumDue: null,
      currency: 'PEN',
      movements: [{ date: '2026-08-20', description: 'CINE', amount: 999, currency: 'PEN', installment: null }],
    })
    mockStatementDB.findById.mockResolvedValue(saved([]))

    await service.upload({ data: Buffer.from('pdf') })

    const request = mockExtraction.generateStructured.mock.calls[0][0]
    expect(request.operation).toBe(AiOperation.STATEMENT)
    expect(request.text).not.toContain('44556677')
    expect(mockStatementDB.create).toHaveBeenCalledWith(
      expect.objectContaining({ source: StatementSource.AI, rows: [expect.objectContaining({ description: 'CINE' })] }),
    )
  })

  it("should trust the card the AI read off the statement over the template's naive full-text scan", async () => {
    // The template's cardHint would guess CMR from this unrelated line (a cross-brand ad every statement can carry);
    // the AI reads the real card printed on the header
    vi.mocked(readPdfLines).mockResolvedValue([
      'Acumula puntos en tiendas Falabella y CMR',
      'Fecha de cierre 09/09/2026',
      // The template's total does not match its own rows (D95): the AI reads the rest, and the real card too
      'Total a pagar S/ 200.00',
      '09/09/2026 09/09/2026 Compra IO 110.00',
    ])
    mockExtraction.generateStructured.mockResolvedValue({
      cardName: 'IO',
      periodEnd: '2026-09-09',
      dueDate: null,
      totalDue: 200,
      minimumDue: null,
      currency: 'PEN',
      movements: [
        { date: '2026-09-09', description: 'Compra IO', amount: 110, currency: 'PEN', installment: null },
        { date: '2026-09-09', description: 'Otra compra', amount: 90, currency: 'PEN', installment: null },
      ],
    })
    mockPaymentMethods.findAll.mockResolvedValue([
      OH,
      { id: 'cmr', name: 'CMR', aliases: ['falabella'], type: 'credit_card', code: 'CMR', isActive: true },
      { id: 'io', name: 'IO', aliases: ['interbank io'], type: 'credit_card', code: 'IO', isActive: true },
    ])
    mockStatementDB.findById.mockResolvedValue(saved([]))

    await service.upload({ data: Buffer.from('pdf') })

    expect(mockStatementDB.create).toHaveBeenCalledWith(expect.objectContaining({ paymentMethodId: 'io' }))
  })

  it('should keep itemized interest and insurance charges when AI reads the rest of a statement', async () => {
    vi.mocked(readPdfLines).mockResolvedValue([
      'ESTADO DE CUENTA - TARJETA SIP',
      'Fecha de cierre 09/09/2026',
      'Total a pagar S/ 110.00',
      '09/09/2026 09/09/2026 Seguro Desgravamen 13.90',
      '09/09/2026 09/09/2026 Interes Compensatorio 545.99',
    ])
    mockExtraction.generateStructured.mockResolvedValue({
      cardName: 'Sip',
      periodEnd: '2026-09-09',
      dueDate: null,
      totalDue: 110,
      minimumDue: null,
      currency: 'PEN',
      movements: [
        { date: '2026-09-09', description: 'Seguro Desgravamen', amount: 13.9, currency: 'PEN', installment: null },
      ],
    })
    mockStatementDB.findById.mockResolvedValue(saved([]))

    await service.upload({ data: Buffer.from('pdf') })

    expect(mockStatementDB.create).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: expect.arrayContaining([
          expect.objectContaining({ description: 'Seguro Desgravamen', amount: 13.9 }),
          expect.objectContaining({ description: 'Interes Compensatorio', amount: 545.99 }),
        ]),
      }),
    )
  })

  it('should ask for the card when the statement does not say which one', async () => {
    vi.mocked(readPdfLines).mockResolvedValue(['Fecha de cierre 10/09/2026', 'Total a pagar 20.00', '01/09 CINE 20.00'])

    await expect(service.upload({ data: Buffer.from('pdf') })).rejects.toBeInstanceOf(StatementUnreadableException)
    mockStatementDB.findById.mockResolvedValue(saved([]))
    await service.upload({ data: Buffer.from('pdf'), paymentMethodId: 'oh' })
    expect(mockStatementDB.create).toHaveBeenCalledWith(expect.objectContaining({ paymentMethodId: 'oh' }))
  })

  it('should create the new rows as pending card expenses of the statement month', async () => {
    mockStatementDB.findById.mockResolvedValue(
      saved([
        {
          id: 'r1',
          result: StatementRowResult.NEW,
          description: 'TAMBO',
          amount: 35.5,
          currency: 'PEN',
          installment: null,
          date: new Date('2026-08-20T00:00:00Z'),
          expenseId: null,
        },
        {
          id: 'r2',
          result: StatementRowResult.MATCHED,
          description: 'X',
          amount: 1,
          currency: 'PEN',
          installment: null,
          date: null,
          expenseId: 'e1',
        },
      ]),
    )

    await service.createNew('s1')

    expect(mockStatementDB.createExpenses).toHaveBeenCalledWith('s1', [
      {
        id: 'r1',
        data: expect.objectContaining({
          description: 'TAMBO',
          amount: 35.5,
          amountInPen: 35.5,
          paymentStatus: PaymentStatus.NOT_STARTED,
          personId: 'me',
          paymentMethodId: 'oh',
          paymentMonth: 9,
          paymentYear: 2026,
        }),
      },
    ])
  })

  it('should create a row chosen by hand even if it matched, with your description and the bank text in the notes', async () => {
    mockStatementDB.findById.mockResolvedValue(
      saved([
        {
          id: 'r2',
          result: StatementRowResult.MATCHED,
          description: 'IZI*OSTEO PERU T',
          label: 'OsteoPeru',
          amount: 139.64,
          currency: 'PEN',
          installment: '1/4',
          date: null,
          expenseId: 'e1',
        },
        {
          id: 'r3',
          result: StatementRowResult.CREATED,
          description: 'Y',
          label: null,
          amount: 1,
          currency: 'PEN',
          installment: null,
          date: null,
          expenseId: 'e9',
        },
      ]),
    )

    await service.createNew('s1', ['r2', 'r3'])

    expect(mockStatementDB.createExpenses).toHaveBeenCalledWith('s1', [
      {
        id: 'r2',
        data: expect.objectContaining({
          description: 'OsteoPeru',
          notes: 'Del estado de cuenta: IZI*OSTEO PERU T',
          installment: '1/4',
        }),
      },
    ])
  })

  describe('the person of each purchase (D113)', () => {
    const row = (overrides: Record<string, unknown>) => ({
      id: 'r1',
      result: StatementRowResult.NEW,
      description: 'TAMBO',
      amount: 35.5,
      currency: 'PEN',
      installment: null,
      date: null,
      expenseId: null,
      personId: null,
      ...overrides,
    })

    it("should show the expense's person once matched, the chosen one, or the statement's", async () => {
      mockStatementDB.findCardExpenses.mockResolvedValue([
        { id: 'e1', description: 'X', amount: 1, processDate: null, installment: null, personId: 'dany' },
      ])
      mockStatementDB.findById.mockResolvedValue({
        ...saved([
          row({ id: 'matched', result: StatementRowResult.MATCHED, expenseId: 'e1' }),
          row({ id: 'chosen', personId: 'bruce' }),
          row({ id: 'plain' }),
        ]),
        personId: 'me',
      })

      const view = await service.get('s1')

      expect(view.rows.map((item) => [item.id, item.personId])).toEqual([
        ['matched', 'dany'],
        ['chosen', 'bruce'],
        ['plain', 'me'],
      ])
    })

    it('should save each new purchase with the person chosen for it, else the statement person', async () => {
      mockStatementDB.findById.mockResolvedValue({
        ...saved([row({ id: 'r1', personId: 'dany' }), row({ id: 'r2' })]),
        personId: 'me',
      })

      await service.createNew('s1')

      expect(mockStatementDB.createExpenses.mock.calls[0][1].map((item) => [item.id, item.data.personId])).toEqual([
        ['r1', 'dany'],
        ['r2', 'me'],
      ])
    })

    it('should give each purchase of a CMR statement to the section it is under, and the charges to the titular (D116)', async () => {
      mockPeople.findActive.mockResolvedValue([
        { id: 'me', name: 'Brando', aliases: [] },
        { id: 'dany', name: 'Danery', aliases: [] },
      ])
      mockPaymentMethods.findAll.mockResolvedValue([
        {
          id: 'cmr',
          name: 'CMR',
          aliases: [],
          type: 'credit_card',
          code: 'CMR',
          isActive: true,
          billingCloseDay: 10,
          paymentDueDay: 5,
        },
      ])
      vi.mocked(readPdfLines).mockResolvedValue([
        'ESTADO DE CUENTA CMR',
        'Fecha de cierre 10/09/2026',
        'Ultimo dia de pago 05/10/2026',
        'Total a pagar S/ 113.90',
        'Brando Jesus Vidal Deza Tc: 447410******1810',
        '15/08 16/08 FALABELLA 20.00',
        'Danery Vidal Deza Tc: 447410******8835',
        '20/08 20/08 TOTTIS 80.00',
        '09/09 09/09 SEGURO DESGRAVAMEN 13.90',
      ])
      mockStatementDB.findCardExpenses.mockResolvedValue([])

      mockStatementDB.findById.mockImplementation(async () => {
        const created = await mockStatementDB.create.mock.results[0].value
        return { ...created, rows: created.rows.map((item: object, index: number) => ({ id: `r${index}`, ...item })) }
      })

      await service.upload({ data: Buffer.from('pdf'), paymentMethodId: 'cmr' })

      // The notice of the statement says what the other people of the card have on it (P30)
      expect(mockNotifications.notify.mock.calls[0][0].body).toContain('A cobrar: Danery S/ 80.00.')
      const { rows } = mockStatementDB.create.mock.calls[0][0]
      expect(rows.map((item: { description: string; personId: string }) => [item.description, item.personId])).toEqual([
        ['FALABELLA', 'me'],
        ['TOTTIS', 'dany'],
        ['SEGURO DESGRAVAMEN', 'me'],
      ])
    })

    it("should also make another person's purchase their cobro on the owner's card (D114, D116)", async () => {
      mockStatementDB.findById.mockResolvedValue({
        ...saved([row({ id: 'mine' }), row({ id: 'theirs', personId: 'dany', installment: '2/3' })]),
        personId: 'me',
      })

      await service.createNew('s1')

      const [[, created]] = mockStatementDB.createExpenses.mock.calls
      expect(created[0]).not.toHaveProperty('debt')
      expect(created[1].debt).toEqual(
        expect.objectContaining({
          direction: 'owed_to_me',
          personId: 'dany',
          amount: 35.5,
          paymentMethodId: 'oh',
          installment: '2/3',
          paymentMonth: 9,
          paymentYear: 2026,
        }),
      )
    })

    it('should give several rows to a person at once, only an active one', async () => {
      mockStatementDB.findById.mockResolvedValue(saved([]))
      mockPeople.findActive.mockResolvedValue([{ id: 'dany', name: 'Danery', aliases: [] }])

      await service.assignRows('s1', { rowIds: ['r1', 'r2'], personId: 'dany' })
      expect(mockStatementDB.assignRows).toHaveBeenCalledWith('s1', ['r1', 'r2'], 'dany')
      await expect(service.assignRows('s1', { rowIds: ['r1'], personId: 'ghost' })).rejects.toBeInstanceOf(
        StatementUnreadableException,
      )
    })

    it('should only let an active person be chosen for a row', async () => {
      mockStatementDB.findById.mockResolvedValue(saved([]))
      mockPeople.findActive.mockResolvedValue([{ id: 'dany', name: 'Danery', aliases: [] }])

      await service.updateRow('s1', 'r1', { personId: 'dany' })
      expect(mockStatementDB.updateRow).toHaveBeenCalledWith('s1', 'r1', expect.objectContaining({ personId: 'dany' }))
      await expect(service.updateRow('s1', 'r1', { personId: 'ghost' })).rejects.toBeInstanceOf(
        StatementUnreadableException,
      )
    })
  })

  describe('payment summary (D95, "Resumen de movimientos y pagos del mes")', () => {
    const row = (overrides: Record<string, unknown>) => ({
      id: 'r1',
      result: StatementRowResult.NEW,
      description: 'TAMBO',
      amount: 35.5,
      currency: 'PEN',
      installment: null,
      date: null,
      expenseId: null,
      personId: null,
      ...overrides,
    })

    it('should split each currency into direct consumption, installments and itemized charges', async () => {
      mockStatementDB.findById.mockResolvedValue(
        saved([
          row({ id: 'a', description: 'CINEPLANET', amount: 20 }), // direct, no installment
          row({ id: 'b', description: 'FREEPASS 2/3', amount: 40, installment: '2/3' }), // installment
          row({ id: 'c', description: 'Interes Compensatorio', amount: 5 }), // itemized, wins over "direct"
          row({ id: 'd', description: 'RAILWAY', amount: 25, currency: 'USD' }), // a second currency
        ]),
      )

      const view = await service.get('s1')

      expect(view.balances).toEqual([
        expect.objectContaining({
          currency: 'PEN',
          directConsumption: 20,
          installmentConsumption: 40,
          itemizedCharges: 5,
        }),
        expect.objectContaining({
          currency: 'USD',
          directConsumption: 25,
          installmentConsumption: 0,
          itemizedCharges: 0,
        }),
      ])
    })
  })

  it('should give a signed link to the PDF of a statement, or null when it was not kept', async () => {
    mockStatementDB.findById.mockResolvedValueOnce({ ...saved([]), fileId: 'f1' })
    mockFiles.signedUrl.mockResolvedValueOnce('https://signed/f1')
    expect(await service.fileUrl('s1')).toEqual({ url: 'https://signed/f1' })
    expect(mockFiles.signedUrl).toHaveBeenCalledWith('f1')

    mockStatementDB.findById.mockResolvedValueOnce({ ...saved([]), fileId: null })
    mockFiles.signedUrl.mockResolvedValueOnce(null)
    expect(await service.fileUrl('s1')).toEqual({ url: null })
  })

  it('should rename a row (empty goes back to the bank text) or ignore it', async () => {
    mockStatementDB.findById.mockResolvedValue(saved([]))
    await service.updateRow('s1', 'r1', { label: '' })
    expect(mockStatementDB.updateRow).toHaveBeenCalledWith('s1', 'r1', { result: undefined, label: null })
    await service.updateRow('s1', 'r1', { result: StatementRowResult.IGNORED })
    expect(mockStatementDB.updateRow).toHaveBeenLastCalledWith('s1', 'r1', { result: 'ignored', label: undefined })
  })

  describe('password, holder and card (P14)', () => {
    const DANY = { id: 'dany', name: 'Danery', aliases: ['dany'], documentNumber: '70112233' }
    const ME = { id: 'me', name: 'Brando', aliases: [], documentNumber: '44556677' }
    const passwordError = () => new StatementPasswordException({ reason: 'incorrect' })
    const reasonOf = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (error: StatementPasswordException) => (error.getResponse() as { details: { reason: string } }).details.reason,
      )

    beforeEach(() => {
      mockPeople.findDefault.mockResolvedValue(ME)
      mockPeople.findActive.mockResolvedValue([ME, DANY])
      mockStatementDB.findById.mockImplementation(async () => saved([]))
    })

    it("should try the saved document numbers until one opens it, and give it to that person's statement", async () => {
      vi.mocked(readPdfLines).mockImplementation(async (_data, password) => {
        if (password !== '70112233') throw passwordError()
        return SIP_LINES
      })

      await service.upload({ data: Buffer.from('pdf') })

      expect(vi.mocked(readPdfLines).mock.calls.map(([, password]) => password)).toEqual(['44556677', '70112233'])
      expect(mockStatementDB.create).toHaveBeenCalledWith(expect.objectContaining({ personId: 'dany' }))
    })

    it('should say the password is missing when nothing saved opens it, and wrong when the typed one fails', async () => {
      vi.mocked(readPdfLines).mockRejectedValue(passwordError())

      expect(await reasonOf(service.upload({ data: Buffer.from('pdf') }))).toBe('missing')
      expect(await reasonOf(service.upload({ data: Buffer.from('pdf'), password: '1234' }))).toBe('incorrect')
    })

    it('should save the typed password as the document number only when asked and when it opened the PDF', async () => {
      vi.mocked(readPdfLines).mockImplementation(async (_data, password) => {
        if (password !== '99887766') throw passwordError()
        return SIP_LINES
      })

      await service.upload({ data: Buffer.from('pdf'), password: '99887766', personId: 'dany', savePassword: true })
      await service.upload({ data: Buffer.from('pdf'), password: '99887766', personId: 'dany' })

      expect(mockPeople.update).toHaveBeenCalledTimes(1)
      expect(mockPeople.update).toHaveBeenCalledWith('dany', { documentNumber: '99887766' })
    })

    it("should try the chosen card's saved password first and every card password after the people (I12)", async () => {
      const ioKey = ['io', 'key'].join('-')
      const ohKey = ['oh', 'key'].join('-')
      mockPaymentMethods.findStatementPasswords.mockResolvedValue([
        { id: 'io', password: ioKey },
        { id: 'oh', password: ohKey },
      ])
      vi.mocked(readPdfLines).mockImplementation(async (_data, password) => {
        if (password !== ioKey) throw passwordError()
        return SIP_LINES
      })

      await service.upload({ data: Buffer.from('pdf'), paymentMethodId: 'oh' })
      expect(vi.mocked(readPdfLines).mock.calls.map(([, password]) => password)).toEqual([
        ohKey,
        '44556677',
        '70112233',
        ioKey,
      ])
    })

    it('should keep the typed password on the card only when asked and when it opened the PDF (I12)', async () => {
      vi.mocked(readPdfLines).mockImplementation(async (_data, password) => {
        if (password !== 'clave-oh') throw passwordError()
        return SIP_LINES
      })

      await service.upload({ data: Buffer.from('pdf'), password: 'clave-oh', saveCardPassword: true })
      await service.upload({ data: Buffer.from('pdf'), password: 'clave-oh' })

      expect(mockPaymentMethods.setStatementPassword).toHaveBeenCalledTimes(1)
      expect(mockPaymentMethods.setStatementPassword).toHaveBeenCalledWith('oh', 'clave-oh')
    })

    it('should give the statement to the holder it names, and to the chosen person over anything else', async () => {
      vi.mocked(readPdfLines).mockResolvedValue(['TITULAR: DANERY QUISPE', ...SIP_LINES])

      await service.upload({ data: Buffer.from('pdf') })
      await service.upload({ data: Buffer.from('pdf'), personId: 'me' })

      expect(mockStatementDB.create.mock.calls.map(([data]) => data.personId)).toEqual(['dany', 'me'])
    })

    it('should find the card by its name or alias when the text has no known code', async () => {
      vi.mocked(readPdfLines).mockResolvedValue(SIP_LINES.map((line) => line.replace('TARJETA SIP', 'OH PAY VISA')))

      await service.upload({ data: Buffer.from('pdf') })

      expect(mockStatementDB.create).toHaveBeenCalledWith(expect.objectContaining({ paymentMethodId: 'oh' }))
    })

    it('should reassign the statement only to an active person', async () => {
      await service.assignPerson('s1', 'dany')
      expect(mockStatementDB.assignPerson).toHaveBeenCalledWith('s1', 'dany')

      await expect(service.assignPerson('s1', 'ghost')).rejects.toBeInstanceOf(StatementUnreadableException)
    })
  })

  describe('correcting a wrongly identified card (already loaded, no re-upload)', () => {
    const IO = { id: 'io', name: 'IO', aliases: ['interbank io'], type: 'credit_card', code: 'IO', isActive: true }
    const row = (overrides: Record<string, unknown>) => ({
      id: 'r1',
      date: new Date('2026-08-20T00:00:00Z'),
      description: 'TAMBO VIRREY',
      amount: 35.5,
      currency: 'PEN',
      installment: null,
      locked: false,
      result: StatementRowResult.NEW,
      expenseId: null,
      ...overrides,
    })

    it('should re-reconcile the rows not yet turned into an expense against the new card', async () => {
      mockStatementDB.findById.mockResolvedValue({
        ...saved([
          row({}),
          row({ id: 'r2', description: 'ALREADY BOOKED', result: StatementRowResult.CREATED, expenseId: 'kept' }),
        ]),
        paymentMethodId: 'oh',
      })
      mockPaymentMethods.findAll.mockResolvedValue([OH, IO])
      mockStatementDB.findCardExpenses.mockResolvedValue([
        { id: 'e-io', description: 'TAMBO VIRREY', amount: 35.5, processDate: null, installment: null },
      ])

      await service.update('s1', { paymentMethodId: 'io' })

      expect(mockStatementDB.changeCard).toHaveBeenCalledWith('s1', 'io', [
        { id: 'r1', result: StatementRowResult.MATCHED, expenseId: 'e-io' },
      ])
    })

    it('should leave a row already turned into a card expense untouched', async () => {
      mockStatementDB.findById.mockResolvedValue({
        ...saved([row({ result: StatementRowResult.CREATED, expenseId: 'e-oh' })]),
        paymentMethodId: 'oh',
      })
      mockPaymentMethods.findAll.mockResolvedValue([OH, IO])
      mockStatementDB.findCardExpenses.mockResolvedValue([])

      await service.update('s1', { paymentMethodId: 'io' })

      expect(mockStatementDB.changeCard).toHaveBeenCalledWith('s1', 'io', [])
    })

    it('should do nothing when the card is the same, and reject a card that is not a credit card', async () => {
      mockStatementDB.findById.mockResolvedValue({ ...saved([row({})]), paymentMethodId: 'oh' })

      await service.update('s1', { paymentMethodId: 'oh' })
      expect(mockStatementDB.changeCard).not.toHaveBeenCalled()

      mockPaymentMethods.findAll.mockResolvedValue([
        OH,
        { id: 'yape', name: 'Yape', aliases: [], type: 'wallet', code: null, isActive: true },
      ])
      await expect(service.update('s1', { paymentMethodId: 'yape' })).rejects.toBeInstanceOf(
        StatementUnreadableException,
      )
    })
  })
})
