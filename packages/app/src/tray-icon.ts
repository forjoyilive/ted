import { crc32, deflateSync } from 'node:zlib'
import type { BannerSeverity } from '@ted/protocol'

type Rgb = readonly [number, number, number]

const black: Rgb = [0, 0, 0]
const grey: Rgb = [128, 128, 128]
const dotColours: Record<BannerSeverity, Rgb> = {
  'stops-work': [192, 57, 43],
  warning: [184, 110, 18],
}

type Paint = Rgb | undefined
type Shape = (x: number, y: number) => Paint

const samples = 4

function render(widthPt: number, heightPt: number, scale: number, shape: Shape): Buffer {
  const width = Math.round(widthPt * scale)
  const height = Math.round(heightPt * scale)
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let covered = 0
      let colour: Rgb = black
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const paint = shape(
            (px + (sx + 0.5) / samples) / scale,
            (py + (sy + 0.5) / samples) / scale,
          )
          if (paint) {
            covered++
            colour = paint
          }
        }
      }
      const at = py * (width * 4 + 1) + 1 + px * 4
      raw.set([...colour, Math.round((covered / samples ** 2) * 255)], at)
    }
  }
  return encodePng(width, height, raw)
}

function inRoundedSquare(x: number, y: number): boolean {
  const [left, top, right, bottom, radius] = [1, 1, 15, 15, 3]
  if (x < left || x > right || y < top || y > bottom) return false
  const cx = Math.min(Math.max(x, left + radius), right - radius)
  const cy = Math.min(Math.max(y, top + radius), bottom - radius)
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
}

function inT(x: number, y: number): boolean {
  const bar = x >= 4 && x < 12 && y >= 4 && y < 6
  const stem = x >= 7 && x < 9 && y >= 6 && y < 12
  return bar || stem
}

export function trayIconPng({ scale, warning }: { scale: number; warning: boolean }): Buffer {
  const body = warning ? grey : black
  const dot = { x: 20.5, y: 8, radius: 2.5 }
  return render(warning ? 23 : 16, 16, scale, (x, y) => {
    if (warning && (x - dot.x) ** 2 + (y - dot.y) ** 2 < dot.radius ** 2) {
      return dotColours.warning
    }
    return inRoundedSquare(x, y) && !inT(x, y) ? body : undefined
  })
}

export function dotPng(severity: BannerSeverity, scale: number): Buffer {
  return render(12, 12, scale, (x, y) =>
    (x - 6) ** 2 + (y - 6) ** 2 < 3.5 ** 2 ? dotColours[severity] : undefined,
  )
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

function encodePng(width: number, height: number, raw: Buffer): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
