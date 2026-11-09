import { inflateSync } from 'node:zlib'
import { describe, expect, test } from 'vitest'
import { dotPng, trayIconPng } from '../src/tray-icon.ts'

interface Decoded {
  width: number
  height: number
  pixel(x: number, y: number): [number, number, number, number]
}

function decode(png: Buffer): Decoded {
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
    pixel(x, y) {
      const at = y * (width * 4 + 1) + 1 + x * 4
      return [raw[at] ?? 0, raw[at + 1] ?? 0, raw[at + 2] ?? 0, raw[at + 3] ?? 0]
    },
  }
}

describe('menu-bar icon images', () => {
  test('the plain icon is a black template square with a clear T, at the asked scale', () => {
    const icon = decode(trayIconPng({ scale: 2, warning: false }))

    expect([icon.width, icon.height]).toEqual([32, 32])
    expect(icon.pixel(6, 6)).toEqual([0, 0, 0, 255])
    expect(icon.pixel(16, 8)[3]).toBe(0)
    expect(icon.pixel(16, 20)[3]).toBe(0)
    expect(icon.pixel(0, 0)[3]).toBe(0)
  })

  test('the warning icon is wider and carries an amber dot to the right', () => {
    const icon = decode(trayIconPng({ scale: 1, warning: true }))

    expect([icon.width, icon.height]).toEqual([23, 16])
    expect(icon.pixel(20, 8)).toEqual([184, 110, 18, 255])
    expect(icon.pixel(17, 8)[3]).toBe(0)
  })

  test('menu dots are red for stops-work problems and amber for warnings', () => {
    const red = decode(dotPng('stops-work', 1))
    const amber = decode(dotPng('warning', 1))

    expect([red.width, red.height]).toEqual([12, 12])
    expect(red.pixel(6, 6)).toEqual([192, 57, 43, 255])
    expect(amber.pixel(6, 6)).toEqual([184, 110, 18, 255])
    expect(red.pixel(0, 0)[3]).toBe(0)
  })
})
