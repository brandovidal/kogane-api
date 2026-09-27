import { formatReconcile, ReconcileSummary } from './reconcile.messages'

const summary = (overrides: Partial<ReconcileSummary> = {}): ReconcileSummary => ({
  card: 'CMR',
  month: 9,
  year: 2026,
  currency: 'PEN',
  totalDue: 500,
  registered: 500,
  newRows: 0,
  missing: [],
  ...overrides,
})

describe('formatReconcile', () => {
  it('should say it all adds up', () => {
    expect(formatReconcile(summary())).toContain('Todo cuadra ✅')
  })

  it('should give the difference, what the statement has that Kogane does not, and what Kogane has extra', () => {
    const text = formatReconcile(
      summary({ registered: 420, newRows: 2, missing: [{ description: 'Cine', amount: 30 }] }),
    )

    expect(text).toContain('Estado: <b>S/ 500.00</b> · Kogane: <b>S/ 420.00</b>')
    expect(text).toContain('Diferencia: <b>S/ 80.00</b> que Kogane no tiene')
    expect(text).toContain('2 movimientos del estado sin registrar')
    expect(text).toContain('– Cine · S/ 30.00')
  })

  it('should say when Kogane has more than the statement', () => {
    expect(formatReconcile(summary({ registered: 530 }))).toContain('Diferencia: <b>S/ 30.00</b> de más en Kogane')
  })

  it('should not judge a statement without a total', () => {
    const text = formatReconcile(summary({ totalDue: null }))

    expect(text).toContain('no trae el total')
    expect(text).not.toContain('cuadra')
  })
})
