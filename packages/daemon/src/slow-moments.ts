import { performance } from 'node:perf_hooks'
import {
  type SlowMinute,
  type SlowMoments,
  type SlowTotals,
  type SlowWindow,
  slowThresholds,
} from '@ted/protocol'

export interface TimedRequest {
  method: string
  route: string
  status: number
  handlerMs: number
  totalMs: number
}

export interface SlowMonitor {
  request(request: TimedRequest): void
  check(): void
  read(): SlowMoments
  close(): void
}

export interface SlowOptions {
  requestMs?: number
  stallMs?: number
  wall?: () => number
  mono?: () => number
  cpuMs?: () => number
  log?: (line: string) => void
  timer?: boolean
}

interface Second {
  stalls: SlowTotals
  routes: Map<string, SlowTotals>
}

const tickMs = 50
const quietMs = 10_000
const summaryMs = 60_000
const suspendedMs = 5_000
const hourSeconds = 3600
const routesShown = 10

const none = (): SlowTotals => ({ count: 0, totalMs: 0, longestMs: 0 })

function add(totals: SlowTotals, ms: number, count = 1): void {
  totals.count += count
  totals.totalMs += ms
  totals.longestMs = Math.max(totals.longestMs, ms)
}

function merge(into: SlowTotals, from: SlowTotals): void {
  into.count += from.count
  into.totalMs += from.totalMs
  into.longestMs = Math.max(into.longestMs, from.longestMs)
}

function processCpuMs(): number {
  const { user, system } = process.cpuUsage()
  return (user + system) / 1000
}

export function createSlowMonitor(options: SlowOptions = {}): SlowMonitor {
  const requestMs = options.requestMs ?? slowThresholds.requestMs
  const stallMs = options.stallMs ?? slowThresholds.stallMs
  const wall = options.wall ?? Date.now
  const mono = options.mono ?? (() => performance.now())
  const cpuMs = options.cpuMs ?? processCpuMs
  const log = options.log ?? ((line: string) => console.warn(line))

  const since = new Date(wall()).toISOString()
  const seconds = new Map<number, Second>()
  let lastTick = mono()
  let lastCpu = cpuMs()
  let lastPass = lastTick
  let lastStallLine = Number.NEGATIVE_INFINITY
  const heldStalls = none()
  const routeLines = new Map<string, { lastLine: number; held: SlowTotals }>()

  function second(): Second {
    const now = Math.floor(wall() / 1000)
    for (const key of seconds.keys()) {
      if (key > now - hourSeconds) break
      seconds.delete(key)
    }
    let found = seconds.get(now)
    if (!found) {
      found = { stalls: none(), routes: new Map() }
      seconds.set(now, found)
    }
    return found
  }

  function stalled(ms: number, now: number): void {
    add(second().stalls, ms)
    if (heldStalls.count === 0 && now - lastStallLine >= quietMs) {
      log(`event loop blocked for ${ms} ms`)
      lastStallLine = now
    } else {
      add(heldStalls, ms)
    }
  }

  function report(now: number): void {
    if (heldStalls.count > 0 && now - lastStallLine >= summaryMs) {
      const { count, totalMs, longestMs } = heldStalls
      log(
        `event loop blocked ${count} ${count === 1 ? 'time' : 'times'} in the last ${Math.round((now - lastStallLine) / 1000)} s: ${totalMs} ms in total, longest ${longestMs} ms`,
      )
      Object.assign(heldStalls, none())
      lastStallLine = now
    }
    for (const [route, line] of routeLines) {
      if (now - line.lastLine < quietMs) continue
      if (line.held.count === 0) {
        routeLines.delete(route)
        continue
      }
      log(
        `slow requests: ${route} ${line.held.count} more in the last ${Math.round((now - line.lastLine) / 1000)} s, slowest ${line.held.longestMs} ms`,
      )
      line.held = none()
      line.lastLine = now
    }
  }

  function check(): void {
    const now = mono()
    const cpu = cpuMs()
    const late = Math.round(now - lastTick - tickMs)
    const suspended = late >= suspendedMs && cpu - lastCpu < late / 10
    lastTick = now
    lastCpu = cpu
    if (late >= stallMs && !suspended) stalled(late, now)
    if (now - lastPass >= 1000) {
      lastPass = now
      report(now)
    }
  }

  const timer = options.timer === false ? undefined : setInterval(check, tickMs)
  timer?.unref()

  function window(from: number): SlowWindow {
    const stalls = none()
    const requests = none()
    const routes = new Map<string, SlowTotals>()
    for (const [key, entry] of seconds) {
      if (key <= from) continue
      merge(stalls, entry.stalls)
      for (const [route, totals] of entry.routes) {
        merge(requests, totals)
        let sum = routes.get(route)
        if (!sum) {
          sum = none()
          routes.set(route, sum)
        }
        merge(sum, totals)
      }
    }
    return {
      stalls,
      requests,
      routes: [...routes]
        .map(([route, totals]) => ({ route, ...totals }))
        .sort((a, b) => b.totalMs - a.totalMs || a.route.localeCompare(b.route))
        .slice(0, routesShown),
    }
  }

  function minutes(now: number): SlowMinute[] {
    const current = Math.floor(now / 60)
    const series = Array.from({ length: 60 }, (_, index) => ({
      start: new Date((current - 59 + index) * 60_000).toISOString(),
      stalls: none(),
      requests: none(),
    }))
    for (const [key, entry] of seconds) {
      const minute = series[Math.floor(key / 60) - (current - 59)]
      if (!minute) continue
      merge(minute.stalls, entry.stalls)
      for (const totals of entry.routes.values()) merge(minute.requests, totals)
    }
    return series
  }

  return {
    request({ method, route, status, handlerMs, totalMs }) {
      const total = Math.round(totalMs)
      if (total < requestMs) return
      const name = `${method} ${route}`
      const routes = second().routes
      let totals = routes.get(name)
      if (!totals) {
        totals = none()
        routes.set(name, totals)
      }
      add(totals, total)
      const now = mono()
      const line = routeLines.get(name)
      if (line && now - line.lastLine < quietMs) {
        add(line.held, total)
        return
      }
      log(`slow request: ${name} ${status} took ${total} ms (handler ${Math.round(handlerMs)} ms)`)
      routeLines.set(name, { lastLine: now, held: none() })
    },
    check,
    read() {
      const now = Math.floor(wall() / 1000)
      return {
        at: new Date(wall()).toISOString(),
        since,
        thresholds: { requestMs, stallMs },
        lastMinute: window(now - 60),
        lastHour: window(now - hourSeconds),
        minutes: minutes(now),
      }
    },
    close() {
      clearInterval(timer)
    },
  }
}
