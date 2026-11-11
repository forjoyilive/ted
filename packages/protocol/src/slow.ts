export const slowThresholds = { requestMs: 100, stallMs: 200 } as const

export interface SlowTotals {
  count: number
  totalMs: number
  longestMs: number
}

export interface SlowRoute extends SlowTotals {
  route: string
}

export interface SlowWindow {
  stalls: SlowTotals
  requests: SlowTotals
  routes: SlowRoute[]
}

export interface SlowMinute {
  start: string
  stalls: SlowTotals
  requests: SlowTotals
}

export interface SlowMoments {
  at: string
  since: string
  thresholds: { requestMs: number; stallMs: number }
  lastMinute: SlowWindow
  lastHour: SlowWindow
  minutes: SlowMinute[]
}

export const profileSeconds = { min: 5, max: 120, default: 30 } as const

export interface ProfileRequest {
  seconds: number
}

export interface ProfileResult {
  file: string
  seconds: number
  bytes: number
}
