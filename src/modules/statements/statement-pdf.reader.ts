import { StatementPasswordException } from '@/commons/exceptions/statement/statement-password.exception'
import { StatementUnreadableException } from '@/commons/exceptions/statement/statement-unreadable.exception'

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

// pdfjs-dist is ESM only: a native import() in the CommonJS build (TypeScript would turn a plain one into require());
// test runners without a dynamic import callback use the plain one, which they resolve themselves
const nativeImport = new Function('return import("pdfjs-dist/legacy/build/pdf.mjs")') as () => Promise<PdfJs>
async function loadPdfJs(): Promise<PdfJs> {
  try {
    return await nativeImport()
  } catch {
    return import('pdfjs-dist/legacy/build/pdf.mjs')
  }
}

// pdf.js PasswordException codes
const NEED_PASSWORD = 1

interface TextItem {
  str: string
  transform: number[]
}

interface LinePart {
  x: number
  text: string
}

interface MoneyColumns {
  soles: number
  dolares: number
}

const normalize = (text: string) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()

// A monetary amount as printed ("164.90", "1,459.80"), the same shape statement.parser's AMOUNT matches
const AMOUNT = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}-?$/
// The amount already carries its own symbol ("S/ 100.00", "US$ 25.00")
const HAS_MARKER = /us\s*\$|\$|s\/\.?|\busd\b|\bpen\b/i

// A "SOLES … DÓLARES" table header: its X positions stay in effect for the rows printed under it, until the next
// header (banks repeat it per table: Abonos, Consumos directos, Consumos en cuotas)
function columnsFromHeader(parts: LinePart[]): MoneyColumns | null {
  const soles = parts.find((part) => normalize(part.text) === 'soles')
  const dolares = parts.find((part) => normalize(part.text) === 'dolares')
  return soles && dolares ? { soles: soles.x, dolares: dolares.x } : null
}

// A row of a two-column money table without an inline symbol ("23-SEP RAILWAY 5.00" under DÓLARES): which column its
// amount was under is only visible from its X position on the page, so it is marked here before the line is joined
// into plain text — the parser already strips a marker right before the amount, so this is transparent downstream
function markCurrencyColumn(parts: LinePart[], columns: MoneyColumns | null): LinePart[] {
  if (!columns) return parts
  const last = parts.reduce<{ index: number; part: LinePart } | null>(
    (found, part, index) => (AMOUNT.test(part.text) ? { index, part } : found),
    null,
  )
  if (!last) return parts
  if (parts.slice(0, last.index).some((part) => HAS_MARKER.test(part.text))) return parts
  const marker = Math.abs(last.part.x - columns.soles) <= Math.abs(last.part.x - columns.dolares) ? 'S/' : 'US$'
  return [...parts.slice(0, last.index), { x: last.part.x, text: marker }, ...parts.slice(last.index)]
}

interface PrintedLine {
  y: number
  parts: LinePart[]
}

const DATED = /^\d{1,2}(?:[-/ ]?(?:ene|feb|mar|abr|may|jun|jul|ago|set|sep|oct|nov|dic)|[/-]\d{1,2})\b/i
const CURRENCY_SYMBOL = /^(?:s\/\.?|us\$)$/i

// A long merchant name wraps over several lines in a table row (IO's Consumos en cuotas: "PAGO DE" above the row,
// "SUNAT" below it), centred on the row: those fragments have no date nor amount and sit in the description column,
// closer to their row than to the next one. They are joined into the row so the parser reads one movement per line
function attachWrappedDescriptions(printed: PrintedLine[]): PrintedLine[] {
  const isDated = (line: PrintedLine) =>
    DATED.test(line.parts[0]?.text ?? '') && line.parts.length > 1 && line.parts.some((part) => AMOUNT.test(part.text))
  const dated = printed.filter(isDated)
  if (dated.length < 2) return printed
  const pitches = dated
    .slice(1)
    .map((line, index) => dated[index].y - line.y)
    .filter((pitch) => pitch > 0)
    .sort((a, b) => a - b)
  const reach = Math.min(14, (pitches[Math.floor(pitches.length / 2)] ?? 0) / 2)
  // The description columns (a page can hold tables with different ones): where the rows that print their name on
  // the row itself start it
  const descriptionXs = dated
    .map((line) => line.parts[1])
    .filter((part) => !AMOUNT.test(part.text) && !CURRENCY_SYMBOL.test(part.text))
    .map((part) => part.x)
  if (!descriptionXs.length) return printed

  const before = new Map<PrintedLine, LinePart[]>()
  const after = new Map<PrintedLine, LinePart[]>()
  const absorbed = new Set<PrintedLine>()
  for (const line of printed) {
    if (isDated(line) || line.parts.some((part) => AMOUNT.test(part.text) || DATED.test(part.text))) continue
    const row = dated.reduce((nearest, candidate) =>
      Math.abs(candidate.y - line.y) < Math.abs(nearest.y - line.y) ? candidate : nearest,
    )
    const distance = Math.abs(row.y - line.y)
    if (distance === 0 || distance > reach || !descriptionXs.some((x) => Math.abs(x - line.parts[0].x) <= 6)) continue
    const side = line.y > row.y ? before : after
    side.set(row, [...(side.get(row) ?? []), ...line.parts])
    absorbed.add(line)
  }

  return printed
    .filter((line) => !absorbed.has(line))
    .map((line) => {
      if (!before.has(line) && !after.has(line)) return line
      const [date, ...rest] = line.parts
      const end = rest.findIndex((part) => AMOUNT.test(part.text) || CURRENCY_SYMBOL.test(part.text))
      const description = rest.slice(0, end)
      return {
        y: line.y,
        parts: [date, ...(before.get(line) ?? []), ...description, ...(after.get(line) ?? []), ...rest.slice(end)],
      }
    })
}

// The text of a statement PDF, one string per printed line (items of the same height joined left to right).
// The password is the document number of the owner (D94); it never leaves the server.
export async function readPdfLines(data: Buffer, password?: string | null): Promise<string[]> {
  const pdfjs = await loadPdfJs()
  let pdf: Awaited<ReturnType<PdfJs['getDocument']>['promise']>
  try {
    pdf = await pdfjs.getDocument({
      data: new Uint8Array(data),
      password: password ?? undefined,
      verbosity: 0,
    }).promise
  } catch (error) {
    const { name, code } = error as { name?: string; code?: number }
    if (name === 'PasswordException') {
      throw new StatementPasswordException({ reason: code === NEED_PASSWORD && !password ? 'missing' : 'incorrect' })
    }
    throw new StatementUnreadableException({ reason: 'not a PDF' })
  }

  const lines: string[] = []
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber)
    const { items } = await page.getTextContent()
    const byLine = new Map<number, LinePart[]>()
    for (const item of items as TextItem[]) {
      if (!item.str?.trim()) continue
      // Items of one printed line differ by a point or two in height
      const y = Math.round(item.transform[5] / 2) * 2
      byLine.set(y, [...(byLine.get(y) ?? []), { x: item.transform[4], text: item.str.trim() }])
    }
    let columns: MoneyColumns | null = null
    const printed = [...byLine.entries()]
      .sort(([a], [b]) => b - a)
      .map(([y, unsorted]) => {
        const parts = [...unsorted].sort((a, b) => a.x - b.x)
        columns = columnsFromHeader(parts) ?? columns
        return { y, parts: markCurrencyColumn(parts, columns) }
      })
    attachWrappedDescriptions(printed).forEach(({ parts }) => lines.push(parts.map((part) => part.text).join(' ')))
  }
  await pdf.destroy()
  return lines
}
