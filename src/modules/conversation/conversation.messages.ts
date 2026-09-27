// User-facing texts are in Spanish (D11): everything else in this file is English.
import {
  BotAction,
  BotCommand,
  MAX_NEW_PAYMENT_METHOD_NAME_BYTES,
  MAX_QUICK_REPLIES,
  QUICK_REPLIES_PER_ROW,
} from '@/commons/constants/conversation.constant'
import { PaymentMethodType } from '@/commons/constants/catalog.constant'
import { ExpenseDraftStatus } from '@/commons/constants/expense-draft.constant'
import {
  Currency,
  DEBT_DESTINATIONS,
  ExpenseDestination,
  ExpenseType,
  SubscriptionPeriod,
} from '@/commons/constants/expense.constant'
import { CatalogKind, ExpenseField } from '@/commons/constants/expense-extraction.constant'
import { PaymentPeriod } from '@/commons/helpers/payment-period.helper'
import { ExpenseDraftDbDto } from '@/db/models/expense-draft/expenseDraftDB.dto'
import { MonthlyTotalDbDto } from '@/db/models/expense/expenseDB.dto'
import { botPaymentMethods, findCatalogEntryById } from '@/modules/expense-extraction/expense-extraction.catalog'
import { AiModelUsage, ExtractionCatalog } from '@/modules/expense-extraction/dto/expense-extraction.types'

import { encodeBotAction } from './bot-action.codec'
import { lowConfidenceFieldsOf } from './expense-draft.mapper'
import { sharesOf } from './shared-expense.parser'
import { BotButton, BotReply, InstallmentsCreated } from './dto/conversation.types'

export const DESTINATION_LABELS: Record<ExpenseDestination, string> = {
  [ExpenseDestination.DAILY]: 'Día a día',
  [ExpenseDestination.FIXED_COST]: 'Costo fijo',
  [ExpenseDestination.SUBSCRIPTION]: 'Plataforma',
  [ExpenseDestination.CREDIT_CARD]: 'Tarjeta',
  [ExpenseDestination.RECEIVABLE]: 'Me deben',
  [ExpenseDestination.PAYABLE]: 'Le debo',
  [ExpenseDestination.DISCARD]: 'No es gasto',
}

const EXPENSE_TYPE_LABELS: Record<ExpenseType, string> = {
  [ExpenseType.ESSENTIAL]: 'Esencial',
  [ExpenseType.GUILTY_PLEASURE]: 'Con culpa',
}

const PAYMENT_TYPE_LABELS: Record<PaymentMethodType, string> = {
  [PaymentMethodType.DEBIT_CARD]: 'Débito',
  [PaymentMethodType.WALLET]: 'Billetera',
  [PaymentMethodType.CREDIT_CARD]: 'Tarjeta de crédito',
  [PaymentMethodType.CASH]: 'Efectivo',
  [PaymentMethodType.BANK_TRANSFER]: 'Transferencia',
}

const PERIOD_LABELS: Record<SubscriptionPeriod, string> = {
  [SubscriptionPeriod.BIWEEKLY]: 'Quincenal',
  [SubscriptionPeriod.MONTHLY]: 'Mensual',
  [SubscriptionPeriod.QUARTERLY]: 'Trimestral',
  [SubscriptionPeriod.SEMIANNUAL]: 'Semestral',
  [SubscriptionPeriod.ANNUAL]: 'Anual',
}

export const TEXTS = {
  failed: '⚠️ No pude procesar el mensaje ahora. Lo dejé en /borrador para reintentarlo.',
  interrupted: (count: number) =>
    count === 1
      ? '⚠️ Me reinicié mientras procesaba un mensaje. Lo dejé en /borrador para retomarlo.'
      : `⚠️ Me reinicié mientras procesaba ${count} mensajes. Los dejé en /borrador para retomarlos.`,
  audioTooLong: (maxSeconds: number) => `🎙️ El audio es muy largo. Mándame uno de hasta ${maxSeconds} segundos.`,
  emptyAudio: '🎙️ No entendí el audio. Prueba de nuevo o escríbelo.',
  heard: (transcript: string) => `🎙️ Entendí: <i>«${escapeHtml(transcript)}»</i>`,
  duplicateAudio: '🎙️ Ya recibí este audio antes. Búscalo en /ultimos o /borrador.',
  fileExpired: '📎 La captura ya expiró (7 días). Mándala otra vez.',
  duplicateImage: '🖼️ Ya recibí esta imagen antes. Búscala en /ultimos o /borrador.',
  imageTooLarge: '🖼️ La imagen pesa demasiado. Envíala como foto (no como archivo) o una captura más liviana.',
  // Two overlapping screenshots with the same movement (P21)
  possibleRepeat: (concept: string, amount: string, date: string) =>
    `⚠️ Parece repetido: ya hay <b>${escapeHtml(concept)}</b> de ${amount} con esa tarjeta el ${date}.`,
  possibleDuplicate: (operationNumber: string) =>
    `⚠️ Parece que ya registraste este gasto (operación <b>${escapeHtml(operationNumber)}</b>).`,
  notAnExpense: '🤔 No encontré un gasto en tu mensaje. Prueba con algo como <i>almuerzo 25 soles con yape</i>.',
  askCorrection: '✏️ Escribe la corrección como quieras (ej: <i>eran 30 soles y fue con la oh</i>).',
  askInstallmentAmount: '✏️ ¿Cuánto es cada cuota? (ej: <i>170.50</i>)',
  askShare: (name: string) => `✏️ ¿Cuánto te debe ${escapeHtml(name)}? (ej: <i>20</i>, <i>30%</i> o <i>la mitad</i>)`,
  notShared: '👥 Ya no se comparte: se guardará completo a tu nombre.',
  shareReplaced: '↩️ Reparto actualizado abajo.',
  shareTooMuch: (name: string, total: string) =>
    `${escapeHtml(name)} no puede deber más que el total (${total}). Escribe un monto, un porcentaje (<i>30%</i>) o <i>la mitad</i>.`,
  shareNotUnderstood:
    'No entendí la parte. Escribe un monto (<i>20</i>), un porcentaje (<i>30%</i>) o <i>la mitad</i>.',
  editUsage:
    '🔎 Dime qué gasto buscar: el concepto, la persona, el monto o la fecha. Por ejemplo <i>netflix</i>, <i>dany 64</i> o <i>io 22/09</i>.',
  editCancelled: '❌ <b>Edición cancelada</b>. El gasto quedó como estaba.',
  editLocked: '🔒 Ese gasto tiene deudas con abonos: edita la deuda en la web (Préstamos y deudas).',
  unreadable: (names: string[]) =>
    `⚠️ No pude leer: ${names.map(escapeHtml).join(', ')}. Mándalos en otra captura o escríbelos.`,
  receivedNotDebt: (sender: string, amount: number, currency: string | null) =>
    `💸 Recibiste ${formatAmount(amount, currency)} de <b>${escapeHtml(sender)}</b>: no es un gasto y no tiene deudas pendientes contigo.`,
  correctionFailed: '⚠️ No pude aplicar la corrección. Prueba con <i>monto 30</i> o <i>persona dany</i>.',
  alreadyProcessed: 'Este gasto ya fue procesado',
  saved: 'Guardado',
  cancelled: (count: number) => (count ? '🗑️ Descarté el borrador abierto.' : 'No hay ningún borrador abierto.'),
  noRecent: 'Todavía no guardaste gastos desde aquí.',
  noTotals: 'No hay gastos registrados este mes.',
  emptyDrafts: '📝 No hay nada pendiente en Borrador.',
  draftsHeader: (shown: number, total: number) =>
    `📝 <b>Borrador</b> (${total})${total > shown ? ` · mostrando los ${shown} más recientes` : ''}`,
  resumed: 'Retomado',
  failedExtraction: '(la AI no pudo leerlo)',
  askCardDays:
    '💳 ¿Qué día cierra la facturación y qué día vence el pago? (ej: <i>cierre 15, pago 5</i> o <i>15 5</i>)',
  cardDaysSaved: (name: string) => `✅ Guardé los días de <b>${escapeHtml(name)}</b>.`,
  cardDaysInvalid: 'No entendí los días. Escribe dos números del 1 al 31, por ejemplo <i>cierre 15, pago 5</i>.',
  paymentMethodCreated: (name: string) => `✅ Agregué <b>${escapeHtml(name)}</b> a tus medios de pago.`,
  paymentMethodNotAdded: 'Listo, no lo agregué. Elige uno de la lista o escríbelo de nuevo.',
  batchSaved: (saved: number, parked: number) =>
    [
      saved ? `✅ Guardé ${saved} ${saved === 1 ? 'gasto' : 'gastos'}.` : null,
      parked ? `📝 ${parked} ${parked === 1 ? 'quedó' : 'quedaron'} en /borrador (repetidos o incompletos).` : null,
      'Ver: /ultimos · /resumen',
    ]
      .filter(Boolean)
      .join('\n'),
  batchParked: (count: number) => `📝 Dejé ${count} gastos en /borrador. Retómalos cuando quieras.`,
  batchReview: '👇 Revisa cada uno:',
}

// "❓ falta categoría" in the list of screenshots
const FIELD_NAMES: Partial<Record<ExpenseField, string>> = {
  [ExpenseField.DESTINATION]: 'destino',
  [ExpenseField.DESCRIPTION]: 'concepto',
  [ExpenseField.AMOUNT]: 'monto',
  [ExpenseField.PERSON]: 'persona',
  [ExpenseField.PAYMENT_METHOD]: 'medio de pago',
  [ExpenseField.CATEGORY]: 'categoría',
  [ExpenseField.PERIOD]: 'período',
}

const QUESTIONS: Partial<Record<ExpenseField, string>> = {
  [ExpenseField.DESTINATION]: '¿Qué tipo de gasto es?',
  [ExpenseField.DESCRIPTION]: '¿Cuál es el concepto? (ej: <i>Almuerzo</i>, <i>Netflix</i>)',
  [ExpenseField.AMOUNT]: '¿Cuánto fue? (ej: <i>25.50</i>)',
  [ExpenseField.CATEGORY]: '¿Qué categoría?',
  [ExpenseField.PAYMENT_METHOD]: '¿Con qué pagaste? (elige o escríbelo)',
  [ExpenseField.PERIOD]: '¿Cada cuánto se paga?',
}

export const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function formatAmount(amount: number | null, currency: string | null): string {
  if (amount == null) return '—'
  const symbol = currency === Currency.USD ? 'US$' : 'S/'
  return `${symbol} ${amount.toFixed(2)}`
}

const formatDate = (date: Date | null) => (date ? date.toISOString().slice(0, 10).split('-').reverse().join('/') : '—')

export const nameOf = (catalog: ExtractionCatalog, id: string | null) =>
  escapeHtml(findCatalogEntryById(catalog, id)?.name ?? '—')

export function formatSummary(expenseDraft: ExpenseDraftDbDto, catalog: ExtractionCatalog): string {
  const doubtful = new Set(lowConfidenceFieldsOf(expenseDraft))
  const mark = (field: ExpenseField) => (doubtful.has(field) ? ' ❓' : '')

  const payment = `💳 ${nameOf(catalog, expenseDraft.paymentMethodId)}${mark(ExpenseField.PAYMENT_METHOD)}`

  const details = [
    formatDate(expenseDraft.spentAt),
    expenseDraft.destination ? DESTINATION_LABELS[expenseDraft.destination as ExpenseDestination] : null,
    expenseDraft.expenseType ? EXPENSE_TYPE_LABELS[expenseDraft.expenseType as ExpenseType] : null,
    expenseDraft.period ? PERIOD_LABELS[expenseDraft.period as SubscriptionPeriod] : null,
    expenseDraft.installment ? `Cuota ${expenseDraft.installment}` : null,
  ].filter(Boolean)

  return [
    `🧾 <b>${escapeHtml(expenseDraft.description ?? 'Sin concepto')}</b>${mark(ExpenseField.DESCRIPTION)} — ${formatAmount(expenseDraft.amount, expenseDraft.currency)}${mark(ExpenseField.AMOUNT)}${expenseDraft.sharedWith ? ' (pagas tú)' : ''}`,
    `👤 ${nameOf(catalog, expenseDraft.personId)}${mark(ExpenseField.PERSON)}   ${payment}   📂 ${nameOf(catalog, expenseDraft.categoryId)}${mark(ExpenseField.CATEGORY)}`,
    `📅 ${details.join(' · ')}`,
  ].join('\n')
}

const button = (label: string, name: BotAction, draftId: string, field?: string, value?: string): BotButton => ({
  label,
  data: encodeBotAction({ name, draftId, field, value }),
})

const toRows = (buttons: BotButton[]) =>
  buttons.reduce<BotButton[][]>((rows, current, index) => {
    if (index % QUICK_REPLIES_PER_ROW === 0) rows.push([])
    rows[rows.length - 1].push(current)
    return rows
  }, [])

const COMMAND_BUTTON_LABELS: Partial<Record<BotCommand, string>> = {
  [BotCommand.DRAFTS]: '📝 Borrador',
  [BotCommand.RECENT]: '🧾 Últimos',
  [BotCommand.SUMMARY]: '📊 Resumen',
  [BotCommand.USAGE]: '🤖 Uso de la AI',
  [BotCommand.CANCEL]: '✖️ Cancelar',
  [BotCommand.BUDGET]: '💰 Presupuesto',
  [BotCommand.CALENDAR]: '📅 Calendario',
  [BotCommand.INSTALLMENTS]: '💳 Cuotas',
  [BotCommand.ALERTS]: '🔔 Avisos',
  [BotCommand.REGISTER]: '✍️ Registrar',
  [BotCommand.QUERY]: '📊 Consultar',
  [BotCommand.PAYMENTS]: '📅 Pagos',
  [BotCommand.SETTINGS]: '⚙️ Ajustes',
  [BotCommand.DEBTS]: '💸 Deudas',
  [BotCommand.TODAY]: '📅 Hoy',
  [BotCommand.WEEK]: '🗓️ Semana',
  [BotCommand.CARDS]: '💳 Tarjetas',
  [BotCommand.FORECAST]: '🔮 Pronóstico',
  [BotCommand.SEARCH]: '🔎 Buscar',
  [BotCommand.EXPORT]: '📥 Exportar',
  [BotCommand.CHART]: '📈 Gráfico',
  [BotCommand.ASK]: '❓ Pregunta',
  [BotCommand.QUICK]: '⚡ Rápido',
  [BotCommand.TRIP]: '✈️ Viaje',
  [BotCommand.TRIP_END]: '🏁 Cerrar viaje',
  [BotCommand.UNDO]: '↩️ Deshacer',
  [BotCommand.KEYBOARD]: '⌨️ Teclado',
  [BotCommand.RULES]: '🧠 Reglas',
  [BotCommand.RECONCILE]: '✅ Cuadre',
  [BotCommand.EDIT]: '✏️ Editar',
  [BotCommand.COLLECT]: '💬 Cobrar',
}

export const commandButton = (command: BotCommand) =>
  button(COMMAND_BUTTON_LABELS[command] ?? `/${command}`, BotAction.COMMAND, command)

// One row of buttons that run commands (cmd:<command>)
export const commandButtons = (...commands: BotCommand[]): BotButton[][] => [commands.map(commandButton)]

// Commands a reply mentions that get a button (/deudas and /cobrar need a name, so they stay as text)
const LINKED_COMMANDS = [BotCommand.DRAFTS, BotCommand.RECENT, BotCommand.SUMMARY]
const COMMAND_LINK_LINE = /\n?Ver: \/\w+(?: · \/\w+)*\s*$/

// A new message without buttons that mentions /borrador, /ultimos or /resumen gets them as buttons; a trailing
// "Ver: /ultimos · /resumen" line is replaced by them. Edited summaries and replies with buttons stay as they are.
export function withCommandButtons(reply: BotReply): BotReply {
  if (reply.buttons?.length || reply.edit) return reply
  const commands = LINKED_COMMANDS.filter((command) => new RegExp(`/${command}\\b`).test(reply.text))
  if (!commands.length) return reply
  return { ...reply, text: reply.text.replace(COMMAND_LINK_LINE, ''), buttons: commandButtons(...commands) }
}

function quickReplies(field: ExpenseField, draftId: string, catalog: ExtractionCatalog): BotButton[] {
  const set = (label: string, value: string) => button(label, BotAction.SET_FIELD, draftId, field, value)
  const fromCatalog = (kind: CatalogKind) =>
    catalog.entries
      .filter((entry) => entry.kind === kind)
      .slice(0, MAX_QUICK_REPLIES)
      .map((entry) => set(entry.name, entry.id))

  switch (field) {
    case ExpenseField.DESTINATION:
      return Object.values(ExpenseDestination)
        .filter((destination) => destination !== ExpenseDestination.DISCARD)
        .map((destination) => set(DESTINATION_LABELS[destination], destination))
    case ExpenseField.PERIOD:
      return Object.values(SubscriptionPeriod).map((period) => set(PERIOD_LABELS[period], period))
    case ExpenseField.PAYMENT_METHOD:
      return botPaymentMethods(catalog)
        .slice(0, MAX_QUICK_REPLIES)
        .map((entry) => set(entry.name, entry.id))
    case ExpenseField.CATEGORY:
      return fromCatalog(CatalogKind.CATEGORY)
    default:
      return []
  }
}

// Summary plus the next question (draft) or the confirmation buttons (awaiting_confirmation)
export function buildExpenseReply(expenseDraft: ExpenseDraftDbDto, catalog: ExtractionCatalog, edit = false): BotReply {
  const summary = formatSummary(expenseDraft, catalog)
  const field = expenseDraft.pendingField as ExpenseField | null

  if (field && QUESTIONS[field]) {
    const replies = quickReplies(field, expenseDraft.id, catalog)
    return {
      text: `${summary}\n\n${QUESTIONS[field]}`,
      buttons: [...toRows(replies), [button('❌ Descartar', BotAction.DISCARD, expenseDraft.id)]],
      edit,
    }
  }

  // /editar (D76): the copy of a saved expense is saved over it or dropped, never sent to Borrador
  if (expenseDraft.status === ExpenseDraftStatus.EDITING) {
    return {
      text: `✏️ <b>Editando</b>\n${summary}`,
      buttons: [
        [
          button('✅ Guardar cambios', BotAction.SAVE, expenseDraft.id),
          button('✏️ Editar', BotAction.EDIT, expenseDraft.id),
        ],
        [button('❌ Cancelar', BotAction.DISCARD, expenseDraft.id)],
      ],
      edit,
    }
  }

  return {
    text: summary,
    buttons: [
      [button('✅ Guardar', BotAction.SAVE, expenseDraft.id), button('✏️ Editar', BotAction.EDIT, expenseDraft.id)],
      [
        button('📝 Borrador', BotAction.LATER, expenseDraft.id),
        button('❌ Descartar', BotAction.DISCARD, expenseDraft.id),
      ],
    ],
    edit,
  }
}

// ==================== Shared expenses (D73, D75) ====================

// Buttons of each person in the split message: "shr:<draftId>:<person index>:<value>"
export enum ShareChoice {
  HALF = 'h',
  THIRD = 't',
  TWENTY = 'p20',
  AMOUNT = 'm', // asks the amount or percentage in the next message
  REMOVE = 'x',
}

export const SHARE_CHOICE_RATIOS: Partial<Record<ShareChoice, number>> = {
  [ShareChoice.HALF]: 1 / 2,
  [ShareChoice.THIRD]: 1 / 3,
  [ShareChoice.TWENTY]: 0.2,
}

const percentOf = (part: number, total: number) => (total ? `${Math.round((part / total) * 100)} %` : '')

// The second message of a shared expense (D75): what each person will owe, editable apart from the expense;
// ✅ Guardar of the expense saves both
export function buildShareReply(expenseDraft: ExpenseDraftDbDto, catalog: ExtractionCatalog, edit = false): BotReply {
  const { sharedWith, amount, currency } = expenseDraft
  const total = amount ?? 0
  const { parts, own } = sharesOf(total, sharedWith ?? { shares: [] })
  const lines = parts.map(
    (part) =>
      `• ${nameOf(catalog, part.personId)} te debe ${formatAmount(part.amount, currency)} (${percentOf(part.amount, total)})`,
  )
  const each = expenseDraft.installment ? ' por cuota' : ''
  return {
    text: [
      `👥 <b>Reparto</b>: pagas tú ${formatAmount(total, currency)}${each}`,
      ...lines,
      `Tu parte: ${formatAmount(own, currency)}`,
      '<i>Se guarda con ✅ Guardar del gasto.</i>',
    ].join('\n'),
    trackShareOf: expenseDraft.id,
    // Two rows per person, so the name is not cut: "Danery ½ · ⅓ · 20 %" and "✏️ Editar · 🗑️ Quitar"
    buttons: parts.flatMap((part, index) => {
      const choice = (label: string, value: ShareChoice) =>
        button(label, BotAction.SHARE, expenseDraft.id, String(index), value)
      const name = findCatalogEntryById(catalog, part.personId)?.name ?? '—'
      return [
        [choice(`${name} ½`, ShareChoice.HALF), choice('⅓', ShareChoice.THIRD), choice('20 %', ShareChoice.TWENTY)],
        [choice(`✏️ Editar (${name})`, ShareChoice.AMOUNT), choice(`🗑️ Quitar (${name})`, ShareChoice.REMOVE)],
      ]
    }),
    edit,
  }
}

// The split message once the expense is closed (D75): what was saved, without buttons
export function buildClosedShareReply(
  expenseDraft: ExpenseDraftDbDto,
  catalog: ExtractionCatalog,
  target: { editMessageId?: string; edit?: boolean },
): BotReply {
  const { sharedWith, amount, currency, status } = expenseDraft
  const total = amount ?? 0
  const { parts, own } = sharesOf(total, sharedWith ?? { shares: [] })
  const title =
    status === ExpenseDraftStatus.SAVED
      ? '✅ <b>Reparto guardado</b>'
      : status === ExpenseDraftStatus.PENDING_REVIEW
        ? '📝 <b>Reparto en borrador</b>'
        : '❌ <b>Reparto descartado</b>'
  return {
    text: [
      title,
      ...parts.map(
        (part) =>
          `• ${nameOf(catalog, part.personId)} te debe ${formatAmount(part.amount, currency)} (${percentOf(part.amount, total)})`,
      ),
      `Tu parte: ${formatAmount(own, currency)}`,
    ].join('\n'),
    ...target,
  }
}

// "Danery te debe S/ 32.00" for the saved notice
export function formatSharedDebts(expenseDraft: ExpenseDraftDbDto, catalog: ExtractionCatalog): string | null {
  if (!expenseDraft.sharedWith || expenseDraft.amount == null) return null
  const { parts } = sharesOf(expenseDraft.amount, expenseDraft.sharedWith)
  const debts = parts
    .filter((part) => part.amount > 0)
    .map((part) => `${nameOf(catalog, part.personId)} te debe ${formatAmount(part.amount, expenseDraft.currency)}`)
  return debts.length ? debts.join(' · ') : null
}

// ==================== /editar (D76) ====================

export function buildSavedSearchReply(
  results: ExpenseDraftDbDto[],
  query: string,
  catalog: ExtractionCatalog,
): BotReply {
  if (!results.length) return { text: `🔎 No encontré gastos guardados con «${escapeHtml(query)}».` }
  const lines = results.map(
    (expenseDraft, index) =>
      `${index + 1}. ${formatDate(expenseDraft.spentAt)} <b>${escapeHtml(expenseDraft.description ?? 'Sin concepto')}</b> — ${formatAmount(expenseDraft.amount, expenseDraft.currency)} · ${expenseDraft.destination ? DESTINATION_LABELS[expenseDraft.destination as ExpenseDestination] : ''} · ${nameOf(catalog, expenseDraft.paymentMethodId)}`,
  )
  return {
    text: ['🔎 <b>¿Cuál editas?</b>', ...lines].join('\n'),
    buttons: [results.map((expenseDraft, index) => button(`✏️ ${index + 1}`, BotAction.EDIT_SAVED, expenseDraft.id))],
  }
}

// Final state of an expense: same summary, no buttons
export function buildClosedReply(
  prefix: string,
  expenseDraft: ExpenseDraftDbDto,
  catalog: ExtractionCatalog,
): BotReply {
  const shared = formatSharedLine(expenseDraft, catalog)
  return { text: [prefix, formatSummary(expenseDraft, catalog), ...(shared ? [shared] : [])].join('\n'), edit: true }
}

// "👥 Brenda te debe S/ 19.50 · Danery te debe S/ 19.50 · tu parte S/ 26.00" under a closed summary (D75)
function formatSharedLine(expenseDraft: ExpenseDraftDbDto, catalog: ExtractionCatalog): string | null {
  const debts = formatSharedDebts(expenseDraft, catalog)
  if (!debts || !expenseDraft.sharedWith || expenseDraft.amount == null) return null
  const { own } = sharesOf(expenseDraft.amount, expenseDraft.sharedWith)
  return `👥 ${debts} · tu parte ${formatAmount(own, expenseDraft.currency)}`
}

// A new message after ✅ Guardar / 📝 Borrador: the summary is edited in place (no notification), this one arrives at
// the end of the chat
export function buildSavedNotice(
  expenseDraft: ExpenseDraftDbDto,
  destinationLabel: string,
  installments: InstallmentsCreated | null = null,
  sharedDebts: string | null = null,
): BotReply {
  const created = installments
    ? `\n📆 Cuotas 1/${installments.total} a ${installments.total}/${installments.total} (${formatPeriod(installments.from)} – ${formatPeriod(installments.to)}).`
    : ''
  return {
    text: `✅ Guardado: ${conceptOf(expenseDraft)} en ${destinationLabel}.${sharedDebts ? `\n👥 ${sharedDebts}.` : ''}${created}\nVer: /ultimos · /resumen`,
  }
}

export const MONTH_NAMES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'setiembre',
  'octubre',
  'noviembre',
  'diciembre',
]

// "oct 2026"
export const formatPeriod = ({ paymentMonth, paymentYear }: PaymentPeriod) =>
  `${MONTH_NAMES[paymentMonth - 1].slice(0, 3)} ${paymentYear}`

// D66: "1/n" on a card whose installment amount was only deduced (total / n, with ❓): confirm before the n rows
export function buildInstallmentsConfirmReply(expenseDraft: ExpenseDraftDbDto): BotReply {
  const total = Number((expenseDraft.installment ?? '1/1').split('/')[1])
  const amount = expenseDraft.amount ?? 0
  return {
    text: [
      `📆 <b>¿Cuota de ${formatAmount(amount, expenseDraft.currency)} × ${total}?</b>`,
      `Total ${formatAmount(amount * total, expenseDraft.currency)}. Si el banco cobra intereses, la cuota es otra.`,
    ].join('\n'),
    buttons: [
      [
        button(`✅ Sí, guardar ${total} cuotas`, BotAction.INSTALLMENTS_OK, expenseDraft.id),
        button('✏️ Otro monto', BotAction.INSTALLMENTS_EDIT, expenseDraft.id),
      ],
    ],
  }
}

export function buildParkedNotice(expenseDraft: ExpenseDraftDbDto): BotReply {
  return { text: `📝 Quedó en /borrador: ${conceptOf(expenseDraft)}. Retómalo cuando quieras.` }
}

export const conceptOf = ({ description, amount, currency }: ExpenseDraftDbDto) =>
  `${escapeHtml(description ?? 'Gasto')} ${formatAmount(amount, currency)}`

// Several screenshots or movements at once (P21): one list instead of one summary per expense
export function buildBatchReply(
  batchId: string,
  expenseDrafts: ExpenseDraftDbDto[],
  warnings: (string | null)[],
  catalog: ExtractionCatalog,
): BotReply {
  const totals = new Map<string, number>()
  for (const { amount, currency } of expenseDrafts) {
    if (amount == null) continue
    const key = currency ?? Currency.PEN
    totals.set(key, (totals.get(key) ?? 0) + amount)
  }
  const total = [...totals].map(([currency, amount]) => formatAmount(Math.round(amount * 100) / 100, currency))

  const lines = expenseDrafts.map((expenseDraft, index) => {
    const details = [
      formatDate(expenseDraft.spentAt).slice(0, 5),
      `<b>${escapeHtml(expenseDraft.description ?? 'Sin concepto')}</b>`,
      formatAmount(expenseDraft.amount, expenseDraft.currency),
      expenseDraft.installment ? `cuota ${expenseDraft.installment}` : null,
      expenseDraft.paymentMethodId ? nameOf(catalog, expenseDraft.paymentMethodId) : null,
    ].filter(Boolean)
    const flag = warnings[index]
      ? ' ⚠️ repetido'
      : expenseDraft.missingFields.length
        ? ` ❓ falta ${expenseDraft.missingFields.map((field) => FIELD_NAMES[field as ExpenseField] ?? field).join(', ')}`
        : ''
    return `${index + 1}. ${details.join(' · ')}${flag}`
  })
  const pending = expenseDrafts.some((expenseDraft, index) => warnings[index] || expenseDraft.missingFields.length)

  return {
    text: [
      `📋 <b>${expenseDrafts.length} gastos</b> · total ${total.join(' + ') || '—'}`,
      ...lines,
      ...(pending ? ['', '<i>Guardar todos deja los repetidos e incompletos en /borrador.</i>'] : []),
    ].join('\n'),
    buttons: [
      [button('✅ Guardar todos', BotAction.SAVE_ALL, batchId)],
      [
        button('📝 Revisar uno por uno', BotAction.REVIEW_ALL, batchId),
        button('📝 Borrador', BotAction.LATER_ALL, batchId),
      ],
    ],
  }
}

export function formatRecent(expenseDrafts: ExpenseDraftDbDto[]): string {
  if (!expenseDrafts.length) return TEXTS.noRecent

  return [
    '<b>Últimos gastos</b>',
    ...expenseDrafts.map(
      (expenseDraft) =>
        `• ${formatDate(expenseDraft.spentAt)} ${escapeHtml(expenseDraft.description ?? '—')} — ${formatAmount(expenseDraft.amount, expenseDraft.currency)} (${DESTINATION_LABELS[expenseDraft.destination as ExpenseDestination] ?? '—'})`,
    ),
  ].join('\n')
}

export function formatMonthlyTotals(
  totals: MonthlyTotalDbDto[],
  catalog: ExtractionCatalog,
  monthLabel: string,
): string {
  if (!totals.length) return TEXTS.noTotals

  const sum = (rows: MonthlyTotalDbDto[]) => {
    const byCurrency = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.currency] = (acc[row.currency] ?? 0) + row.total
      return acc
    }, {})
    return Object.entries(byCurrency)
      .map(([currency, total]) => formatAmount(total, currency))
      .join(' + ')
  }

  const destinations = [...new Set(totals.map((row) => row.destination))]
  const people = [
    ...new Set(totals.filter((row) => !DEBT_DESTINATIONS.includes(row.destination)).map((row) => row.personId)),
  ]

  return [
    `<b>Resumen de ${monthLabel}</b>`,
    ...destinations.map((destination) => {
      const label = DEBT_DESTINATIONS.includes(destination)
        ? `${DESTINATION_LABELS[destination]} (saldo pendiente)`
        : DESTINATION_LABELS[destination]
      return `• ${label}: ${sum(totals.filter((row) => row.destination === destination))}`
    }),
    '',
    '<b>Por persona</b>',
    ...people.map(
      (personId) =>
        `• ${nameOf(catalog, personId)}: ${sum(totals.filter((row) => row.personId === personId && !DEBT_DESTINATIONS.includes(row.destination)))}`,
    ),
  ].join('\n')
}

// /borrador: one message per expense pending review, with Retomar / Descartar
export function buildDraftReplies(items: ExpenseDraftDbDto[], total: number, catalog: ExtractionCatalog): BotReply[] {
  if (!items.length) return [{ text: TEXTS.emptyDrafts }]

  return [
    { text: TEXTS.draftsHeader(items.length, total) },
    ...items.map((expenseDraft) => ({
      text:
        expenseDraft.status === ExpenseDraftStatus.FAILED
          ? `⚠️ ${TEXTS.failedExtraction}\n<i>${escapeHtml(expenseDraft.rawText ?? '')}</i>`
          : formatSummary(expenseDraft, catalog),
      buttons: [
        [
          button('↩️ Retomar', BotAction.RESUME, expenseDraft.id),
          button('❌ Descartar', BotAction.DISCARD, expenseDraft.id),
        ],
      ],
    })),
  ]
}

// Keeps the typed name short enough for callback_data (64 bytes in total)
// /uso: one line per model; the bot stops using a model at its usable limit (90 % of the free quota)
export function formatAiUsage(usage: AiModelUsage[], ocr?: { attempts: number; resolved: number }): string {
  const lines = usage.map(({ provider, model, used, usableLimit }) => {
    const icon = used >= usableLimit ? '🔴' : used >= usableLimit * 0.8 ? '🟡' : '🟢'
    return `${icon} <b>${escapeHtml(provider)}</b> ${escapeHtml(model)}: ${used} de ${usableLimit}`
  })
  // P21: bank screenshots read by the local OCR, without spending AI
  const ocrLine = ocr?.attempts ? [`🔎 <b>OCR local</b>: ${ocr.resolved} de ${ocr.attempts} capturas sin AI`] : []
  return [
    '🤖 <b>Uso de la AI hoy</b>',
    ...lines,
    ...ocrLine,
    '',
    '<i>Al llegar al límite uso el siguiente modelo.</i>',
  ].join('\n')
}

export function toNewPaymentMethodName(text: string): string {
  let name = text.replace(/[:\n]/g, ' ').replace(/\s+/g, ' ').trim()
  while (Buffer.byteLength(name) > MAX_NEW_PAYMENT_METHOD_NAME_BYTES) name = name.slice(0, -1)
  return name.trim()
}

// "No conozco bbva. ¿Lo agrego?" with one button per payment method type
export function buildNewPaymentMethodReply(draftId: string, name: string): BotReply {
  const types = [
    PaymentMethodType.DEBIT_CARD,
    PaymentMethodType.WALLET,
    PaymentMethodType.CREDIT_CARD,
    PaymentMethodType.CASH,
  ]
  const create = (type: PaymentMethodType) => ({
    label: PAYMENT_TYPE_LABELS[type],
    data: encodeBotAction({ name: BotAction.NEW_PAYMENT_METHOD, draftId, field: type, value: name }),
  })

  return {
    text: `No conozco <b>${escapeHtml(name)}</b>. ¿Lo agrego como medio de pago? Elige el tipo:`,
    buttons: [
      ...toRows(types.map(create)),
      [{ label: 'No', data: encodeBotAction({ name: BotAction.NEW_PAYMENT_METHOD, draftId }) }],
    ],
  }
}
