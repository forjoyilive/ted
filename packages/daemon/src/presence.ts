export const presenceStaleMs = 90_000

export interface Presence {
  away(): boolean
  report(away: boolean): void
  subscribe(listener: (away: boolean) => void): () => void
  close(): void
}

export interface PresenceOptions {
  now?: () => number
  staleMs?: number
}

export function createPresence(options: PresenceOptions = {}): Presence {
  const now = options.now ?? Date.now
  const staleMs = options.staleMs ?? presenceStaleMs
  const listeners = new Set<(away: boolean) => void>()
  let reported: { away: boolean; at: number } | undefined
  let current = true
  let timer: NodeJS.Timeout | undefined

  const compute = () =>
    reported === undefined || reported.away || now() - reported.at >= staleMs
  const update = () => {
    const next = compute()
    if (next === current) return
    current = next
    for (const listener of listeners) listener(current)
  }
  const watch = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (reported === undefined || reported.away) return
    timer = setTimeout(
      () => {
        timer = undefined
        update()
        if (!current) watch()
      },
      Math.max(0, reported.at + staleMs - now()),
    )
    timer.unref()
  }

  return {
    away: () => {
      update()
      return current
    },
    report(away) {
      reported = { away, at: now() }
      update()
      watch()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      if (timer) clearTimeout(timer)
      timer = undefined
      listeners.clear()
    },
  }
}
