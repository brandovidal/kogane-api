import { assignRowPeople, inferHolder, matchCard, rowHolderHints } from './statement.identity'

const PEOPLE = [
  { id: 'me', name: 'Brando', aliases: [] },
  { id: 'dany', name: 'Danery', aliases: ['dany'] },
]
const CARDS = [
  { id: 'io', name: 'IO', aliases: ['interbank io'], code: 'IO' },
  { id: 'oh', name: 'Sip', aliases: ['oh', 'oh pay'], code: 'OH' },
  { id: 'cmr', name: 'CMR', aliases: ['falabella'], code: 'CMR' },
]

describe('statement identity (P14)', () => {
  it('should find the holder on a titular line or in the name the AI read, never elsewhere in the text', () => {
    expect(inferHolder(PEOPLE, ['Nombre del titular: DANERY QUISPE'])?.id).toBe('dany')
    expect(inferHolder(PEOPLE, ['Estado de cuenta'], 'BRANDO VIDAL DEZA')?.id).toBe('me')
    expect(inferHolder(PEOPLE, ['Yape a Danery 50.00'])).toBeNull()
  })

  it('should take the chosen card, then the parsed code, then a single card named in the text', () => {
    expect(matchCard(CARDS, { chosenId: 'cmr', hint: 'OH', lines: [] })?.id).toBe('cmr')
    expect(matchCard(CARDS, { hint: 'OH', lines: [] })?.id).toBe('oh')
    expect(matchCard(CARDS, { hint: null, cardName: 'Oh Pay Visa', lines: [] })?.id).toBe('oh')
    expect(matchCard(CARDS, { hint: null, lines: ['Banco Falabella · CMR Mastercard'] })?.id).toBe('cmr')
  })

  it('should not guess when no card or several cards are named, nor match a short name inside a word', () => {
    expect(matchCard(CARDS, { hint: null, lines: ['Servicio de mantenimiento'] })).toBeNull()
    expect(matchCard(CARDS, { hint: null, lines: ['Pago CMR y pago Sip'] })).toBeNull()
  })

  it('should not guess a card from a purchase row, only from the header (a store chain like Falabella can be bought with any card)', () => {
    expect(
      matchCard(CARDS, { hint: null, lines: ['ESTADO DE CUENTA', '17/07 Compra Falabella.com Peru 197.80'] }),
    ).toBeNull()
    // The same word in the header (not a purchase row) still identifies the card
    expect(matchCard(CARDS, { hint: null, lines: ['Estado de cuenta Falabella CMR'] })?.id).toBe('cmr')
  })
})

describe('the person of each purchase (D116)', () => {
  const people = [
    { id: 'me', name: 'Brando', aliases: [] },
    { id: 'dany', name: 'Danery', aliases: ['dany'] },
    { id: 'dora', name: 'Dora', aliases: [] },
  ]
  const holder = (personId: string, role: string, last4: string | null = null) => ({
    personId,
    role,
    last4,
    person: people.find((person) => person.id === personId)!,
  })

  it('should give each CMR purchase to the section it is under, and the card charges to the titular', () => {
    const lines = [
      'Brando Jesus Vidal Deza Tc: 447410******1810',
      '17/07/2026 17/07/2026 Compra Falabella.com Peru 197.80',
      'Danery Vidal Deza Tc: 447410******8835',
      '09/07/2026 10/07/2026 Compra Leonisa Peru 247.37',
      '06/05/2026 09/08/2026 Compra En Cuotas Teleticket Peru 874.00 04/06 109.81% 149.41 30.40 179.81',
      'Dora Deza Lopez Tc: 447410******6089',
      '20/08/2026 21/08/2026 Compra Ripley Peru 203.14',
      '09/08/2026 09/08/2026 Seguro Desgravamen 13.90',
      '09/08/2026 09/08/2026 Interes Compensatorio 1,459.80',
    ]
    const rows = [
      { description: 'Compra En Cuotas Teleticket Peru', amount: 179.81 },
      { description: 'Compra Falabella.com Peru', amount: 197.8 },
      { description: 'Compra Leonisa Peru', amount: 247.37 },
      { description: 'Compra Ripley Peru', amount: 203.14 },
      { description: 'Seguro Desgravamen', amount: 13.9 },
      { description: 'Interes Compensatorio', amount: 1459.8 },
    ]

    const hints = rowHolderHints(lines, rows)
    expect(hints.map((hint) => hint.last4)).toEqual(['8835', '1810', '8835', '6089', '6089', '6089'])

    // Dora's card is known by its digits; Danery only by her name in the section
    const holders = [holder('me', 'titular', '1810'), holder('dora', 'additional', '6089')]
    expect(assignRowPeople(rows, hints, { titularId: 'me', holders, people })).toEqual([
      'dany',
      'me',
      'dany',
      'dora',
      'me',
      'me',
    ])
  })

  it("should read Sip's TIT/ADIC column: T is the titular, empty the only additional of the card", () => {
    const lines = [
      'DETALLE DE MOVIMIENTO DEL MES TIT/ADIC.',
      '25/06/2026 COMPANIA FOOD RETAIL T 272.28',
      '26/06/2026 TAMBO VIRREY 35.50',
      '08/07/2026 SEGURO DE DESGRAVAMEN 3.58',
    ]
    const rows = [
      { description: 'COMPANIA FOOD RETAIL', amount: 272.28 },
      { description: 'TAMBO VIRREY', amount: 35.5 },
      { description: 'SEGURO DE DESGRAVAMEN', amount: 3.58 },
    ]
    const hints = rowHolderHints(lines, rows)
    expect(hints.map((hint) => hint.titular)).toEqual([true, false, false])

    const one = [holder('me', 'titular'), holder('dany', 'additional')]
    expect(assignRowPeople(rows, hints, { titularId: 'me', holders: one, people })).toEqual(['me', 'dany', 'me'])
    // With two additional cards the PDF does not say which: the titular, to reassign by hand
    const two = [...one, holder('dora', 'additional')]
    expect(assignRowPeople(rows, hints, { titularId: 'me', holders: two, people })[1]).toBe('me')
  })

  it('should leave everything to the titular when the PDF has no sections nor TIT/ADIC (IO)', () => {
    const rows = [{ description: 'PLAZA VEA', amount: 80 }]
    const hints = rowHolderHints(['01-AGO PLAZA VEA 80.00'], rows)
    expect(assignRowPeople(rows, hints, { titularId: 'me', holders: [], people })).toEqual(['me'])
  })
})
