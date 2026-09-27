import { detectCardHint, maskForAi, parseStatementLines, templateAddsUp } from './statement.parser'

const SIP = [
  'ESTADO DE CUENTA - TARJETA SIP',
  'Fecha de cierre 10/09/2026',
  'Ultimo dia de pago 05/10/2026',
  'Total a pagar S/ 250.40',
  'Pago minimo 40.00',
  '15/08 16/08 MP*MERCADOLI 1/3 164.90',
  '20/08 20/08 TAMBO VIRREY 35.50',
  '02/09 03/09 NETFLIX.COM 50.00',
  '05/09 SU PAGO GRACIAS 300.00-',
  '06/09 DEVOLUCION TIENDA 20.00 CR',
]

describe('statement.parser', () => {
  it('should read the dates, totals and purchases of a statement, without payments or credits', () => {
    const parsed = parseStatementLines(SIP)

    expect(parsed).toMatchObject({
      cardHint: 'OH',
      periodEnd: '2026-09-10',
      dueDate: '2026-10-05',
      totalDue: 250.4,
      minimumDue: 40,
      currency: 'PEN',
    })
    expect(parsed.rows).toEqual([
      { date: '2026-08-15', description: 'MP*MERCADOLI', amount: 164.9, currency: 'PEN', installment: '1/3' },
      { date: '2026-08-20', description: 'TAMBO VIRREY', amount: 35.5, currency: 'PEN', installment: null },
      { date: '2026-09-02', description: 'NETFLIX.COM', amount: 50, currency: 'PEN', installment: null },
    ])
    expect(templateAddsUp(parsed)).toBe(true)
  })

  it('should read "N de M" installments too (IO prints it that way, not "N/M")', () => {
    const parsed = parseStatementLines([
      'Fecha de cierre 25/09/2026',
      'Total a pagar 122.68',
      '10/09/2026 FREEPASS 2 de 3 122.68',
    ])

    expect(parsed.rows).toEqual([
      { date: '2026-09-10', description: 'FREEPASS', amount: 122.68, currency: 'PEN', installment: '2/3' },
    ])
  })

  it('should read month names and thousands separators', () => {
    const parsed = parseStatementLines([
      'American Express Green',
      'Fecha limite de pago: 15 OCT 2026',
      'Monto total a pagar 1,234.50',
      '21 SET PLAZA VEA 1,234.50',
    ])
    expect(parsed).toMatchObject({ cardHint: 'AMEX', dueDate: '2026-10-15', totalDue: 1234.5 })
    expect(parsed.rows).toEqual([
      { date: '2026-09-21', description: 'PLAZA VEA', amount: 1234.5, currency: 'PEN', installment: null },
    ])
  })

  it('should include itemized insurance and interest charges as statement movements', () => {
    const parsed = parseStatementLines([
      'Fecha de cierre 09/09/2026',
      'Total a pagar S/ 561.71',
      '09/09/2026 09/09/2026 Seguro Desgravamen 13.90',
      '09/09/2026 09/09/2026 Interes Compensatorio 545.99',
      '09/09/2026 09/09/2026 Interes Moratorio 1.82',
    ])

    expect(parsed.rows.map(({ description, amount }) => ({ description, amount }))).toEqual([
      { description: 'Seguro Desgravamen', amount: 13.9 },
      { description: 'Interes Compensatorio', amount: 545.99 },
      { description: 'Interes Moratorio', amount: 1.82 },
    ])
  })

  it('should not trust a template whose purchases do not add up to the total', () => {
    const parsed = parseStatementLines(['Total a pagar 500.00', 'Fecha de cierre 10/09/2026', '01/09 CINE 20.00'])
    expect(templateAddsUp(parsed)).toBe(false)
    expect(templateAddsUp(parseStatementLines(['01/09/2026 CINE 20.00']))).toBe(false)
  })

  it('should tell the card from the text', () => {
    expect(detectCardHint('Tarjeta oh! ahora es Sip')).toBe('OH')
    expect(detectCardHint('AMERICAN EXPRESS GREEN')).toBe('AMEX')
    expect(detectCardHint('CMR Falabella')).toBe('CMR')
    expect(detectCardHint('Tarjeta iO')).toBe('IO')
    expect(detectCardHint('Banco')).toBeNull()
  })

  it('should not guess CMR from a "Falabella" purchase alone: it is a store chain, not only a CMR thing', () => {
    // A Falabella.com purchase can be on any card's statement, not only CMR's (real bug: every statement with one
    // of these got tagged CMR)
    expect(detectCardHint('15/08 Compra Falabella.com Peru 197.80')).toBeNull()
    expect(detectCardHint('Compra Sodimac Falabella 120.00')).toBeNull()
  })

  it('should mask the document number and long numbers before the AI reads the text (D94)', () => {
    expect(maskForAi(['Titular DNI 44556677', 'Tarjeta 4557 8800 1234 5678'], '44556677')).toBe(
      'Titular DNI ********\nTarjeta [número]',
    )
  })
})
