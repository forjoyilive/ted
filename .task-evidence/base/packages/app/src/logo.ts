export type Point = readonly [number, number]

interface Stroke {
  points: readonly Point[]
  detail: boolean
}

const strokes: readonly Stroke[] = [
  {
    detail: false,
    points: [
      [139, 148],
      [231, 102],
      [346, 136],
      [346, 183],
    ],
  },
  {
    detail: false,
    points: [
      [139, 148],
      [139, 433],
      [231, 463],
      [315, 429],
      [315, 197],
    ],
  },
  {
    detail: false,
    points: [
      [231, 102],
      [231, 463],
    ],
  },
  {
    detail: false,
    points: [
      [139, 198],
      [231, 158],
      [346, 183],
    ],
  },
  {
    detail: false,
    points: [
      [315, 416],
      [392, 448],
      [392, 161],
      [315, 197],
    ],
  },
  {
    detail: false,
    points: [
      [265, 112],
      [265, 60],
    ],
  },
  {
    detail: true,
    points: [
      [184, 179],
      [184, 448],
    ],
  },
  {
    detail: true,
    points: [
      [139, 338],
      [231, 321],
    ],
  },
]

const antenna = { x: 265, y: 52, radius: 16 }
const widths = { main: 17, detail: 13 }

export const logoBounds = {
  left: 139,
  right: 392,
  top: antenna.y,
  bottom: 463,
  centreX: (139 + 392) / 2,
  inkTop: antenna.y - antenna.radius,
  inkBottom: 463 + widths.main / 2,
}

export interface LogoView {
  scale: number
  x: number
  y: number
  main: number
  detail?: number
  antenna: number
}

export function segmentDistance(u: number, v: number, a: Point, b: Point): number {
  const [ax, ay] = a
  const dx = b[0] - ax
  const dy = b[1] - ay
  const t = Math.min(Math.max(((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy), 0), 1)
  return Math.hypot(u - ax - t * dx, v - ay - t * dy)
}

export function polylineDistance(u: number, v: number, points: readonly Point[]): number {
  let distance = Number.POSITIVE_INFINITY
  for (let i = 1; i < points.length; i++) {
    distance = Math.min(distance, segmentDistance(u, v, points[i - 1] as Point, points[i] as Point))
  }
  return distance
}

export function coverage(signedDistance: number): number {
  return Math.min(Math.max(0.5 - signedDistance, 0), 1)
}

export function logoCoverage(view: LogoView, x: number, y: number): number {
  const u = (x - view.x) / view.scale
  const v = (y - view.y) / view.scale
  const reach = Math.max(view.main, view.antenna * 2) / view.scale + 2
  if (
    u < logoBounds.left - reach ||
    u > logoBounds.right + reach ||
    v < logoBounds.top - reach ||
    v > logoBounds.bottom + reach
  ) {
    return 0
  }
  let distance = Math.hypot(u - antenna.x, v - antenna.y) * view.scale - view.antenna
  for (const stroke of strokes) {
    const width = stroke.detail ? view.detail : view.main
    if (width === undefined) continue
    distance = Math.min(distance, polylineDistance(u, v, stroke.points) * view.scale - width / 2)
  }
  return coverage(distance)
}

export function logoSvg(): string {
  const lines = strokes.map(
    ({ points, detail }) =>
      `  <polyline points="${points.map(([x, y]) => `${x},${y}`).join(' ')}" stroke-width="${detail ? widths.detail : widths.main}"/>`,
  )
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round">',
    ...lines,
    `  <circle cx="${antenna.x}" cy="${antenna.y}" r="${antenna.radius}" fill="#000" stroke="none"/>`,
    '</svg>',
    '',
  ].join('\n')
}

export function logoWidths(scale: number, minimum: number, details: boolean) {
  return {
    main: Math.max(widths.main * scale, minimum),
    ...(details && { detail: Math.max(widths.detail * scale, minimum) }),
    antenna: Math.max(antenna.radius * scale, minimum),
  }
}
