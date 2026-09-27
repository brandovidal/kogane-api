import { formatCards, formatToday, formatWeek, SpendingRow } from './spending.messages'

const row = (overrides: Partial<SpendingRow> = {}): SpendingRow => ({
  description: 'Almuerzo',
  amount: 25,
  currency: 'PEN',
  own: 25,
  date: '2026-09-26',
  method: 'Yape',
  category: 'Comida',
  ...overrides,
})

describe('formatToday', () => {
  it('should list the expenses of the day and add up your part', () => {
    const text = formatToday(
      [row(), row({ description: 'Uber', amount: 18.5, own: 18.5, method: 'Efectivo' })],
      '2026-09-26',
    )

    expect(text).toContain('Hoy · sáb 26/09')
    expect(text).toContain('• Almuerzo — S/ 25.00 · Yape')
    expect(text).toContain('Total: <b>S/ 43.50</b> (tu parte)')
  })

  it('should say when there is nothing, and cut a long day short', () => {
    expect(formatToday([], '2026-09-26')).toContain('No registraste gastos')

    const many = Array.from({ length: 20 }, (_, index) => row({ description: `Gasto ${index}` }))
    expect(formatToday(many, '2026-09-26')).toContain('… y 5 más')
  })

  it('should escape what the user typed', () => {
    expect(formatToday([row({ description: '<b>x</b>' })], '2026-09-26')).toContain('&lt;b&gt;x&lt;/b&gt;')
  })
})

describe('formatWeek', () => {
  it('should split the week by day and by category, biggest category first', () => {
    const text = formatWeek(
      [
        row({ date: '2026-09-24', own: 10, category: 'Transporte' }),
        row({ date: '2026-09-26', own: 30, category: 'Comida' }),
        row({ date: '2026-09-26', own: 20, category: 'Comida' }),
      ],
      '2026-09-20',
      '2026-09-26',
    )

    expect(text).toContain('• jue 24/09: S/ 10.00')
    expect(text).toContain('• sáb 26/09: S/ 50.00')
    expect(text.indexOf('Comida: S/ 50.00')).toBeLessThan(text.indexOf('Transporte: S/ 10.00'))
    expect(text).toContain('Total: <b>S/ 60.00</b>')
  })
})

describe('formatCards', () => {
  it('should show what each card will charge, with its installments apart and its dates', () => {
    const text = formatCards([
      { name: 'Oh Pay', total: 1200, installments: 300, closeDate: '2026-10-10', dueDate: '2026-11-03' },
      { name: 'IO', total: 400, installments: 0, closeDate: '2026-09-25', dueDate: '2026-10-12' },
    ])

    expect(text).toContain('<b>Oh Pay</b>: S/ 1200.00 (en cuotas S/ 300.00 · sin cuotas S/ 900.00)')
    expect(text).toContain('cierra 10/10 · paga 03/11')
    expect(text).toContain('<b>IO</b>: S/ 400.00\n')
    expect(text).toContain('Total de las tarjetas: <b>S/ 1600.00</b>')
  })

  it('should point to the web when no card has its closing and payment days', () => {
    expect(formatCards([])).toContain('Configuración ▸ Cuentas y tarjetas')
  })
})
