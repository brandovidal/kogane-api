import { normalizeText } from '@/modules/expense-extraction/expense-extraction.catalog'

interface Named {
  id: string
  name: string
  aliases: string[]
}

interface Card extends Named {
  code: string | null
}

const HOLDER_LINE = /\b(titular|cliente|nombre del titular|nombre del cliente|tarjetahabiente)\b/

const termsOf = (entry: Named) =>
  [entry.name, ...entry.aliases].map((term) => normalizeText(term.trim())).filter((term) => term.length > 1)

// Whole words only: "io" must not match inside "servicio"
const hasWord = (text: string, term: string) =>
  new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(text)

// A purchase or payment row of a statement, not its header: it always ends in a decimal amount ("164.90", "1,459.80").
// Aliases can be a generic word (a store chain, e.g. CMR's alias "falabella") that only shows up in one of these rows
// ("Compra Falabella.com Peru", bought with a different card) and would misidentify the card; the header never needs one
const looksLikeARow = (line: string) => /\d[.,]\d{2}\s*(cr|-)?\s*$/i.test(line)

// Whose statement it is: a person named on a holder line of the PDF or in the holder the AI read (D94, P14)
export function inferHolder<T extends Named>(people: T[], lines: string[], holderName?: string | null): T | null {
  const holderLines = [
    ...lines.map(normalizeText).filter((line) => HOLDER_LINE.test(line)),
    ...(holderName ? [normalizeText(holderName)] : []),
  ]
  return (
    people.find((person) => termsOf(person).some((term) => holderLines.some((line) => hasWord(line, term)))) ?? null
  )
}

// Which card: the one chosen, else the code the parser saw, else the card name the AI read or a line of the PDF
// that names the card or one of its aliases
export function matchCard<T extends Card>(
  cards: T[],
  {
    chosenId,
    hint,
    cardName,
    lines,
  }: { chosenId?: string | null; hint: string | null; cardName?: string | null; lines: string[] },
): T | null {
  if (chosenId) return cards.find((card) => card.id === chosenId) ?? null
  const byCode = hint ? cards.find((card) => card.code === hint) : undefined
  if (byCode) return byCode

  const texts = [...(cardName ? [cardName] : []), ...lines.filter((line) => !looksLikeARow(line)).slice(0, 40)].map(
    normalizeText,
  )
  const named = cards.filter((card) =>
    termsOf(card).some((term) => term.length > 2 && texts.some((text) => hasWord(text, term))),
  )
  return named.length === 1 ? named[0] : null
}

// ==================== The person of each purchase (D116) ====================

export interface RowHolderHint {
  name: string | null // the section the purchase is under (CMR: "Danery Vidal Deza Tc: 447410******8835")
  last4: string | null // the card of that section
  titular: boolean | null // Sip's TIT/ADIC column: T = titular, empty = additional; null when the PDF has no such column
}

// "<name> Tc: 447410******8835": every line below belongs to that card until the next one
const SECTION = /^(.+?)\s+tc\s*:?\s*[\d*\s]*?(\d{4})\s*$/i
const TIT_ADIC = /tit\s*\/\s*adic/
// A "T" right before the amount of the line (the TIT/ADIC column of Sip)
const TITULAR_MARK = /\st\s+-?\s*[\d.,]+\s*$/
// Charges of the card itself, always the titular's (they can be reassigned by hand)
const CARD_CHARGE =
  /\b(seguro( de)? desgravamen|desgravamen|interes(es)?|comision(es)?|membresia|itf|mora|moratorio|penalidad)\b/

const amountTexts = (amount: number) => {
  const plain = Math.abs(amount).toFixed(2)
  return [plain, Number(plain).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })]
}

// Where each read row is in the PDF (its words and amount, top to bottom, each line used once): the section above it
// and its TIT/ADIC mark. Works the same whether the template or the AI read the rows
export function rowHolderHints(lines: string[], rows: { description: string; amount: number }[]): RowHolderHint[] {
  const normalized = lines.map(normalizeText)
  let section: { name: string; last4: string } | null = null
  const sectionAt = lines.map((line) => {
    const match = line.trim().match(SECTION)
    if (match) section = { name: match[1].trim(), last4: match[2] }
    return section
  })
  const hasTitAdic = normalized.some((line) => TIT_ADIC.test(line))
  const used = new Set<number>()

  return rows.map((row) => {
    const words = normalizeText(row.description)
      .split(' ')
      .filter((word) => word.length > 2)
      .slice(0, 3)
    const amounts = amountTexts(row.amount)
    const index = normalized.findIndex(
      (line, at) =>
        !used.has(at) && words.every((word) => line.includes(word)) && amounts.some((amount) => line.includes(amount)),
    )
    if (index < 0) return { name: null, last4: null, titular: null }
    used.add(index)
    const current = sectionAt[index]
    return {
      name: current?.name ?? null,
      last4: current?.last4 ?? null,
      titular: hasTitAdic ? TITULAR_MARK.test(normalized[index]) : null,
    }
  })
}

export interface CardHolderForMatch {
  personId: string
  role: string // CardHolderRole
  last4: string | null
  person: Named
}

// Whose each purchase is (D116): card charges → titular; else the card of its section (last 4 digits), the person
// its section names, the TIT/ADIC mark (T = titular, empty = the only additional), and the titular otherwise
export function assignRowPeople(
  rows: { description: string }[],
  hints: RowHolderHint[],
  { titularId, holders, people }: { titularId: string; holders: CardHolderForMatch[]; people: Named[] },
): string[] {
  const titular = holders.find((holder) => holder.role === 'titular')?.personId ?? titularId
  const additional = holders.filter((holder) => holder.role !== 'titular')
  const named = (name: string) => {
    const text = normalizeText(name)
    const byTerms = (person: Named) => termsOf(person).some((term) => term.length > 2 && hasWord(text, term))
    return holders.find((holder) => byTerms(holder.person))?.personId ?? people.find(byTerms)?.id ?? null
  }

  return rows.map((row, index) => {
    if (CARD_CHARGE.test(normalizeText(row.description))) return titular
    const hint = hints[index]
    if (!hint) return titular
    const byCard = hint.last4 ? holders.find((holder) => holder.last4 === hint.last4)?.personId : null
    if (byCard) return byCard
    const byName = hint.name ? named(hint.name) : null
    if (byName) return byName
    if (hint.titular === false && additional.length === 1) return additional[0].personId
    return titular
  })
}
