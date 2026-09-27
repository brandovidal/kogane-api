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
    ;[...byLine.entries()]
      .sort(([a], [b]) => b - a)
      .forEach(([, unsorted]) => {
        const parts = [...unsorted].sort((a, b) => a.x - b.x)
        columns = columnsFromHeader(parts) ?? columns
        lines.push(
          markCurrencyColumn(parts, columns)
            .map((part) => part.text)
            .join(' '),
        )
      })
  }
  await pdf.destroy()
  return lines
}
