import { ConfigService } from '@nestjs/config'
import { vi } from 'vitest'

import { ReportsService } from '@/modules/reports/reports.service'

import { BotAction, BotCommand, ChannelMessageType } from '@/commons/constants/conversation.constant'
import { ExpenseDraftChannel } from '@/commons/constants/expense-draft.constant'

import { ChannelMessage } from '../dto/conversation.types'
import { BotToolsService } from './bot-tools.service'
import { ChartService } from './chart.service'
import { QuestionService } from './question.service'
import { QuickExpensesService } from './quick-expenses.service'
import { ReconcileService } from './reconcile.service'
import { RulesService } from './rules.service'
import { SpendingQueriesService } from './spending-queries.service'
import { TripsService } from './trips.service'
import { UndoService } from './undo.service'

const spending = { today: vi.fn(), week: vi.fn(), cards: vi.fn(), monthRows: vi.fn() }
const quick = { reply: vi.fn(), find: vi.fn() }
const undo = { prompt: vi.fn(), confirm: vi.fn(), cancel: vi.fn() }
const trips = { open: vi.fn(), close: vi.fn() }
const reconcile = { reply: vi.fn() }
const reports = { expenses: vi.fn() }
const rules = { list: vi.fn(), apply: vi.fn(), learn: vi.fn(), remove: vi.fn() }
const chart = { reply: vi.fn() }
const question = { ask: vi.fn() }
const service = new BotToolsService(
  spending as unknown as SpendingQueriesService,
  quick as unknown as QuickExpensesService,
  undo as unknown as UndoService,
  trips as unknown as TripsService,
  reconcile as unknown as ReconcileService,
  rules as unknown as RulesService,
  chart as unknown as ChartService,
  question as unknown as QuestionService,
  reports as unknown as ReportsService,
  new ConfigService({ auth: { appUrl: 'https://kogane.example/' } }),
)
const command = (name: string): ChannelMessage => ({
  channel: ExpenseDraftChannel.TELEGRAM,
  chatId: '555',
  messageId: '1',
  type: ChannelMessageType.COMMAND,
  command: name,
})

describe('BotToolsService', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('should open the group of each menu command with its buttons', async () => {
    for (const name of ['registrar', 'consultar', 'pagos', 'ajustes', 'ayuda', 'start']) {
      const [reply] = (await service.handleCommand(command(name)))!
      expect(reply.buttons?.length, name).toBeGreaterThan(0)
    }
  })

  it('should answer /hoy, /semana and /tarjetas from the spending queries', async () => {
    spending.today.mockResolvedValue({ text: 'hoy' })
    spending.week.mockResolvedValue({ text: 'semana' })
    spending.cards.mockResolvedValue({ text: 'tarjetas' })

    expect((await service.handleCommand(command('hoy')))![0].text).toBe('hoy')
    expect((await service.handleCommand(command('semana')))![0].text).toBe('semana')
    expect((await service.handleCommand(command('tarjetas')))![0].text).toBe('tarjetas')
  })

  it('should give /web link buttons to the web of the environment, not callbacks', async () => {
    const [reply] = (await service.handleCommand(command('web')))!

    const links = reply.buttons!.flat()
    expect(links.every((link) => link.url?.startsWith('https://kogane.example/'))).toBe(true)
    expect(links.map((link) => link.url)).toContain('https://kogane.example/resumen')
    expect(links.map((link) => link.url)).not.toContain('https://kogane.example//resumen')
  })

  it('should open /rapido and ask /deshacer for confirmation', async () => {
    quick.reply.mockResolvedValue({ text: 'rapido' })
    undo.prompt.mockResolvedValue({ text: 'deshacer' })

    expect((await service.handleCommand(command('rapido')))![0].text).toBe('rapido')
    expect((await service.handleCommand(command('deshacer')))![0].text).toBe('deshacer')
    expect(undo.prompt).toHaveBeenCalledWith(ExpenseDraftChannel.TELEGRAM, '555')
  })

  describe('/viaje and /fin', () => {
    it('should open a trip with the name typed and close it with /fin', async () => {
      trips.open.mockResolvedValue({ text: 'abierto' })
      trips.close.mockResolvedValue({ text: 'cerrado' })

      expect((await service.handleCommand({ ...command('viaje'), text: '/viaje Cusco 2026' }))![0].text).toBe('abierto')
      expect(trips.open).toHaveBeenCalledWith('Cusco 2026')
      expect((await service.handleCommand(command('fin')))![0].text).toBe('cerrado')
    })

    it('should ask the name of the trip and wait for it when there is none open and none was typed', async () => {
      trips.open.mockResolvedValue(null)

      const [reply] = (await service.handleCommand({ ...command('viaje'), text: '/viaje', chatId: 'v1' }))!

      expect(reply.text).toContain('¿Cómo se llama el viaje?')
      expect(service.takeAwaiting('v1')).toBe(BotCommand.TRIP)
    })
  })

  describe('/teclado', () => {
    const keyboard = async (text: string, chat = '555') =>
      (await service.handleCommand({ ...command('teclado'), chatId: chat, text }))![0].keyboard

    it('should show the fixed keyboard the first time and hide it the next, per chat', async () => {
      expect(await keyboard('/teclado', 'k1')).toBe('show')
      expect(await keyboard('/teclado', 'k2')).toBe('show')
      expect(await keyboard('/teclado', 'k1')).toBe('hide')
      expect(await keyboard('/teclado', 'k1')).toBe('show')
    })

    it('should do what it is told when it says ocultar or mostrar', async () => {
      expect(await keyboard('/teclado ocultar', 'k3')).toBe('hide')
      expect(await keyboard('/teclado mostrar', 'k3')).toBe('show')
    })
  })

  describe('/exportar', () => {
    const row = {
      date: '2026-09-02',
      description: 'Pollo',
      category: 'Comida',
      method: 'Yape',
      amount: 30,
      currency: 'PEN',
      own: 30,
    }

    it('should offer Excel and PDF for the month asked, with the month in the button', async () => {
      spending.monthRows.mockResolvedValue([row])

      const [reply] = (await service.handleCommand({ ...command('exportar'), text: '/exportar agosto 2026' }))!

      expect(spending.monthRows).toHaveBeenCalledWith(8, 2026)
      expect(reply.text).toContain('agosto 2026')
      expect(reply.buttons![0].map((button) => button.data)).toEqual(['exp:xlsx-2026-08', 'exp:pdf-2026-08'])
    })

    it('should say when the month has no expenses, and explain the format when it is not a month', async () => {
      spending.monthRows.mockResolvedValue([])
      expect(
        (await service.handleCommand({ ...command('exportar'), text: '/exportar agosto 2026' }))![0].buttons,
      ).toBeUndefined()

      const [usage] = (await service.handleCommand({ ...command('exportar'), text: '/exportar hola' }))!
      expect(usage.text).toContain('/exportar agosto')
    })

    it('should send the file of the button, and nothing for a button that is not valid', async () => {
      spending.monthRows.mockResolvedValue([row])
      reports.expenses.mockResolvedValue({ filename: 'gastos-2026-08.xlsx', mimeType: 'x', data: Buffer.from('x') })

      const reply = await service.exportFile({ name: BotAction.EXPORT, draftId: 'xlsx-2026-08' })

      expect(reports.expenses).toHaveBeenCalledWith('xlsx', { month: 8, year: 2026 }, [row])
      expect(reply).toEqual(expect.objectContaining({ text: '📎 gastos-2026-08.xlsx' }))
      expect(await service.exportFile({ name: BotAction.EXPORT, draftId: 'doc-2026-08' })).toBeNull()
    })
  })

  describe('/cuadre, /grafico, /pregunta and /reglas', () => {
    it('should wait for the card when /cuadre does not know it', async () => {
      reconcile.reply.mockResolvedValue({ reply: { text: '¿Qué tarjeta?' }, asksCard: true })

      await service.handleCommand({ ...command('cuadre'), text: '/cuadre' })

      expect(service.takeAwaiting('555')).toBe(BotCommand.RECONCILE)
    })

    it('should not wait when /cuadre answered', async () => {
      reconcile.reply.mockResolvedValue({ reply: { text: 'cuadra' }, asksCard: false })

      const [reply] = (await service.handleCommand({ ...command('cuadre'), text: '/cuadre cmr' }))!

      expect(reconcile.reply).toHaveBeenCalledWith('cmr')
      expect(reply.text).toBe('cuadra')
      expect(service.takeAwaiting('555')).toBeNull()
    })

    it('should pass the month to /grafico', async () => {
      chart.reply.mockResolvedValue({ text: 'donut' })

      await service.handleCommand({ ...command('grafico'), text: '/grafico agosto' })

      expect(chart.reply).toHaveBeenCalledWith('agosto')
    })

    it('should ask the question, or ask for it and wait when the command came from a button', async () => {
      question.ask.mockResolvedValue({ text: 'respuesta' })

      const [answer] = (await service.handleCommand({
        ...command('pregunta'),
        text: '/pregunta cuánto gasté en comida',
      }))!
      expect(question.ask).toHaveBeenCalledWith('cuánto gasté en comida')
      expect(answer.text).toBe('respuesta')

      const [ask] = (await service.handleCommand({ ...command('pregunta'), text: '/pregunta' }))!
      expect(ask.text).toContain('Pregúntame')
      expect(service.takeAwaiting('555')).toBe(BotCommand.ASK)
      expect(question.ask).toHaveBeenCalledTimes(1)
    })

    it('should list the rules', async () => {
      rules.list.mockResolvedValue({ text: 'reglas' })

      expect((await service.handleCommand(command('reglas')))![0].text).toBe('reglas')
    })
  })

  it('should not know the commands that are not its own', async () => {
    expect(await service.handleCommand(command('deudas'))).toBeNull()
  })

  describe('the text a command waits for', () => {
    it('should give the waiting command once, and only to the chat that asked', () => {
      service.await('555', BotCommand.SEARCH)

      expect(service.takeAwaiting('777')).toBeNull()
      expect(service.takeAwaiting('555')).toBe(BotCommand.SEARCH)
      expect(service.takeAwaiting('555')).toBeNull()
    })

    it('should forget it after 10 minutes, or when another command runs', () => {
      vi.useFakeTimers()
      service.await('555', BotCommand.ASK)
      vi.advanceTimersByTime(10 * 60_000 + 1)
      expect(service.takeAwaiting('555')).toBeNull()

      service.await('555', BotCommand.ASK)
      service.clearAwaiting('555')
      expect(service.takeAwaiting('555')).toBeNull()
    })
  })
})
