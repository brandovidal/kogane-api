import { TRIP_TEXTS, tripDays } from './trip.messages'

const summary = (overrides = {}) => ({
  name: 'Lima',
  startedAt: new Date('2026-09-20T15:00:00.000Z'),
  endedAt: new Date('2026-09-24T15:00:00.000Z'),
  total: 850.5,
  count: 12,
  byCategory: [
    { name: 'Transporte', total: 100 },
    { name: 'Comida', total: 400.5 },
  ],
  ...overrides,
})

describe('trip messages', () => {
  it('should add up the days of a trip, at least one', () => {
    expect(tripDays(new Date('2026-09-20T15:00:00Z'), new Date('2026-09-24T15:00:00Z'))).toBe(4)
    expect(tripDays(new Date('2026-09-20T15:00:00Z'), new Date('2026-09-20T18:00:00Z'))).toBe(1)
  })

  it('should give the total and the categories, biggest first, when it closes', () => {
    const text = TRIP_TEXTS.closed(summary())

    expect(text).toContain('Viaje <b>Lima</b> cerrado · 4 días')
    expect(text).toContain('12 gastos: <b>S/ 850.50</b> (tu parte)')
    expect(text.indexOf('Comida: S/ 400.50')).toBeLessThan(text.indexOf('Transporte: S/ 100.00'))
  })

  it('should say when nothing was spent, and escape the name', () => {
    expect(TRIP_TEXTS.closed(summary({ count: 0, total: 0, byCategory: [] }))).toContain(
      'No guardaste gastos durante el viaje',
    )
    expect(TRIP_TEXTS.started('<i>x</i>', null)).toContain('&lt;i&gt;x&lt;/i&gt;')
  })

  it('should tell which trip it closed when it opens another', () => {
    expect(TRIP_TEXTS.started('Cusco', 'Lima')).toContain('(Cerré «Lima».)')
  })
})
