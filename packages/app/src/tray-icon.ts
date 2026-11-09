import type { BannerSeverity } from '@ted/protocol'
import { coverage, type LogoView, logoBounds, logoCoverage } from './logo.ts'
import { paintPng, type Rgba } from './png.ts'

type Rgb = readonly [number, number, number]

const black: Rgb = [0, 0, 0]
const grey: Rgb = [128, 128, 128]
const dotColours: Record<BannerSeverity, Rgb> = {
  'stops-work': [192, 57, 43],
  warning: [184, 110, 18],
}

const tray = { width: 12, height: 18, stroke: 1.25, antenna: 1.5, margin: 0.75 }
const warningDot = { x: 16.5, y: 9, radius: 2.5 }

function trayView(scale: number): LogoView {
  const top = tray.margin + tray.antenna
  const bottom = tray.height - tray.margin - tray.stroke / 2
  const unit = (bottom - top) / (logoBounds.bottom - logoBounds.top)
  return {
    scale: unit * scale,
    x: (tray.width / 2 - logoBounds.centreX * unit) * scale,
    y: (top - logoBounds.top * unit) * scale,
    main: tray.stroke * scale,
    antenna: tray.antenna * scale,
  }
}

function paint(colour: Rgb, alpha: number): Rgba {
  return [...colour, alpha]
}

export function trayIconPng({ scale, warning }: { scale: number; warning: boolean }): Buffer {
  const view = trayView(scale)
  const body = warning ? grey : black
  const width = Math.round((warning ? warningDot.x + 2.5 : tray.width) * scale)
  return paintPng(width, Math.round(tray.height * scale), (px, py) => {
    const x = px + 0.5
    const y = py + 0.5
    if (warning) {
      const dot = coverage(
        Math.hypot(x - warningDot.x * scale, y - warningDot.y * scale) - warningDot.radius * scale,
      )
      if (dot > 0) return paint(dotColours.warning, dot)
    }
    return paint(body, logoCoverage(view, x, y))
  })
}

export function dotPng(severity: BannerSeverity, scale: number): Buffer {
  const size = Math.round(12 * scale)
  return paintPng(size, size, (px, py) =>
    paint(
      dotColours[severity],
      coverage(Math.hypot(px + 0.5 - 6 * scale, py + 0.5 - 6 * scale) - 3.5 * scale),
    ),
  )
}
