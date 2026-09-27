import { toCents } from '@/commons/constants/debt.constant'
import { Currency } from '@/commons/constants/expense.constant'
import { STATEMENT_TOTAL_TOLERANCE } from '@/commons/constants/statement.constant'
import { normalizeText } from '@/modules/expense-extraction/expense-extraction.catalog'

// Reads the text of a card statement without AI (P14 block 2, D95). Generic on purpose: the lines of most Peruvian
// statements are "date [date] description [cuota n/m] amount". The result is trusted only when its rows add up to the
// total of the statement (templateAddsUp); otherwise the text goes to the AI.

export interface ParsedStatementRow {
  date: string | null // YYYY-MM-DD
  description: string
  amount: number
  currency: string
  installment: string | null
  locked?: boolean // cancelled purchase/refund pair kept for reference, never importable
}

export interface ParsedStatement {
  cardHint: string | null // catalog code of the card the text names: OH (Sip), AMEX, IO, CMR
  holderName?: string | null // the cardholder the AI read (the template leaves it to the holder lines)
  cardName?: string | null // the card as the AI read it
  periodEnd: string | null
  dueDate: string | null
  totalDue: number | null
  minimumDue: number | null
  previousBalance: number | null
  previousPayments: number | null
  monthlyPayment: number | null
  currency: string
  rows: ParsedStatementRow[]
}

const MONTHS: Record<string, number> = {
  ene: 1,
  feb: 2,
  mar: 3,
  abr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  ago: 8,
  set: 9,
  sep: 9,
  oct: 10,
  nov: 11,
  dic: 12,
}

const AMOUNT = String.raw`-?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}`
const DAY_MONTH = String.raw`(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?`
const DAY_MONTH_NAME = String.raw`(\d{1,2})[ -]?(ene|feb|mar|abr|may|jun|jul|ago|set|sep|oct|nov|dic)[a-z]*\.?(?:[ -]?(\d{2,4}))?`

const pad = (value: number) => String(value).padStart(2, '0')
const amountOf = (text: string) => toCents(Number(text.replace(/,/g, '')))

// Lines that are totals, balances or payments, never a purchase
const NOT_A_MOVEMENT =
  /total|saldo|pago minimo|pago del mes|linea de credito|limite|tasa|tea|tcea|su pago|pago recibido|pago realizado|gracias por su pago|abono|pago-pago con ahorra mas/

const paymentDescription = /\b(pago|abono|ahorra mas)\b/
const cancellationDescription = /\b(anulacion|reversa|extorno)\b/i

const merchantOf = (description: string) =>
  normalizeText(description)
    .replace(/\b(anulacion|reversa|extorno)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

export function lockCancelledStatementRows(rows: ParsedStatementRow[]): ParsedStatementRow[] {
  return rows.map((row) => {
    if (row.amount < 0 && cancellationDescription.test(normalizeText(row.description))) return { ...row, locked: true }
    if (row.amount <= 0) return row
    const cancelled = rows.some(
      (candidate) =>
        candidate.amount === -row.amount &&
        cancellationDescription.test(normalizeText(candidate.description)) &&
        merchantOf(candidate.description) === merchantOf(row.description),
    )
    return cancelled ? { ...row, locked: true } : row
  })
}

function dateFrom(text: string, fallbackYear: number | null): { iso: string; rest: string } | null {
  let match = new RegExp(`^${DAY_MONTH}\\b`).exec(text)
  let day: number, month: number, yearText: string | undefined
  if (match) {
    ;[day, month, yearText] = [Number(match[1]), Number(match[2]), match[3]]
  } else {
    match = new RegExp(`^${DAY_MONTH_NAME}\\b`).exec(text)
    if (!match) return null
    ;[day, month, yearText] = [Number(match[1]), MONTHS[match[2]], match[3]]
  }
  if (!day || day > 31 || !month || month > 12) return null
  const year = yearText ? Number(yearText.length === 2 ? `20${yearText}` : yearText) : fallbackYear
  if (!year) return null
  return { iso: `${year}-${pad(month)}-${pad(day)}`, rest: text.slice(match[0].length).trim() }
}

// "Fecha límite de pago 12/10/2026", "Último día de pago: 12 OCT 2026"
function findDate(line: string): string | null {
  const numeric = new RegExp(`${DAY_MONTH}`).exec(line)
  if (numeric?.[3]) {
    const year = numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3]
    return `${year}-${pad(Number(numeric[2]))}-${pad(Number(numeric[1]))}`
  }
  const named = new RegExp(DAY_MONTH_NAME).exec(line)
  if (named?.[3]) {
    const year = named[3].length === 2 ? `20${named[3]}` : named[3]
    return `${year}-${pad(MONTHS[named[2]])}-${pad(Number(named[1]))}`
  }
  return null
}

const lastAmount = (line: string) => {
  const amounts = line.match(new RegExp(AMOUNT, 'g'))
  return amounts ? amountOf(amounts[amounts.length - 1]) : null
}

export function detectCardHint(text: string): string | null {
  const normalized = normalizeText(text)
  if (/american express|\bamex\b/.test(normalized)) return 'AMEX'
  if (/\bsip\b|tarjeta oh|\boh!/.test(normalized)) return 'OH'
  // Not bare "falabella": CMR is a Falabella card, but a Falabella.com purchase can be on any other card's statement too
  if (/\bcmr\b/.test(normalized)) return 'CMR'
  if (/\btarjeta io\b|\bio\b/.test(normalized)) return 'IO'
  return null
}

export function parseStatementLines(lines: string[]): ParsedStatement {
  const normalizedLines = lines.map((line) => normalizeText(line))
  const joined = normalizedLines.join('\n')
  const parsed: ParsedStatement = {
    cardHint: detectCardHint(joined),
    periodEnd: null,
    dueDate: null,
    totalDue: null,
    minimumDue: null,
    previousBalance: null,
    previousPayments: null,
    monthlyPayment: null,
    currency: /\bus\$|dolares/.test(joined) && !/s\//.test(joined) ? Currency.USD : Currency.PEN,
    rows: [],
  }

  normalizedLines.forEach((line, index) => {
    const withNext = `${line} ${normalizedLines[index + 1] ?? ''}`
    if (!parsed.dueDate && /(ultimo dia|fecha( limite)?) de pago|pagar hasta/.test(line))
      parsed.dueDate = findDate(withNext)
    if (!parsed.periodEnd && /fecha de (cierre|corte)|cierre de facturacion/.test(line))
      parsed.periodEnd = findDate(withNext)
    if (parsed.totalDue == null && /total a pagar|pago total|deuda total|monto total/.test(line)) {
      parsed.totalDue = lastAmount(line) ?? lastAmount(normalizedLines[index + 1] ?? '')
    }
    if (parsed.minimumDue == null && /pago minimo/.test(line)) {
      parsed.minimumDue = lastAmount(line) ?? lastAmount(normalizedLines[index + 1] ?? '')
    }
    if (parsed.previousBalance == null && /saldo mes anterior/.test(line)) {
      parsed.previousBalance = lastAmount(line) ?? lastAmount(normalizedLines[index + 1] ?? '')
    }
    if (parsed.monthlyPayment == null && /pago del mes/.test(line)) {
      parsed.monthlyPayment = lastAmount(line) ?? lastAmount(normalizedLines[index + 1] ?? '')
    }
  })

  const previousPayments = normalizedLines.reduce((total, line) => {
    if (!paymentDescription.test(line) || /pago del mes|pago minimo|total/.test(line)) return total
    const amount = lastAmount(line)
    return amount == null ? total : toCents(total + amount)
  }, 0)
  parsed.previousPayments = parsed.previousBalance == null && !previousPayments ? null : previousPayments
  parsed.totalDue ??= parsed.monthlyPayment

  const fallbackYear = Number((parsed.periodEnd ?? parsed.dueDate ?? '').slice(0, 4)) || null
  lines.forEach((original) => {
    const line = original.trim()
    const normalized = normalizeText(line)
    if (NOT_A_MOVEMENT.test(normalized)) return
    const first = dateFrom(normalizeText(line), fallbackYear)
    if (!first) return
    // A second date (consumo and proceso) is skipped
    const second = dateFrom(first.rest, fallbackYear)
    const rest = (second ? second.rest : first.rest).trim()
    const cancellation = cancellationDescription.test(rest)
    const separateCredit = /-\s*(${AMOUNT})\s*$/.exec(rest)
    const amountMatch = separateCredit ?? new RegExp(`(${AMOUNT})\\s*(-|cr)?$`).exec(rest)
    if (!amountMatch || (amountMatch[2] && !separateCredit)) return // other credits and payments are not purchases
    const absoluteAmount = Math.abs(amountOf(amountMatch[1]))
    if (absoluteAmount <= 0 || (separateCredit && !cancellation)) return
    const amount = cancellation && separateCredit ? -absoluteAmount : absoluteAmount

    let description = rest
      .slice(0, amountMatch.index)
      .replace(/\b(s\/|us\$|pen|usd)\s*$/i, '')
      .trim()
    const installment = /(?:cuota\s*)?\b(\d{1,2})\s*\/\s*(\d{1,2})\b/.exec(description)
    let installmentText: string | null = null
    if (installment && Number(installment[1]) <= Number(installment[2]) && Number(installment[2]) <= 48) {
      installmentText = `${Number(installment[1])}/${Number(installment[2])}`
      description = description.replace(installment[0], '').trim()
    }
    // The description from the original line keeps its capital letters
    const start = original.toLowerCase().indexOf(description.split(' ')[0] ?? '')
    const pretty = start >= 0 ? original.slice(start, start + description.length).trim() : description
    if (!pretty) return

    parsed.rows.push({
      date: first.iso,
      description: pretty,
      amount,
      currency: parsed.currency,
      installment: installmentText,
      ...(cancellation && separateCredit ? { locked: true } : {}),
    })
  })

  if (parsed.previousBalance != null && parsed.previousPayments != null) {
    const remainder = toCents(parsed.previousBalance - parsed.previousPayments)
    if (remainder > 0) {
      parsed.rows.push({
        date: null,
        description: `Saldo mes anterior neto (${parsed.previousBalance.toFixed(2)} - ${parsed.previousPayments.toFixed(2)})`,
        amount: remainder,
        currency: parsed.currency,
        installment: null,
      })
    }
  }

  // A purchase and its cancellation remain visible together, but neither should become a new expense.
  parsed.rows = lockCancelledStatementRows(parsed.rows)
  return parsed
}

// A template result is trusted only when its purchases add up to the total of the statement
export function templateAddsUp(parsed: ParsedStatement): boolean {
  if (!parsed.rows.length || parsed.totalDue == null) return false
  const sum = toCents(parsed.rows.reduce((total, row) => total + row.amount, 0))
  return Math.abs(sum - parsed.totalDue) <= Math.max(STATEMENT_TOTAL_TOLERANCE, parsed.totalDue * 0.01)
}

// What the AI may read: the document number and long digit runs (card and account numbers) are masked (D94)
export function maskForAi(lines: string[], documentNumber: string | null): string {
  let text = lines.join('\n')
  if (documentNumber) text = text.split(documentNumber).join('********')
  return text.replace(/\b(?:\d[ *xX-]?){12,19}\b/g, '[número]')
}
