import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'

export const onlineCheckMs = 30_000
export const offlineCheckMs = 10_000
const connectTimeoutMs = 5_000
const agentHosts = ['api.anthropic.com', 'chatgpt.com']

export interface OnlineWatch {
  check(): Promise<boolean>
  close(): void
}

export function reachable(host: string, port = 443): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: connectTimeoutMs })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

export async function agentHostsReachable(): Promise<boolean> {
  const results = await Promise.all(agentHosts.map((host) => reachable(host)))
  return results.some(Boolean)
}

export async function onlineFromFile(file: string): Promise<boolean> {
  const text = await readFile(file, 'utf8').catch(() => 'online')
  return text.trim() !== 'offline'
}

export function watchOnline(options: {
  isOnline: () => Promise<boolean>
  onChange: (online: boolean) => void
  onlineEveryMs?: number
  offlineEveryMs?: number
}): OnlineWatch {
  let online = true
  let closed = false
  let timer: NodeJS.Timeout | undefined
  let running: Promise<boolean> | undefined
  let failedAt: number | undefined
  const confirmationMs = options.offlineEveryMs ?? offlineCheckMs

  function schedule(): void {
    if (closed) return
    clearTimeout(timer)
    timer = setTimeout(
      () => void check(),
      failedAt !== undefined && online
        ? Math.max(0, failedAt + confirmationMs - performance.now())
        : online
          ? (options.onlineEveryMs ?? onlineCheckMs)
          : confirmationMs,
    )
    timer.unref()
  }

  function check(): Promise<boolean> {
    const startedAt = performance.now()
    running ??= options
      .isOnline()
      .catch(() => true)
      .then((now) => {
        if (now) {
          failedAt = undefined
        } else if (failedAt === undefined) {
          failedAt = performance.now()
          return now
        } else if (online && startedAt - failedAt < confirmationMs) {
          return now
        }
        if (!closed && now !== online) {
          online = now
          options.onChange(now)
        }
        return now
      })
      .finally(() => {
        running = undefined
        schedule()
      })
    return running
  }

  schedule()
  return {
    check,
    close() {
      closed = true
      clearTimeout(timer)
    },
  }
}
