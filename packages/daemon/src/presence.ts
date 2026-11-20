export const presenceStaleMs = 90_000
// The app reports away after this much idle time (awayAfterIdleSeconds in packages/app/src/presence.ts).
export const idleBeforeAwayMs = 120_000

export interface Presence {
  away(): boolean
  leftAt(): number | undefined
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
  let left = now()
  let timer: NodeJS.Timeout | undefined

  const compute = () => reported === undefined || reported.away || now() - reported.at >= staleMs
  const update = () => {
    const next = compute()
    if (next === current) return
    current = next
    if (current) left = reported?.away ? reported.at - idleBeforeAwayMs : (reported?.at ?? now())
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
    leftAt: () => {
      update()
      return current ? left : undefined
    },
    report(away) {
      const before = left
      if (reported === undefined && away) left = Math.min(left, now() - idleBeforeAwayMs)
      reported = { away, at: now() }
      update()
      if (current && left !== before) for (const listener of listeners) listener(current)
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
