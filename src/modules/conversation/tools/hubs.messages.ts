import { BotCommand } from '@/commons/constants/conversation.constant'

import { commandButton } from '../conversation.messages'
import { BotButton, BotReply } from '../dto/conversation.types'

// The groups of the Telegram menu (P18, D128): a short text and the commands behind it as buttons. The commands still
// work typed; the groups are only how they are found

const rows = (commands: BotCommand[], perRow = 3): BotButton[][] =>
  commands.reduce<BotButton[][]>((grouped, command, index) => {
    if (index % perRow === 0) grouped.push([])
    grouped[grouped.length - 1].push(commandButton(command))
    return grouped
  }, [])

export const HUB_TEXTS = {
  register:
    '✍️ <b>Registrar</b>\nEscribe el gasto como quieras (<i>almuerzo 25 con yape</i>), manda una captura o una nota de voz. Además:',
  query: '📊 <b>Consultar</b>\n¿Qué quieres ver?',
  payments: '📅 <b>Pagos</b>\nAvisos, lo que vence y las cuotas, y el cuadre de una tarjeta con su estado de cuenta.',
  settings: '⚙️ <b>Ajustes</b>\nLo que el bot aprendió de ti, el teclado fijo, el uso de la AI y la web.',
  help: [
    '👋 Escríbeme tus gastos y los registro.',
    '',
    '<b>Ejemplos</b>',
    '• almuerzo 25 soles con yape',
    '• uber 18.50 ayer en efectivo',
    '• netflix 45 mensual con la oh',
    '• zapatillas 300 con io en 3 cuotas',
    '• le presté 100 a dany',
    '• 📸 una captura de Yape o Plin, o la foto de un voucher',
    '• 🎙️ una nota de voz',
    '',
    'Para corregir uno que acabo de leer, empieza con la palabra: <i>monto 30</i>, <i>persona dany</i>, <i>tarjeta oh</i>, <i>categoría comida</i>, <i>ayer</i>. Si no, toca ✏️ Corregir.',
    '',
    'Todo lo demás está en el menú, en <b>siete grupos</b>. Toca uno:',
  ].join('\n'),
}

// /registrar
export const registerHub = (): BotReply => ({
  text: HUB_TEXTS.register,
  buttons: rows([
    BotCommand.QUICK,
    BotCommand.UNDO,
    BotCommand.TRIP,
    BotCommand.EDIT,
    BotCommand.KEYBOARD,
    BotCommand.DRAFTS,
  ]),
})

// /consultar
export const queryHub = (): BotReply => ({
  text: HUB_TEXTS.query,
  buttons: rows([
    BotCommand.TODAY,
    BotCommand.WEEK,
    BotCommand.SUMMARY,
    BotCommand.CARDS,
    BotCommand.BUDGET,
    BotCommand.FORECAST,
    BotCommand.RECENT,
    BotCommand.SEARCH,
    BotCommand.CHART,
    BotCommand.ASK,
    BotCommand.EXPORT,
    BotCommand.WEB,
  ]),
})

// /pagos
export const paymentsHub = (): BotReply => ({
  text: HUB_TEXTS.payments,
  buttons: rows([BotCommand.ALERTS, BotCommand.CALENDAR, BotCommand.INSTALLMENTS, BotCommand.RECONCILE]),
})

// /ajustes
export const settingsHub = (): BotReply => ({
  text: HUB_TEXTS.settings,
  buttons: rows([BotCommand.RULES, BotCommand.KEYBOARD, BotCommand.USAGE, BotCommand.WEB]),
})

// /ayuda and /start: the examples and the seven groups
export const helpHub = (): BotReply => ({
  text: HUB_TEXTS.help,
  buttons: rows(
    [
      BotCommand.REGISTER,
      BotCommand.DRAFTS,
      BotCommand.QUERY,
      BotCommand.DEBTS,
      BotCommand.PAYMENTS,
      BotCommand.SETTINGS,
    ],
    2,
  ),
})
