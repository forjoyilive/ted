import { inflateSync } from 'node:zlib'
import { expect } from 'vitest'

export interface Decoded {
  width: number
  height: number
  raw: Buffer
  pixel(x: number, y: number): [number, number, number, number]
}

export function decodePng(png: Buffer): Decoded {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  let offset = 8
  let width = 0
  let height = 0
  const data: Buffer[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('latin1', offset + 4, offset + 8)
    const body = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
    } else if (type === 'IDAT') data.push(body)
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  return {
    width,
    height,
    raw,
    pixel(x, y) {
      const at = y * (width * 4 + 1) + 1 + x * 4
      return [raw[at] ?? 0, raw[at + 1] ?? 0, raw[at + 2] ?? 0, raw[at + 3] ?? 0]
    },
  }
}
