import { Notification } from '@/generated/prisma/client'
import { BudgetStatus } from '@/commons/constants/budget.constant'
import { CalendarEventKind, CalendarEventStatus, PaymentOutcome } from '@/commons/constants/calendar.constant'
import { BotAction, BotCommand } from '@/commons/constants/conversation.constant'
import { toCents } from '@/commons/constants/debt.constant'
import { NotificationKind, NotificationOp, NotificationRefType } from '@/commons/constants/notification.constant'
import { DateHelper } from '@/commons/helpers/date.helper'
import { CreateNotificationDbDto } from '@/db/models/notification/notificationDB.dto'
import { CategoryBudgetLine } from '@/modules/budget/budget.service'
import { CalendarEvent, CommittedInstallments } from '@/modules/calendar/calendar.service'
import { encodeBotAction } from '@/modules/conversation/bot-action.codec'
import { commandButtons, escapeHtml, formatAmount, MONTH_NAMES } from '@/modules/conversation/conversation.messages'
import { BotButton, BotReply } from '@/modules/conversation/dto/conversation.types'
import { RecurringGeneration } from '@/modules/expenses/recurring-expenses.service'

import { ChargeRow, DuplicateCharge, PriceChange, SubscriptionRow } from './notification.rules'

// User-facing texts of the reminders (P20, D86), in Spanish. Title and body are stored plain (the web shows them as
// text); Telegram escapes them and adds the buttons.

const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']
const pen = (amount: number) => formatAmount(toCents(amount), 'PEN')
const money = (amount: number | null, currency: string) =>
  formatAmount(amount == null ? null : toCents(amount), currency)
const dayDate = (isoDay: string) => new Date(`${isoDay}T00:00:00.000Z`)

// "jue 25/09"
export function shortDate(isoDay: string): string {
  const [, month, day] = isoDay.split('-')
  return `${WEEKDAYS[dayDate(isoDay).getUTCDay()]} ${day}/${month}`
}

const monthLabel = (month: number, year: number) => `${MONTH_NAMES[month - 1]} ${year}`

export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  [NotificationKind.DUE]: 'Vencimientos (un día antes)',
  [NotificationKind.CARD_CLOSE]: 'Cierre de tarjetas',
  [NotificationKind.DAILY_CLOSE]: 'Cierre del día (21:00)',
  [NotificationKind.WEEKLY]: 'Resumen del domingo',
  [NotificationKind.BUDGET]: 'Presupuesto al 80 %',
  [NotificationKind.ANOMALY]: 'Cargos raros',
  [NotificationKind.RECURRING]: 'Gastos recurrentes del mes',
  [NotificationKind.STATEMENT]: 'Estados de cuenta conciliados',
  [NotificationKind.COLLECT]: 'Cobros del mes y atrasados',
}

const EVENT_EMOJI: Record<CalendarEventKind, string> = {
  [CalendarEventKind.CARD_DUE]: '💳',
  [CalendarEventKind.CARD_CLOSE]: '✂️',
  [CalendarEventKind.FIXED_COST]: '🏠',
  [CalendarEventKind.SUBSCRIPTION]: '🎬',
  [CalendarEventKind.DEBT_I_OWE]: '💸',
  [CalendarEventKind.DEBT_OWED_TO_ME]: '🤝',
  [CalendarEventKind.RECURRING]: '🔁',
}

export const NTF_TEXTS = {
  notFound: 'Este aviso ya no existe',
  outcomes: {
    [PaymentOutcome.PAID]: '✅ Pagado',
    [PaymentOutcome.ALREADY_PAID]: 'Ya estaba pagado',
    [PaymentOutcome.NOTHING_TO_PAY]: 'No hay nada pendiente de ese pago',
    [PaymentOutcome.NOT_FOUND]: 'Este aviso ya no existe',
    [PaymentOutcome.PARTIAL]: '✅ Pago parcial registrado',
  } satisfies Record<PaymentOutcome, string>,
  askAmount: (title: string) =>
    `✏️ Escribe el monto correcto de <b>${escapeHtml(title)}</b> (por ejemplo <i>45.90</i>).`,
  askDebtAmount: (title: string) => `✏️ Escribe cuánto se pagó de <b>${escapeHtml(title)}</b> (por ejemplo <i>50</i>).`,
  amountSaved: (title: string, amount: number) => `✅ ${escapeHtml(title)}: el monto ahora es ${pen(amount)}.`,
  paymentSaved: (title: string, amount: number) => `✅ Registré un pago de ${pen(amount)} de ${escapeHtml(title)}.`,
  amountTooHigh: (balance: number) => `⚠️ Es más de lo que falta pagar (${pen(balance)}). Escribe otro monto.`,
  muted: (kind: NotificationKind) =>
    `🔕 Ya no te llegarán avisos de «${NOTIFICATION_KIND_LABELS[kind]}» por Telegram. Actívalos con /avisos.`,
  mutedNotice: 'Aviso silenciado',
  settingsSaved: 'Listo',
  settingsHeader:
    '🔔 <b>Avisos por Telegram</b>\nToca uno para activarlo o apagarlo. La campana de la web se configura en Configuración ▸ Notificaciones.',
  calendarHeader: (days: number) => `📅 <b>Próximos ${days} días</b>`,
  calendarEmpty: (days: number) => `📅 Nada por pagar en los próximos ${days} días. 🎉`,
  installmentsHeader: (months: number) => `💳 <b>Cuotas de tarjeta de los próximos ${months} meses</b>`,
  installmentsEmpty: (months: number) => `💳 No tienes cuotas de tarjeta en los próximos ${months} meses.`,
}

type NotificationDraft = CreateNotificationDbDto

// ==================== Contents (stored in ntf_notifications) ====================

// Due tomorrow (09:00): card payments and closings, fixed costs, subscriptions and debt installments
export function dueNotice(event: CalendarEvent): NotificationDraft {
  const when = `mañana (${shortDate(event.date)})`
  const amount = money(event.amount, event.currency)
  const installment = event.installment ? ` ${event.installment}` : ''
  const base = {
    kind: NotificationKind.DUE,
    amount: event.amount,
    refType: event.refType,
    refId: event.refId,
    eventDate: dayDate(event.date),
    dedupeKey: `due:${event.kind}:${event.refId}:${event.date}`,
  }

  switch (event.kind) {
    case CalendarEventKind.CARD_CLOSE: {
      const nextDay = shortDate(DateHelper.addDays(event.date, 1))
      const sofar = event.amount ? ` Van ${amount}.` : ''
      return {
        ...base,
        kind: NotificationKind.CARD_CLOSE,
        title: `${EVENT_EMOJI[event.kind]} Cierre de ${event.name}`,
        body: `${event.name} cierra ${when}: lo que compres desde el ${nextDay} va al siguiente estado de cuenta.${sofar}`,
      }
    }
    case CalendarEventKind.CARD_DUE:
      return {
        ...base,
        title: `${EVENT_EMOJI[event.kind]} Pago de ${event.name}`,
        body: `Vence ${when}: ${amount} por pagar del estado de cuenta.`,
      }
    case CalendarEventKind.DEBT_I_OWE:
      return {
        ...base,
        title: `${EVENT_EMOJI[event.kind]} Le debes a ${event.personName}`,
        body: `${event.name}${installment}: ${amount} vence ${when}.`,
      }
    case CalendarEventKind.DEBT_OWED_TO_ME:
      return {
        ...base,
        title: `${EVENT_EMOJI[event.kind]} ${event.personName} te debe`,
        body: `${event.name}${installment}: ${amount} vence ${when}.`,
      }
    default:
      return {
        ...base,
        title: `${EVENT_EMOJI[event.kind]} ${event.name}`,
        body: `Vence ${when}: ${amount}.`,
      }
  }
}

// Day 1 (06:00): the recurring expenses created for the month
export function recurringNotice({ month, year, created }: RecurringGeneration): NotificationDraft {
  const lines = created.map(
    (item) => `• ${item.description}: ${money(item.amount, item.currency)} (día ${Number(item.date.slice(8))})`,
  )
  return {
    kind: NotificationKind.RECURRING,
    title: `🔁 Gastos de ${monthLabel(month, year)}`,
    body: `Creé ${created.length} ${created.length === 1 ? 'gasto recurrente' : 'gastos recurrentes'} como pendientes:\n${lines.join('\n')}\nTe aviso un día antes de cada uno.`,
    amount: toCents(created.filter((item) => item.currency === 'PEN').reduce((sum, item) => sum + item.amount, 0)),
    dedupeKey: `recurring:${year}-${String(month).padStart(2, '0')}`,
  }
}

// 21:00: what was registered today (your part) and what is still due today
// Cobros (P30): the installments of one person with a balance, in soles and other currencies apart
export interface CollectDebt {
  description: string
  installment: string | null
  paymentMonth: number
  paymentYear: number
  balance: number
  currency: string
}

const collectLines = (debts: CollectDebt[], withMonth: boolean) =>
  debts.map(
    (debt) =>
      `• ${debt.description}${debt.installment ? ` (cuota ${debt.installment})` : ''}${withMonth ? `, ${monthLabel(debt.paymentMonth, debt.paymentYear)}` : ''}: ${money(debt.balance, debt.currency)}`,
  )
const penTotal = (debts: CollectDebt[]) =>
  toCents(debts.filter((debt) => debt.currency === 'PEN').reduce((sum, debt) => sum + debt.balance, 0))

// Day 1, 09:00: what one person owes this month, ready to send them (the message of /cobrar)
export function collectMonthNotice(
  person: { id: string; name: string },
  debts: CollectDebt[],
  month: number,
  year: number,
): NotificationDraft {
  const total = penTotal(debts)
  return {
    kind: NotificationKind.COLLECT,
    title: `🤝 Cobrar a ${person.name}: ${pen(total)} de ${monthLabel(month, year)}`,
    body: [
      `Hola ${person.name} 👋, te paso lo de ${monthLabel(month, year)}:`,
      ...collectLines(debts, false),
      `Total: ${pen(total)}`,
    ].join('\n'),
    amount: total,
    refType: NotificationRefType.DEBT,
    refId: person.id,
    dedupeKey: `collect:${person.id}:${year}-${String(month).padStart(2, '0')}`,
  }
}

// "Recordar pago" on cobros: what the selected installments of one person leave pending, ready to send them
export function collectReminderNotice(
  person: { id: string; name: string },
  debts: CollectDebt[],
  today: string,
): NotificationDraft {
  const total = penTotal(debts)
  return {
    kind: NotificationKind.COLLECT,
    title: `🔔 Recordar pago a ${person.name}: ${pen(total)}`,
    body: [
      `Hola ${person.name} 👋, te recuerdo lo pendiente:`,
      ...collectLines(debts, true),
      `Total: ${pen(total)}`,
    ].join('\n'),
    amount: total,
    refType: NotificationRefType.DEBT,
    refId: person.id,
    dedupeKey: `remind-collect:${person.id}:${today}`,
  }
}

// "Recordar pago" on debts I owe: a reminder for me, with what is left to pay that person
export function payReminderNotice(
  person: { id: string; name: string },
  debts: CollectDebt[],
  today: string,
): NotificationDraft {
  const total = penTotal(debts)
  return {
    kind: NotificationKind.COLLECT,
    title: `💸 Recuerda pagar a ${person.name}: ${pen(total)}`,
    body: [`Lo que le debes a ${person.name}:`, ...collectLines(debts, true), `Total: ${pen(total)}`].join('\n'),
    amount: total,
    refType: NotificationRefType.DEBT,
    refId: person.id,
    dedupeKey: `remind-pay:${person.id}:${today}`,
  }
}

// Day 5, 09:00: what one person still owes from earlier months
export function collectLateNotice(
  person: { id: string; name: string },
  debts: CollectDebt[],
  month: number,
  year: number,
): NotificationDraft {
  const total = penTotal(debts)
  return {
    kind: NotificationKind.COLLECT,
    title: `⏰ ${person.name} tiene ${pen(total)} atrasados`,
    body: [`Cuotas vencidas sin cobrar:`, ...collectLines(debts, true), `Total: ${pen(total)}`].join('\n'),
    amount: total,
    refType: NotificationRefType.DEBT,
    refId: person.id,
    dedupeKey: `collect-late:${person.id}:${year}-${String(month).padStart(2, '0')}`,
  }
}

export function dailyCloseNotice(today: string, spent: (ChargeRow & { own: number })[], dueToday: CalendarEvent[]) {
  const total = toCents(spent.reduce((sum, row) => sum + row.own, 0))
  const top = [...spent].sort((a, b) => b.own - a.own).slice(0, 3)
  const spentText = spent.length
    ? `Hoy registraste ${spent.length} ${spent.length === 1 ? 'gasto' : 'gastos'}: ${pen(total)} (tu parte).\n${top
        .map((row) => `• ${row.description}: ${money(row.amount, row.currency)}`)
        .join('\n')}`
    : 'Hoy no registraste gastos.'
  const dueText = dueToday.length
    ? `\n⏰ Vence hoy sin pagar: ${dueToday.map((event) => `${event.name} ${money(event.amount, event.currency)}`).join(' · ')}.`
    : ''
  return {
    kind: NotificationKind.DAILY_CLOSE,
    title: `🌙 Cierre del día · ${shortDate(today)}`,
    body: `${spentText}${dueText}`,
    amount: total,
    eventDate: dayDate(today),
    dedupeKey: `daily:${today}`,
  } satisfies NotificationDraft
}

// A category at its threshold or over its limit: once per category, month and level
export function budgetNotice(line: CategoryBudgetLine, month: number, year: number): NotificationDraft {
  const over = line.status === BudgetStatus.OVER
  const limit = line.limit ?? 0
  const left = over ? `Te pasaste por ${pen(line.spent - limit)}.` : `Te quedan ${pen(limit - line.spent)}.`
  return {
    kind: NotificationKind.BUDGET,
    title: `${over ? '🔴' : '⚠️'} ${line.name}: ${Math.round(line.percent ?? 0)} % del presupuesto`,
    body: `Llevas ${pen(line.spent)} de ${pen(limit)} en ${monthLabel(month, year)}. ${left}`,
    amount: line.spent,
    refType: NotificationRefType.CATEGORY,
    refId: line.categoryId,
    dedupeKey: `budget:${line.categoryId}:${year}-${String(month).padStart(2, '0')}:${line.status}`,
  }
}

export function priceChangeNotice({ charge, subscription, before }: PriceChange): NotificationDraft {
  const direction = charge.amount > before ? 'subió' : 'bajó'
  return {
    kind: NotificationKind.ANOMALY,
    title: `📈 ${subscription.description} ${direction} de precio`,
    body: `Se cobró ${money(charge.amount, charge.currency)} el ${shortDate(charge.date)} (antes ${money(before, charge.currency)}). Si está bien, actualiza el monto de la plataforma en la web.`,
    amount: charge.amount,
    refType: NotificationRefType.CREDIT_CARD_EXPENSE,
    refId: charge.id,
    eventDate: dayDate(charge.date),
    dedupeKey: `anomaly:price:${charge.id}`,
  }
}

export function duplicateNotice({ first, second }: DuplicateCharge): NotificationDraft {
  return {
    kind: NotificationKind.ANOMALY,
    title: '👯 Posible cargo duplicado',
    body: `${second.description} por ${money(second.amount, second.currency)} aparece dos veces (${shortDate(first.date)} y ${shortDate(second.date)}). Revisa si te lo cobraron dos veces.`,
    amount: second.amount,
    refType: second.source === 'card' ? NotificationRefType.CREDIT_CARD_EXPENSE : NotificationRefType.DAILY_EXPENSE,
    refId: second.id,
    eventDate: dayDate(second.date),
    dedupeKey: `anomaly:dup:${first.id}:${second.id}`,
  }
}

export function notChargedNotice(subscription: SubscriptionRow): NotificationDraft {
  return {
    kind: NotificationKind.ANOMALY,
    title: `❓ ${subscription.description} no se cobró`,
    body: `Vencía el ${shortDate(subscription.dueDate!)} y no hay un cargo con ese nombre en tus tarjetas. ¿La cancelaste o la pagaste de otra forma?`,
    amount: subscription.amount,
    refType: NotificationRefType.SUBSCRIPTION,
    refId: subscription.id,
    eventDate: dayDate(subscription.dueDate!),
    dedupeKey: `anomaly:nocharge:${subscription.id}`,
  }
}

export interface WeeklyData {
  from: string
  to: string
  spent: number // your part, PEN
  month: number
  year: number
  budgetLimit: number | null
  spentThisMonth: number
  surplus: number | null
  owedToMe: number
  late: number
  iOwe: number
  nextWeek: CalendarEvent[]
}

// Sunday 20:00
export function weeklyNotice(data: WeeklyData): NotificationDraft {
  const lines = [`Del ${shortDate(data.from)} al ${shortDate(data.to)} gastaste ${pen(data.spent)} (tu parte).`]
  if (data.budgetLimit) {
    const left = toCents(data.budgetLimit - data.spentThisMonth)
    const used = Math.round((data.spentThisMonth / data.budgetLimit) * 100)
    lines.push(
      `Presupuesto de ${MONTH_NAMES[data.month - 1]}: ${left >= 0 ? `te quedan ${pen(left)}` : `te pasaste por ${pen(-left)}`} (${used} % usado).`,
    )
  }
  if (data.surplus != null) lines.push(`Excedente del mes: ${pen(data.surplus)}.`)
  if (data.owedToMe || data.iOwe) {
    const late = data.late ? ` (${pen(data.late)} atrasado)` : ''
    lines.push(`Deudas: te deben ${pen(data.owedToMe)}${late} · debes ${pen(data.iOwe)}.`)
  }
  const toPay = data.nextWeek.filter(
    (event) => event.kind !== CalendarEventKind.CARD_CLOSE && event.status !== CalendarEventStatus.PAID,
  )
  if (toPay.length) {
    const total = toPay.filter((event) => event.currency === 'PEN').reduce((sum, event) => sum + (event.amount ?? 0), 0)
    lines.push(`Próximos 7 días: ${toPay.length} ${toPay.length === 1 ? 'pago' : 'pagos'} por ${pen(total)}.`)
  }
  return {
    kind: NotificationKind.WEEKLY,
    title: '📊 Tu semana',
    body: lines.join('\n'),
    amount: data.spent,
    eventDate: dayDate(data.to),
    dedupeKey: `weekly:${data.to}`,
  }
}

// ==================== Telegram ====================

const PAYABLE_REFS: string[] = [
  NotificationRefType.FIXED_COST,
  NotificationRefType.SUBSCRIPTION,
  NotificationRefType.CARD_STATEMENT,
  NotificationRefType.DEBT,
]
const EDITABLE_REFS: string[] = [
  NotificationRefType.FIXED_COST,
  NotificationRefType.SUBSCRIPTION,
  NotificationRefType.DEBT,
]

const opButton = (label: string, notificationId: string, op: NotificationOp): BotButton => ({
  label,
  data: encodeBotAction({ name: BotAction.NOTIFY, draftId: notificationId, value: op }),
})

export const formatNotification = (notification: Pick<Notification, 'title' | 'body'>) =>
  `<b>${escapeHtml(notification.title)}</b>\n${escapeHtml(notification.body)}`

// ✅ Pagado and ✏️ Editar monto on what can be paid; 🔕 Silenciar on every notice
export function notificationButtons(notification: Notification): BotButton[][] {
  const rows: BotButton[][] = []
  if (notification.kind === NotificationKind.DUE && PAYABLE_REFS.includes(notification.refType ?? '')) {
    const isDebt = notification.refType === NotificationRefType.DEBT
    const row = [opButton('✅ Pagado', notification.id, NotificationOp.PAID)]
    if (EDITABLE_REFS.includes(notification.refType ?? '')) {
      row.push(opButton(isDebt ? '✏️ Otro monto' : '✏️ Editar monto', notification.id, NotificationOp.EDIT_AMOUNT))
    }
    rows.push(row)
  }
  rows.push([opButton('🔕 Silenciar', notification.id, NotificationOp.MUTE)])
  if (notification.kind === NotificationKind.WEEKLY)
    rows.push(...commandButtons(BotCommand.CALENDAR, BotCommand.BUDGET))
  if (notification.kind === NotificationKind.COLLECT) rows.push(...commandButtons(BotCommand.DEBTS))
  return rows
}

export function notificationReply(notification: Notification): BotReply {
  return { text: formatNotification(notification), buttons: notificationButtons(notification) }
}

// The notice after it was answered: same text, the outcome below and no buttons
export const answeredReply = (notification: Notification, outcome: string): BotReply => ({
  text: `${formatNotification(notification)}\n\n${outcome}`,
  edit: true,
})

// /avisos: one button per kind, ✅ on · 🔕 off
export function buildSettingsReply(settings: Record<NotificationKind, { telegram: boolean }>): BotReply {
  const kinds = Object.values(NotificationKind)
  return {
    text: NTF_TEXTS.settingsHeader,
    buttons: kinds.map((kind) => [
      {
        label: `${settings[kind].telegram ? '✅' : '🔕'} ${NOTIFICATION_KIND_LABELS[kind]}`,
        data: encodeBotAction({ name: BotAction.NOTIFY_SETTING, draftId: kind }),
      },
    ]),
  }
}

// /calendario: the next days grouped by day
export function buildCalendarReply(events: CalendarEvent[], days: number): BotReply {
  const shown = events.filter((event) => event.status !== CalendarEventStatus.PAID)
  if (!shown.length) return { text: NTF_TEXTS.calendarEmpty(days), buttons: commandButtons(BotCommand.INSTALLMENTS) }

  const byDay = new Map<string, CalendarEvent[]>()
  for (const event of shown) byDay.set(event.date, [...(byDay.get(event.date) ?? []), event])

  const blocks = [...byDay].map(([date, list]) => {
    const lines = list.map((event) => {
      const who = event.personName ? ` (${escapeHtml(event.personName)})` : ''
      const label =
        event.kind === CalendarEventKind.CARD_CLOSE
          ? `Cierre ${escapeHtml(event.name)}`
          : event.kind === CalendarEventKind.CARD_DUE
            ? `Pago ${escapeHtml(event.name)}`
            : `${escapeHtml(event.name)}${event.installment ? ` ${event.installment}` : ''}${who}`
      const amount = event.amount != null ? ` · ${money(event.amount, event.currency)}` : ''
      const late = event.status === CalendarEventStatus.LATE ? ' ⏰' : ''
      return `• ${EVENT_EMOJI[event.kind]} ${label}${amount}${late}`
    })
    return `<b>${shortDate(date)}</b>\n${lines.join('\n')}`
  })

  return {
    text: `${NTF_TEXTS.calendarHeader(days)}\n\n${blocks.join('\n\n')}`,
    buttons: commandButtons(BotCommand.INSTALLMENTS),
  }
}

// /cuotas: total per month and per card, with the ones "por generar"
export function buildInstallmentsReply({ months, cards }: CommittedInstallments): BotReply {
  if (!cards.length) return { text: NTF_TEXTS.installmentsEmpty(months.length) }

  const blocks = months.map(({ month, year, total }) => {
    const perCard = cards
      .map((card) => ({ card, line: card.months.find((item) => item.month === month && item.year === year)! }))
      .filter(({ line }) => line.count > 0)
      .map(({ card, line }) => {
        const estimated = line.estimated ? ` (${line.estimated} por generar)` : ''
        return `• ${escapeHtml(card.name)}: ${pen(line.amount)} en ${line.count} ${line.count === 1 ? 'cuota' : 'cuotas'}${estimated}`
      })
    return `<b>${monthLabel(month, year)}</b>: ${pen(total)}${perCard.length ? `\n${perCard.join('\n')}` : ''}`
  })

  return { text: `${NTF_TEXTS.installmentsHeader(months.length)}\n\n${blocks.join('\n\n')}` }
}
