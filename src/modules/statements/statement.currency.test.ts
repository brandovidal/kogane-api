import { parseStatementLines, templateAddsUp, lockCancelledStatementRows } from './statement.parser'
import { reconcileStatement } from './statement.reconcile'

const row = (currency: string, amount = 25) => ({
  date: '2026-09-01',
  description: 'STORE',
  amount,
  currency,
  installment: null,
})

describe('statement currency isolation', () => {
  it('keeps the two bank totals and each movement currency', () => {
    const parsed = parseStatementLines([
      'Tarjeta IO',
      'Fecha de cierre 25/09/2026',
      'Fecha limite de pago 12/10/2026',
      'Total a pagar S/ 100.00 US$ 25.00',
      'Pago minimo S/ 10.00 US$ 5.00',
      '01/09/2026 STORE S/ 100.00',
      '02/09/2026 RAILWAY US$ 25.00',
    ])
    expect(parsed.rows.map(({ currency, amount }) => ({ currency, amount }))).toEqual([
      { currency: 'PEN', amount: 100 },
      { currency: 'USD', amount: 25 },
    ])
    expect(parsed).toMatchObject({
      balances: [
        { currency: 'PEN', totalDue: 100, minimumDue: 10 },
        { currency: 'USD', totalDue: 25, minimumDue: 5 },
      ],
    })
    expect(templateAddsUp(parsed)).toBe(true)
  })
  it('does not reconcile equal amounts across currencies', () => {
    const result = reconcileStatement([row('USD')], [{ id: 'pen', ...row('PEN'), processDate: '2026-09-01' }])
    expect(result.rows[0].result).toBe('new')
  })
  it('does not cancel a purchase with a reversal in another currency', () => {
    expect(
      lockCancelledStatementRows([row('USD'), { ...row('PEN', -25), description: 'ANULACION STORE' }])[0].locked,
    ).not.toBe(true)
  })
  it('trusts the currency readPdfLines already marked by column position (real bug: IO rows with no inline symbol)', () => {
    // As readPdfLines leaves a two-column "SOLES … DÓLARES" table once it has marked each row by its X position
    // (statement-pdf.reader.ts): the header repeats per table, and rows never carry their own symbol
    const parsed = parseStatementLines([
      'Fecha de cierre 25/09/2026',
      'Total a pagar S/ 100.00 US$ 25.00',
      'FECHA DESCRIPCION SOLES DOLARES',
      '20/09/2026 CINEPLANET S/ 100.00',
      'FECHA DESCRIPCION SOLES DOLARES',
      '23/09/2026 RAILWAY US$ 25.00',
    ])
    expect(parsed.rows.map(({ description, currency, amount }) => ({ description, currency, amount }))).toEqual([
      { description: 'CINEPLANET', currency: 'PEN', amount: 100 },
      { description: 'RAILWAY', currency: 'USD', amount: 25 },
    ])
    expect(templateAddsUp(parsed)).toBe(true)
  })

  it('does not trust a mixed statement just because different currencies add up together', () => {
    const parsed = parseStatementLines([
      'Fecha de cierre 25/09/2026',
      'Total a pagar S/ 125.00',
      '01/09/2026 STORE S/ 100.00',
      '02/09/2026 RAILWAY US$ 25.00',
    ])
    expect(templateAddsUp(parsed)).toBe(false)
  })
})
