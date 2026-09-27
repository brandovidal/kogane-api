export enum ChannelMessageType {
  TEXT = 'text',
  IMAGE = 'image', // photo or image file; its caption travels as text
  AUDIO = 'audio', // voice note or audio file: transcribed, then read as text
  COMMAND = 'command',
  ACTION = 'action',
}

// Inline button actions. Values travel inside Telegram callback_data (max 64 bytes).
export enum BotAction {
  SAVE = 'ok',
  EDIT = 'edit',
  LATER = 'later', // 📝 Borrador: keep it to review later
  DISCARD = 'no',
  SET_FIELD = 'set',
  RESUME = 're', // /borrador: reopen a pending or failed expense
  NEW_PAYMENT_METHOD = 'new', // create the payment method the user typed
  // Debt payments (P17): "<action>:<batchId>[:<debtId>]"; the batch groups the payments of one message
  PAY_CONFIRM = 'pay',
  PAY_LIST = 'payl', // ✏️ Elegir cuota
  PAY_PICK = 'payp',
  PAY_CANCEL = 'payx',
  // Lists of screenshots (P21): "<action>:<batchId>"
  SAVE_ALL = 'all',
  REVIEW_ALL = 'each',
  LATER_ALL = 'park',
  // Command buttons of the help: "cmd:<command>" runs it as if it was typed
  COMMAND = 'cmd',
  // D66: installment amount only deduced (total / n) → confirm it before creating the n rows, or type another one
  INSTALLMENTS_OK = 'cuo',
  INSTALLMENTS_EDIT = 'cuoe',
  // /deudas: "rep:<format>-<personId|all>" sends the debts report as Excel or PDF (D39)
  REPORT = 'rep',
  // Split message of a shared expense (D75): "shr:<draftId>:<person index>:<ShareChoice>"
  SHARE = 'shr',
  // /editar (D76): "eds:<draftId>" of the saved expense to edit
  EDIT_SAVED = 'eds',
  // Reminders (P20, D86): "ntf:<notificationId>:<NotificationOp>" (✅ Pagado · ✏️ Editar monto · 🔕 Silenciar)
  NOTIFY = 'ntf',
  // /avisos: "ntfs:<NotificationKind>" turns that kind on or off in Telegram
  NOTIFY_SETTING = 'ntfs',
  // Tools of the menu groups (P18, D128): "qk:<key>" saves a quick expense · "und:<draftId>" confirms /deshacer ·
  // "unx:<draftId>" keeps it · "rul:<ruleId>" forgets a learned rule · "exp:<format>-<yyyy-mm>" sends the month
  QUICK = 'qk',
  UNDO = 'und',
  UNDO_CANCEL = 'unx',
  RULE_DELETE = 'rul',
  EXPORT = 'exp',
}

// Buttons of the tools (P18): handled by BotToolsService
export const TOOL_ACTIONS: string[] = [
  BotAction.QUICK,
  BotAction.UNDO,
  BotAction.UNDO_CANCEL,
  BotAction.RULE_DELETE,
  BotAction.EXPORT,
]

export const NOTIFICATION_ACTIONS: string[] = [BotAction.NOTIFY, BotAction.NOTIFY_SETTING]

export const BATCH_ACTIONS: string[] = [BotAction.SAVE_ALL, BotAction.REVIEW_ALL, BotAction.LATER_ALL]

export const DEBT_PAYMENT_ACTIONS: string[] = [
  BotAction.PAY_CONFIRM,
  BotAction.PAY_LIST,
  BotAction.PAY_PICK,
  BotAction.PAY_CANCEL,
]

export enum BotCommand {
  START = 'start',
  HELP = 'ayuda',
  CANCEL = 'cancelar',
  RECENT = 'ultimos',
  SUMMARY = 'resumen',
  DRAFTS = 'borrador',
  USAGE = 'uso',
  DEBTS = 'deudas', // /deudas [persona]
  COLLECT = 'cobrar', // /cobrar <persona>
  BUDGET = 'presupuesto', // /presupuesto [mes] [año] (P19)
  FORECAST = 'pronostico', // /pronostico: this month at the current pace (P19)
  EDIT = 'editar', // /editar <texto>: find a saved expense and edit it (D76)
  ALERTS = 'avisos', // /avisos: which reminders reach Telegram (P20)
  CALENDAR = 'calendario', // /calendario: what is due in the next 14 days (P20)
  INSTALLMENTS = 'cuotas', // /cuotas: card installments of the next 3 months (P20)
  // The groups of the Telegram menu (P18, D128): each opens buttons with the commands below
  REGISTER = 'registrar',
  QUERY = 'consultar',
  PAYMENTS = 'pagos',
  SETTINGS = 'ajustes',
  // Inside the groups: they work typed too, but the menu does not list them
  TODAY = 'hoy',
  WEEK = 'semana',
  CARDS = 'tarjetas', // total of the current cycle of each card, with its closing and payment days
  SEARCH = 'buscar', // /buscar <text>: saved expenses by concept, merchant or person
  EXPORT = 'exportar', // /exportar [mes] [año]: Excel or PDF of the month
  CHART = 'grafico', // /grafico [mes] [año]: donut by category
  ASK = 'pregunta', // /pregunta <text>: the only command that uses the AI (one predefined query)
  QUICK = 'rapido', // your 6 most repeated expenses, one tap
  TRIP = 'viaje', // /viaje <name>: tags every expense until /fin
  TRIP_END = 'fin',
  UNDO = 'deshacer', // cancels the last saved expense
  KEYBOARD = 'teclado', // shows or hides the fixed keyboard
  RULES = 'reglas', // what the bot learned from your corrections
  RECONCILE = 'cuadre', // /cuadre <tarjeta>: the last statement against what you registered
  WEB = 'web', // links to kogane-app
}

// The fixed keyboard under the chat (/teclado): the text of each key arrives as a message and runs its command
export const KEYBOARD_COMMANDS: Record<string, BotCommand> = {
  '⚡ Rápido': BotCommand.QUICK,
  '📝 Borrador': BotCommand.DRAFTS,
  '📊 Consultar': BotCommand.QUERY,
}

// What Telegram's menu shows: seven groups instead of every command (P18, D128). The rest keep working typed and sit
// behind the buttons of each group
export const BOT_MENU_COMMANDS: BotCommand[] = [
  BotCommand.REGISTER,
  BotCommand.DRAFTS,
  BotCommand.QUERY,
  BotCommand.DEBTS,
  BotCommand.PAYMENTS,
  BotCommand.SETTINGS,
  BotCommand.HELP,
]

// Descriptions shown in the Telegram command menu (Spanish: user-facing)
export const BOT_COMMAND_DESCRIPTIONS: Record<BotCommand, string> = {
  [BotCommand.START]: 'Empezar y ver ejemplos',
  [BotCommand.HELP]: 'Cómo registrar gastos',
  [BotCommand.CANCEL]: 'Descartar el borrador abierto',
  [BotCommand.RECENT]: 'Últimos gastos guardados',
  [BotCommand.SUMMARY]: 'Total del mes',
  [BotCommand.DRAFTS]: 'Gastos pendientes de revisar',
  [BotCommand.USAGE]: 'Uso de la AI hoy',
  [BotCommand.DEBTS]: 'Me deben y le debo, por persona',
  [BotCommand.COLLECT]: 'Mensaje para cobrarle a una persona',
  [BotCommand.BUDGET]: 'Gastado vs límite por categoría y excedente',
  [BotCommand.FORECAST]: 'A este ritmo, qué categorías se pasan',
  [BotCommand.EDIT]: 'Buscar un gasto guardado y editarlo',
  [BotCommand.ALERTS]: 'Qué avisos te llegan por Telegram',
  [BotCommand.CALENDAR]: 'Pagos de los próximos 14 días',
  [BotCommand.INSTALLMENTS]: 'Cuotas de tarjeta de los próximos meses',
  [BotCommand.REGISTER]: 'Registrar: rápido, viaje, deshacer, editar',
  [BotCommand.QUERY]: 'Consultar: hoy, semana, mes, tarjetas, gráfico…',
  [BotCommand.PAYMENTS]: 'Pagos: avisos, calendario, cuotas y cuadre',
  [BotCommand.SETTINGS]: 'Ajustes: reglas, teclado, uso de la AI y web',
  [BotCommand.TODAY]: 'Gastos de hoy',
  [BotCommand.WEEK]: 'Gastos de los últimos 7 días',
  [BotCommand.CARDS]: 'Total del ciclo de cada tarjeta',
  [BotCommand.SEARCH]: 'Buscar un gasto guardado',
  [BotCommand.EXPORT]: 'Excel o PDF del mes',
  [BotCommand.CHART]: 'Gráfico de gastos por categoría',
  [BotCommand.ASK]: 'Preguntar sobre tus gastos',
  [BotCommand.QUICK]: 'Tus gastos más repetidos, un toque',
  [BotCommand.TRIP]: 'Etiquetar los gastos de un viaje',
  [BotCommand.TRIP_END]: 'Cerrar el viaje y ver el total',
  [BotCommand.UNDO]: 'Anular el último gasto guardado',
  [BotCommand.KEYBOARD]: 'Mostrar u ocultar el teclado fijo',
  [BotCommand.RULES]: 'Reglas que aprendí de tus correcciones',
  [BotCommand.RECONCILE]: 'Cuadrar una tarjeta con su estado de cuenta',
  [BotCommand.WEB]: 'Abrir Kogane en la web',
}

export const CALLBACK_SEPARATOR = ':'

// pendingField value after ✏️ Corregir: the next message goes to the AI with the draft
export const FREE_CORRECTION_FIELD = 'free_correction'

// pendingField value while the bot asks the closing and due days of a new credit card: "card_days:<paymentMethodId>"
export const CARD_DAYS_FIELD_PREFIX = 'card_days:'

// Payment method names typed by the user travel in callback_data: keep them short (64 bytes in total)
export const MAX_NEW_PAYMENT_METHOD_NAME_BYTES = 20

// Short codes for the field in "set" callbacks
export const FIELD_CODES = {
  destination: 'd',
  period: 'pe',
  paymentMethodId: 'pm',
  categoryId: 'cat',
  personId: 'p',
} as const

export const MAX_QUICK_REPLIES = 10
export const QUICK_REPLIES_PER_ROW = 2
export const RECENT_EXPENSES_LIMIT = 5
export const DRAFTS_LIMIT = 5

// ✏️ Elegir cuota shows at most this many installments
export const MAX_INSTALLMENT_BUTTONS = 10

// Images sent as files (documents) above this size are rejected before downloading (photos are already compressed)
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

// Voice notes longer than this are rejected before downloading: an expense takes a few seconds to say
export const MAX_AUDIO_SECONDS = 60
