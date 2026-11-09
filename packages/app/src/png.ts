import { crc32, deflateSync } from 'node:zlib'

export type Rgba = readonly [number, number, number, number]

export function paintPng(
  width: number,
  height: number,
  paint: (x: number, y: number) => Rgba,
): Buffer {
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const [r, g, b, a] = paint(px, py)
      raw.set(
        [Math.round(r), Math.round(g), Math.round(b), Math.round(a * 255)],
        py * (width * 4 + 1) + 1 + px * 4,
      )
    }
  }
  return encodePng(width, height, raw)
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
