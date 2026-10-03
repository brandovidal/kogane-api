import { emptyStatementBalance, statementBalances, StatementBalanceData } from './statement.balance'
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
  currencyCertain?: boolean // the PDF gave this row an explicit symbol or section/column
}

export interface ParsedStatement {
  balances?: StatementBalanceData[]
  currencyAmbiguous?: boolean
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
  /total|saldo|pago minimo|pago del mes|linea de credito|limite|\btasa\b|\btea\b|tcea|su pago|pago recibido|pago realizado|gracias por su pago|abono|pago-pago con ahorra mas/

const paymentDescription =
  /\b(su pago|pagos? recibidos?|pagos? realizados?|gracias por su pago|abonos?|pago-pago con ahorra mas)\b/
const cancellationDescription = /\b(anulacion|reversa|extorno)\b/i

// "Resumen de movimientos": "+ INTERÉS COMPENSATORIO 380.84 US$ 0.00", one soles and one dólares amount per line
const SUMMARY_ROW = new RegExp(`^([-+=]?)\\s*([a-z ]+?)\\s+(${AMOUNT})\\s+us\\s*\\$\\s*(${AMOUNT})$`)
// IO's Consumos en cuotas: "date merchant total n de m capital interest TEA% [S/|US$] installment" (the installment
// amount, interest included, is what the statement adds up)
const INSTALLMENT_ROW = new RegExp(
  `^(.*?)\\s+${AMOUNT}\\s+(\\d{1,2})\\s+de\\s+(\\d{1,2})\\s+${AMOUNT}\\s+${AMOUNT}\\s+\\d+(?:\\.\\d+)?%\\s*(s/|us\\$)?\\s*(${AMOUNT})$`,
)
const toChargeDescription = (label: string) => {
  const text = label.trim()
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// The description from the original line keeps its capital letters
function prettyOf(original: string, description: string): string {
  const start = original.toLowerCase().indexOf(description.split(' ')[0] ?? '')
  return start >= 0 ? original.slice(start, start + description.length).trim() : description
}

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
        candidate.currency === row.currency &&
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

const CURRENCY_MARKER = /us\s*\$|\b(?:usd|dolares|pen|soles)\b|s\/\.?|\$/g
function currenciesIn(line: string): string[] {
  return [...line.matchAll(CURRENCY_MARKER)].map((match) =>
    /us|dolar|\$/.test(match[0]) ? Currency.USD : Currency.PEN,
  )
}
function currencyAmounts(
  line: string,
  fallback: string,
  columns: string[],
): { currency: string; amount: number }[] | null {
  const amounts = [...line.matchAll(new RegExp(AMOUNT, 'g'))]
  const markers = [...line.matchAll(CURRENCY_MARKER)]
  if (!amounts.length) return []
  const ordered = currenciesIn(line)
  if (columns.length > 1 && !markers.length && amounts.length !== columns.length) return null
  if (amounts.length > 1 && markers.every((marker) => marker.index < amounts[0].index)) {
    const headers = ordered.length ? ordered : columns
    if (headers.length !== amounts.length) return null
    return amounts.map((match, index) => ({ currency: headers[index], amount: amountOf(match[0]) }))
  }
  return amounts.map((match) => {
    const marker = markers.filter((marker) => marker.index < match.index).at(-1)
    return {
      currency: marker ? (/us|dolar|\$/.test(marker[0]) ? Currency.USD : Currency.PEN) : fallback,
      amount: amountOf(match[0]),
    }
  })
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
  const documentCurrencies = new Set(currenciesIn(joined))
  const parsed: ParsedStatement = {
    cardHint: detectCardHint(joined),
    periodEnd: null,
    dueDate: null,
    totalDue: null,
    minimumDue: null,
    previousBalance: null,
    previousPayments: null,
    monthlyPayment: null,
    currency:
      currenciesIn(joined).includes(Currency.USD) && !currenciesIn(joined).includes(Currency.PEN)
        ? Currency.USD
        : Currency.PEN,
    rows: [],
  }

  const balances = new Map<string, StatementBalanceData>()
  const balanceFor = (currency: string) => {
    if (!balances.has(currency)) balances.set(currency, emptyStatementBalance(currency))
    return balances.get(currency)!
  }
  const charges: { description: string; currency: string; amount: number }[] = []
  let sectionCurrency = parsed.currency
  let columns: string[] = []
  let inPayments = false
  normalizedLines.forEach((line, index) => {
    const markers = currenciesIn(line)
    if (markers.length && !new RegExp(AMOUNT).test(line)) {
      if (markers.length === 1) {
        sectionCurrency = markers[0]
        columns = []
      } else columns = markers
    }
    if (line === 'abonos') inPayments = true
    else if (/^subtotal|^consumos (directos|en cuotas)/.test(line)) inPayments = false
    const withNext = `${line} ${normalizedLines[index + 1] ?? ''}`
    if (!parsed.dueDate && /(ultimo dia|fecha( limite)?) de pago|pagar hasta/.test(line))
      // IO prints the date some lines below its heading, after the totals
      parsed.dueDate =
        findDate(withNext) ??
        normalizedLines
          .slice(index + 1, index + 6)
          .map(findDate)
          .find(Boolean) ??
        null
    if (!parsed.periodEnd && /fecha de (cierre|corte)|cierre de facturacion/.test(line))
      parsed.periodEnd = findDate(withNext)
    // "Ciclo de facturación: 26/07/2026 al 25/08/2026": the cycle closes on its last day
    const cycle = /(\d{1,2}\/\d{1,2}\/\d{4}) (?:al|hasta el) (\d{1,2}\/\d{1,2}\/\d{4})/.exec(withNext)
    if (!parsed.periodEnd && cycle) parsed.periodEnd = findDate(cycle[2])
    const summary = SUMMARY_ROW.exec(line)
    if (summary) {
      const [, sign, label, soles, dollars] = summary
      const values = [
        { currency: Currency.PEN, amount: amountOf(soles) },
        { currency: Currency.USD, amount: amountOf(dollars) },
      ]
      const summaryField = /saldo pendiente del mes anterior/.test(label)
        ? 'previousBalance'
        : /abonos del mes actual/.test(label)
          ? 'previousPayments'
          : /pago total del mes/.test(label)
            ? 'totalDue'
            : null
      for (const entry of values) {
        if (summaryField) balanceFor(entry.currency)[summaryField] = entry.amount
        else if (sign === '+' && !/^consumos/.test(label) && entry.amount > 0)
          charges.push({ description: toChargeDescription(label), currency: entry.currency, amount: entry.amount })
      }
      if (summaryField || sign === '+') return
    }
    const field = /pago minimo/.test(line)
      ? 'minimumDue'
      : /saldo (pendiente del )?mes anterior/.test(line)
        ? 'previousBalance'
        : /pago del mes/.test(line)
          ? 'monthlyPayment'
          : /total a pagar|pago total|deuda total|monto total/.test(line)
            ? 'totalDue'
            : null
    if (field) {
      const amounts = currencyAmounts(new RegExp(AMOUNT).test(line) ? line : withNext, sectionCurrency, columns)
      if (!amounts) parsed.currencyAmbiguous = true
      for (const entry of amounts ?? []) balanceFor(entry.currency)[field] ??= entry.amount
    } else if (
      !inPayments &&
      paymentDescription.test(line) &&
      !/total/.test(line) &&
      !cancellationDescription.test(line)
    ) {
      const amounts = currencyAmounts(line, sectionCurrency, columns)
      if (!amounts) parsed.currencyAmbiguous = true
      for (const entry of amounts ?? []) {
        const balance = balanceFor(entry.currency)
        balance.previousPayments = toCents((balance.previousPayments ?? 0) + Math.abs(entry.amount))
      }
    }
  })
  for (const balance of balances.values()) {
    balance.totalDue ??= balance.monthlyPayment
    if (balance.previousBalance != null) balance.previousPayments ??= 0
  }
  parsed.balances = [...balances.values()].sort((a, b) => a.currency.localeCompare(b.currency))
  const primary = parsed.balances.find((balance) => balance.currency === Currency.PEN) ?? parsed.balances[0]
  if (primary) Object.assign(parsed, primary)

  const fallbackYear = Number((parsed.periodEnd ?? parsed.dueDate ?? '').slice(0, 4)) || null
  sectionCurrency = parsed.currency
  columns = []
  let hasExplicitSection = false
  let inPaymentRows = false
  lines.forEach((original) => {
    const line = original.trim()
    const normalized = normalizeText(line)
    // The payments and credits table (IO's "Abonos") holds no purchases; the summary already carries its total
    if (normalized === 'abonos') inPaymentRows = true
    else if (/^subtotal|^consumos (directos|en cuotas)/.test(normalized)) inPaymentRows = false
    if (inPaymentRows) return
    const markers = currenciesIn(normalized)
    if (markers.length && !new RegExp(AMOUNT).test(normalized)) {
      hasExplicitSection = markers.length === 1
      if (hasExplicitSection) {
        sectionCurrency = markers[0]
        columns = []
      } else columns = markers
    }
    if (NOT_A_MOVEMENT.test(normalized)) return
    const first = dateFrom(normalizeText(line), fallbackYear)
    if (!first) return
    // A day printed without its year belongs to the year before when it would fall after the closing day (December
    // purchases on a January statement)
    if (parsed.periodEnd && !/\d{4}|\b\d{2}\s*$/.test(line.slice(0, 12)) && first.iso > parsed.periodEnd)
      first.iso = `${Number(first.iso.slice(0, 4)) - 1}${first.iso.slice(4)}`
    // A second date (consumo and proceso) is skipped
    const second = dateFrom(first.rest, fallbackYear)
    const rest = (second ? second.rest : first.rest).trim()
    const installmentRow = INSTALLMENT_ROW.exec(rest)
    if (installmentRow) {
      const [, merchant, current, total, marker, installmentAmount] = installmentRow
      parsed.rows.push({
        date: first.iso,
        description: prettyOf(original, merchant.trim()),
        amount: amountOf(installmentAmount),
        currency: marker ? (marker.startsWith('us') ? Currency.USD : Currency.PEN) : sectionCurrency,
        installment: `${Number(current)}/${Number(total)}`,
        currencyCertain: true,
      })
      return
    }
    if (!new RegExp(AMOUNT).test(rest)) return // a date in a heading ("12 sep 26", the billing cycle), not a movement
    if (documentCurrencies.size > 1 && !hasExplicitSection && !currenciesIn(rest).length)
      parsed.currencyAmbiguous = true
    const rowAmounts = currencyAmounts(rest, sectionCurrency, columns)
    if (!rowAmounts || rowAmounts.length > 1) parsed.currencyAmbiguous = true
    const rowCurrency = rowAmounts?.length === 1 ? rowAmounts[0].currency : sectionCurrency
    const currencyCertain =
      rowAmounts?.length === 1 && (currenciesIn(rest).length > 0 || hasExplicitSection || documentCurrencies.size <= 1)
    const cancellation = cancellationDescription.test(rest)
    const separateCredit = new RegExp(`-\\s*(${AMOUNT})\\s*$`).exec(rest)
    const amountMatch = separateCredit ?? new RegExp(`(${AMOUNT})\\s*(-|cr)?$`).exec(rest)
    if (!amountMatch || (amountMatch[2] && !separateCredit)) return // other credits and payments are not purchases
    const absoluteAmount = Math.abs(amountOf(amountMatch[1]))
    if (absoluteAmount <= 0 || (separateCredit && !cancellation)) return
    const amount = cancellation && separateCredit ? -absoluteAmount : absoluteAmount

    let description = rest
      .slice(0, amountMatch.index)
      .replace(/\b(s\/|us\$|pen|usd)\s*$/i, '')
      .trim()
    // "1/3" or, as IO prints it, "1 de 3"
    const installment = /(?:cuota\s*)?\b(\d{1,2})\s*(?:\/|de)\s*(\d{1,2})\b/.exec(description)
    let installmentText: string | null = null
    if (installment && Number(installment[1]) <= Number(installment[2]) && Number(installment[2]) <= 48) {
      installmentText = `${Number(installment[1])}/${Number(installment[2])}`
      description = description.replace(installment[0], '').trim()
    }
    const pretty = prettyOf(original, description)
    if (!pretty) return

    parsed.rows.push({
      date: first.iso,
      description: pretty,
      amount,
      currency: rowCurrency,
      installment: installmentText,
      currencyCertain,
      ...(cancellation && separateCredit ? { locked: true } : {}),
    })
  })

  // Interest, insurance and fees of the summary are charges of the statement that no purchase line carries
  for (const charge of charges)
    parsed.rows.push({
      date: parsed.periodEnd,
      description: charge.description,
      amount: charge.amount,
      currency: charge.currency,
      installment: null,
      currencyCertain: true,
    })

  for (const balance of parsed.balances ?? []) {
    if (balance.previousBalance == null || balance.previousPayments == null) continue
    const remainder = toCents(balance.previousBalance - balance.previousPayments)
    if (remainder > 0)
      parsed.rows.push({
        date: null,
        description: `Saldo mes anterior neto (${balance.previousBalance.toFixed(2)} - ${balance.previousPayments.toFixed(2)})`,
        amount: remainder,
        currency: balance.currency,
        installment: null,
      })
  }

  // Keep a balance row even when the PDF has movements but no printed total in that currency.
  for (const row of parsed.rows) {
    if (!parsed.balances?.some((balance) => balance.currency === row.currency)) {
      parsed.balances ??= []
      parsed.balances.push(emptyStatementBalance(row.currency))
    }
  }
  // A purchase and its cancellation remain visible together, but neither should become a new expense.
  parsed.rows = lockCancelledStatementRows(parsed.rows)
  return parsed
}

// A template result is trusted only when its purchases add up to the total of the statement
export function templateAddsUp(parsed: ParsedStatement): boolean {
  if (!parsed.rows.length || parsed.currencyAmbiguous) return false
  const balances = statementBalances(parsed)
  if (parsed.rows.some((row) => !balances.some((balance) => balance.currency === row.currency))) return false
  return balances.every((balance) => {
    if (balance.totalDue == null) return false
    const sum = toCents(
      parsed.rows.filter((row) => row.currency === balance.currency).reduce((total, row) => total + row.amount, 0),
    )
    return Math.abs(sum - balance.totalDue) <= Math.max(STATEMENT_TOTAL_TOLERANCE, balance.totalDue * 0.01)
  })
}

// What the AI may read: the document number and long digit runs (card and account numbers) are masked (D94)
export function maskForAi(lines: string[], documentNumber: string | null): string {
  let text = lines.join('\n')
  if (documentNumber) text = text.split(documentNumber).join('********')
  return text.replace(/\b(?:\d[ *xX-]?){12,19}\b/g, '[número]')
}
