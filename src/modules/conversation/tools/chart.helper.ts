import { deflateSync } from 'node:zlib'

// The donut of /grafico (P18, D130) drawn pixel by pixel and written as a PNG with node:zlib: no fonts and no native
// dependency. The legend goes in the caption of the photo, each slice with the emoji of its colour
export interface ChartSlice {
  total: number
}

// Colour of each slice and the emoji that matches it in the caption
export const CHART_COLORS = [
  { rgb: [229, 72, 77], emoji: '🟥' },
  { rgb: [247, 107, 21], emoji: '🟧' },
  { rgb: [255, 197, 61], emoji: '🟨' },
  { rgb: [48, 164, 108], emoji: '🟩' },
  { rgb: [62, 99, 221], emoji: '🟦' },
  { rgb: [142, 78, 198], emoji: '🟪' },
  { rgb: [161, 128, 114], emoji: '🟫' },
  { rgb: [139, 141, 152], emoji: '⬜' },
] as const

const SIZE = 480
const OUTER = 0.46 // of the side
const INNER = 0.27
const SAMPLES = 3 // per axis, for smooth edges

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (data: Buffer) => {
  let c = 0xffffffff
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}

const png = (width: number, height: number, rgb: Buffer) => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // RGB
  const rows = Buffer.alloc((width * 3 + 1) * height) // each row starts with filter 0
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const BACKGROUND = [255, 255, 255]

// A donut: the slices clockwise from the top, the first one the biggest. Slice i takes CHART_COLORS[i]
export function renderDonut(slices: ChartSlice[]): Buffer {
  const total = slices.reduce((sum, slice) => sum + slice.total, 0)
  // Angle (0..1, clockwise from the top) where each slice ends
  let acc = 0
  const ends = slices.map((slice) => (acc += slice.total / total))
  const center = SIZE / 2
  const rgb = Buffer.alloc(SIZE * SIZE * 3)

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const sum = [0, 0, 0]
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const dx = x + (sx + 0.5) / SAMPLES - center
          const dy = y + (sy + 0.5) / SAMPLES - center
          const radius = Math.hypot(dx, dy) / SIZE
          let color: readonly number[] = BACKGROUND
          if (radius >= INNER && radius <= OUTER) {
            const angle = (Math.atan2(dx, -dy) / (2 * Math.PI) + 1) % 1
            const index = Math.min(
              ends.findIndex((end) => angle < end),
              slices.length - 1,
            )
            color = CHART_COLORS[(index < 0 ? slices.length - 1 : index) % CHART_COLORS.length].rgb
          }
          sum[0] += color[0]
          sum[1] += color[1]
          sum[2] += color[2]
        }
      }
      const offset = (y * SIZE + x) * 3
      const samples = SAMPLES * SAMPLES
      rgb[offset] = Math.round(sum[0] / samples)
      rgb[offset + 1] = Math.round(sum[1] / samples)
      rgb[offset + 2] = Math.round(sum[2] / samples)
    }
  }
  return png(SIZE, SIZE, rgb)
}
