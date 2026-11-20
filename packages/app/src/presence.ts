import type { PresenceReport } from '@ted/protocol'

export const idleCheckMs = 15_000
export const awayAfterIdleSeconds = 120
export const heartbeatMs = 30_000

export interface PresenceMonitor {
  getSystemIdleTime(): number
  on(event: 'lock-screen', listener: () => void): void
  on(event: 'unlock-screen', listener: () => void): void
  removeListener(event: 'lock-screen', listener: () => void): void
  removeListener(event: 'unlock-screen', listener: () => void): void
}

export interface PresenceClient {
  reportPresence(input: PresenceReport): Promise<PresenceReport>
}

export type Every = (ms: number, run: () => void) => () => void

export interface PresenceReporterOptions {
  monitor: PresenceMonitor
  client: () => PresenceClient | undefined
  every?: Every
}

export interface PresenceReporter {
  away(): boolean
  reportNow(): void
  stop(): void
}

const realEvery: Every = (ms, run) => {
  const timer = setInterval(run, ms)
  timer.unref()
  return () => clearInterval(timer)
}

export function startPresenceReporter(options: PresenceReporterOptions): PresenceReporter {
  const { monitor } = options
  const every = options.every ?? realEvery
  let locked = false
  const idle = () => monitor.getSystemIdleTime() >= awayAfterIdleSeconds
  let away = idle()

  const report = () => {
    options
      .client()
      ?.reportPresence({ away })
      .catch(() => undefined)
  }
  const check = () => {
    const next = locked || idle()
    if (next === away) return
    away = next
    report()
  }
  const onLock = () => {
    locked = true
    check()
  }
  const onUnlock = () => {
    locked = false
    check()
  }

  monitor.on('lock-screen', onLock)
  monitor.on('unlock-screen', onUnlock)
  const stopChecks = every(idleCheckMs, check)
  const stopHeartbeat = every(heartbeatMs, report)
  report()

  return {
    away: () => away,
    reportNow: report,
    stop() {
      stopChecks()
      stopHeartbeat()
      monitor.removeListener('lock-screen', onLock)
      monitor.removeListener('unlock-screen', onUnlock)
    },
  }
}
