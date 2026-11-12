import type { Edition } from '@ted/protocol'
import {
  coverage,
  logoBounds,
  logoCoverage,
  logoWidths,
  type Point,
  polylineDistance,
} from './logo.ts'
import { paintPng, type Rgba } from './png.ts'

type Rgb = readonly [number, number, number]

export type IconLayout = 'mac' | 'linux'

const ink: Rgb = [28, 28, 30]
const tiles: Record<Edition, { top: Rgb; bottom: Rgb }> = {
  release: { top: [255, 255, 255], bottom: [234, 234, 237] },
  dev: { top: [255, 214, 10], bottom: [245, 180, 0] },
}

const layouts: Record<IconLayout, { inset: number; radius: number; shadow: boolean }> = {
  mac: { inset: 100, radius: 185.4, shadow: true },
  linux: { inset: 40, radius: 200, shadow: false },
}

const shadow = { offset: 12, blur: 28, alpha: 0.3 }
const band = 0.2

const letterHeight = 0.42
const letters: { width: number; lines: Point[][] }[] = [
  {
    width: 0.78,
    lines: [
      [
        [0, 0],
        [0.28, 0],
        ...Array.from({ length: 13 }, (_, i): Point => {
          const angle = -Math.PI / 2 + (i * Math.PI) / 12
          return [0.28 + 0.5 * Math.cos(angle), 0.5 + 0.5 * Math.sin(angle)]
        }),
        [0, 1],
        [0, 0],
      ],
    ],
  },
  {
    width: 0.6,
    lines: [
      [
        [0.6, 0],
        [0, 0],
        [0, 1],
        [0.6, 1],
      ],
      [
        [0, 0.5],
        [0.5, 0.5],
      ],
    ],
  },
  {
    width: 0.72,
    lines: [
      [
        [0, 0],
        [0.36, 1],
        [0.72, 0],
      ],
    ],
  },
]
const letterGap = 0.34

function roundedRectDistance(
  x: number,
  y: number,
  centre: number,
  half: number,
  radius: number,
): number {
  const qx = Math.abs(x - centre) - (half - radius)
  const qy = Math.abs(y - centre) - (half - radius)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
}

function over(below: Rgba, colour: Rgb, alpha: number): Rgba {
  if (alpha <= 0) return below
  const [r, g, b, a] = below
  const out = alpha + a * (1 - alpha)
  const mix = (top: number, bottom: number) => (top * alpha + bottom * a * (1 - alpha)) / out
  return [mix(colour[0], r), mix(colour[1], g), mix(colour[2], b), out]
}

function lerp(from: Rgb, to: Rgb, t: number): Rgb {
  const mix = (a: number, b: number) => a + (b - a) * t
  return [mix(from[0], to[0]), mix(from[1], to[1]), mix(from[2], to[2])]
}

export function appIconPng({
  size,
  edition = 'release',
  layout = 'mac',
}: {
  size: number
  edition?: Edition
  layout?: IconLayout
}): Buffer {
  const k = size / 1024
  const { inset, radius, shadow: hasShadow } = layouts[layout]
  const tileTop = inset * k
  const tileSize = (1024 - 2 * inset) * k
  const half = tileSize / 2
  const centre = size / 2
  const tile = tiles[edition]
  const dev = edition === 'dev'

  const drawingHeight = tileSize * (dev ? 0.54 : 0.64)
  const drawingCentreY = dev ? tileTop + tileSize * 0.41 : centre
  const unit = drawingHeight / (logoBounds.inkBottom - logoBounds.inkTop)
  const view = {
    scale: unit,
    x: centre - logoBounds.centreX * unit,
    y: drawingCentreY - ((logoBounds.inkTop + logoBounds.inkBottom) / 2) * unit,
    ...logoWidths(unit, 1, size >= 64),
  }

  const bandTop = tileTop + tileSize * (1 - band)
  const capHeight = tileSize * band * letterHeight
  const wordWidth =
    letters.reduce((sum, letter) => sum + letter.width, 0) + letterGap * (letters.length - 1)
  const letterStroke = Math.max(capHeight * 0.17, 1)
  const wordLeft = centre - (wordWidth * capHeight) / 2
  const wordTop = bandTop + (tileSize * band - capHeight) / 2

  return paintPng(size, size, (px, py) => {
    const x = px + 0.5
    const y = py + 0.5
    let pixel: Rgba = [0, 0, 0, 0]
    if (hasShadow) {
      const d = roundedRectDistance(x, y - shadow.offset * k, centre, half, radius * k)
      const fade = Math.min(Math.max(1 - (d + shadow.blur * k * 0.2) / (shadow.blur * k), 0), 1)
      pixel = over(pixel, [0, 0, 0], shadow.alpha * fade * fade)
    }
    const inTile = coverage(roundedRectDistance(x, y, centre, half, radius * k))
    if (inTile === 0) return pixel
    pixel = over(pixel, lerp(tile.top, tile.bottom, (y - tileTop) / tileSize), inTile)
    if (dev && y >= bandTop - 1) {
      pixel = over(pixel, ink, inTile * coverage(bandTop - y))
      let left = wordLeft
      let distance = Number.POSITIVE_INFINITY
      for (const letter of letters) {
        for (const line of letter.lines) {
          distance = Math.min(
            distance,
            polylineDistance((x - left) / capHeight, (y - wordTop) / capHeight, line) * capHeight,
          )
        }
        left += (letter.width + letterGap) * capHeight
      }
      return over(pixel, tile.top, inTile * coverage(distance - letterStroke / 2))
    }
    return over(pixel, ink, logoCoverage(view, x, y))
  })
}
