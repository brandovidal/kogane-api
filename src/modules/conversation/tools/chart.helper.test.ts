import { inflateSync } from 'node:zlib'

import { CHART_COLORS, renderDonut } from './chart.helper'

// Reads back the pixels of the PNG that renderDonut wrote (RGB, 8 bits, filter 0)
function decode(image: Buffer) {
  const width = image.readUInt32BE(16)
  const height = image.readUInt32BE(20)
  const idat = image.subarray(image.indexOf('IDAT') + 4, image.indexOf('IEND') - 4)
  const raw = inflateSync(idat)
  const pixel = (x: number, y: number) => {
    const offset = y * (width * 3 + 1) + 1 + x * 3
    return [raw[offset], raw[offset + 1], raw[offset + 2]]
  }
  return { width, height, pixel }
}

describe('renderDonut', () => {
  const image = renderDonut([{ total: 75 }, { total: 25 }])
  const { width, height, pixel } = decode(image)

  it('should write a valid PNG', () => {
    expect([...image.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(width).toBe(height)
    expect(image.subarray(image.length - 8, image.length - 4).toString('ascii')).toBe('IEND')
  })

  it('should paint the slices clockwise from the top, the first one the biggest, with a hole in the middle', () => {
    const ring = Math.round(width * 0.36)
    const middle = Math.round(width / 2)

    expect(pixel(middle + ring, middle)).toEqual([...CHART_COLORS[0].rgb]) // 3 o'clock: inside the first 75 %
    expect(pixel(middle - ring, middle)).toEqual([...CHART_COLORS[0].rgb]) // 9 o'clock is 75 %: the edge, still the first
    expect(pixel(middle - Math.round(ring * 0.7), middle - Math.round(ring * 0.7))).toEqual([...CHART_COLORS[1].rgb]) // top left
    expect(pixel(middle, middle)).toEqual([255, 255, 255])
    expect(pixel(2, 2)).toEqual([255, 255, 255])
  })
})
