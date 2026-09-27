import { chartCaption, toSlices } from './chart.messages'

describe('toSlices', () => {
  it('should sort the categories and group the small ones after the seventh as "Otras"', () => {
    const categories = Array.from({ length: 10 }, (_, index) => ({ name: `C${index}`, total: 10 + index }))

    const slices = toSlices(categories)

    expect(slices).toHaveLength(8)
    expect(slices[0]).toEqual({ name: 'C9', total: 19 })
    expect(slices[7]).toEqual({ name: 'Otras', total: 10 + 11 + 12 }) // C2, C1, C0... the three smallest
  })

  it('should drop the categories with nothing spent', () => {
    expect(
      toSlices([
        { name: 'A', total: 0 },
        { name: 'B', total: 5 },
      ]),
    ).toEqual([{ name: 'B', total: 5 }])
  })
})

describe('chartCaption', () => {
  it('should name the month and give each slice its colour, amount and share', () => {
    const text = chartCaption(9, 2026, [
      { name: 'Comida', total: 75 },
      { name: 'Taxi & Uber', total: 25 },
    ])

    expect(text).toContain('Gastos de setiembre 2026</b> · <b>S/ 100.00</b>')
    expect(text).toContain('🟥 Comida: S/ 75.00 · 75 %')
    expect(text).toContain('🟧 Taxi &amp; Uber: S/ 25.00 · 25 %')
  })
})
