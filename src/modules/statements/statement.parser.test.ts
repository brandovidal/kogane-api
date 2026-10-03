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
      {
        date: '2026-08-15',
        description: 'MP*MERCADOLI',
        amount: 164.9,
        currency: 'PEN',
        installment: '1/3',
        currencyCertain: true,
      },
      {
        date: '2026-08-20',
        description: 'TAMBO VIRREY',
        amount: 35.5,
        currency: 'PEN',
        installment: null,
        currencyCertain: true,
      },
      {
        date: '2026-09-02',
        description: 'NETFLIX.COM',
        amount: 50,
        currency: 'PEN',
        installment: null,
        currencyCertain: true,
      },
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
      {
        date: '2026-09-10',
        description: 'FREEPASS',
        amount: 122.68,
        currency: 'PEN',
        installment: '2/3',
        currencyCertain: true,
      },
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
      {
        date: '2026-09-21',
        description: 'PLAZA VEA',
        amount: 1234.5,
        currency: 'PEN',
        installment: null,
        currencyCertain: true,
      },
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

  // IO (two currencies): the dates sit below their headings, payments have their own table, wrapped merchant names are
  // already joined by the reader, and interest and insurance only appear in the summary
  it('should add up an IO statement: purchases, installments, interest, insurance and the previous balance', () => {
    const parsed = parseStatementLines([
      'Tarjeta de Crédito iO del 26/08/2026 hasta el 25/09/2026',
      'ÚLTIMO DÍA DE PAGO SOLES DÓLARES',
      'Pago total del mes Pago total del mes',
      'Sábado',
      'S/11,339.85 $247.54',
      '12 oct 26',
      'Pago mínimo Pago mínimo',
      'S/4,978.36 $223.23',
      'Abonos',
      'FECHA DESCRIPCIÓN SOLES DÓLARES',
      '31-AGO PAGO DE TARJETA iO S/ 5,000.00',
      '31-AGO PAGO DE TARJETA iO US$ 337.46',
      'SUBTOTAL 5,721.83 US$ 337.46',
      'Consumos directos (Sin cuotas)',
      'FECHA DESCRIPCIÓN SOLES DÓLARES',
      '18-SEP BITEL S/ 27.95',
      '23-SEP RAILWAY US$ 5.00',
      'SUBTOTAL 1,824.45 US$ 25.00',
      'Consumos en cuotas',
      'FECHA DESCRIPCIÓN #CUOTAS INTERÉS TEA SOLES DÓLARES',
      '10-MAR RIMAC PL VIDA USD 2,037.93 7 de 12 165.66 56.88 76.90% US$ 222.54',
      '20-AGO PAGO DE IMPUESTOS SUNAT 1,392.00 2 de 4 322.53 59.17 91.90% S/ 4,395.76',
      'SUBTOTAL 4,395.76 US$ 222.54',
      'SALDO PENDIENTE DEL MES ANTERIOR 10,440.63 US$ 337.46',
      '- ABONOS DEL MES ACTUAL 5,721.83 US$ 337.46',
      '+ CONSUMOS DIRECTOS (SIN CUOTAS) 1,824.45 US$ 5.00',
      '+ CONSUMOS EN CUOTAS 4,395.76 US$ 222.54',
      '+ INTERÉS COMPENSATORIO 380.84 US$ 0.00',
      '+ SEGURO DE DESGRAVAMEN 20.00 US$ 0.00',
      '= PAGO TOTAL DEL MES 11,339.85 US$ 247.54',
    ])

    expect(parsed).toMatchObject({ cardHint: 'IO', periodEnd: '2026-09-25', dueDate: '2026-10-12' })
    expect(parsed.balances).toEqual([
      expect.objectContaining({
        currency: 'PEN',
        totalDue: 11339.85,
        previousBalance: 10440.63,
        previousPayments: 5721.83,
      }),
      expect.objectContaining({ currency: 'USD', totalDue: 247.54, previousBalance: 337.46, previousPayments: 337.46 }),
    ])
    const rows = parsed.rows.map(({ description, amount, currency, installment }) => ({
      description,
      amount,
      currency,
      installment,
    }))
    expect(rows).toEqual([
      { description: 'BITEL', amount: 27.95, currency: 'PEN', installment: null },
      { description: 'RAILWAY', amount: 5, currency: 'USD', installment: null },
      { description: 'RIMAC PL VIDA USD', amount: 222.54, currency: 'USD', installment: '7/12' },
      { description: 'PAGO DE IMPUESTOS SUNAT', amount: 4395.76, currency: 'PEN', installment: '2/4' },
      { description: 'Interes compensatorio', amount: 380.84, currency: 'PEN', installment: null },
      { description: 'Seguro de desgravamen', amount: 20, currency: 'PEN', installment: null },
      {
        description: 'Saldo mes anterior neto (10440.63 - 5721.83)',
        amount: 4718.8,
        currency: 'PEN',
        installment: null,
      },
    ])
  })
})
