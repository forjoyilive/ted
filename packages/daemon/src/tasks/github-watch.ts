import { type Clock, systemClock } from '../clock.ts'
import type { Gh } from '../github/gh.ts'
import { type PullRequestRead, type PullRequestRef, readByHost } from './merge.ts'

export interface PullRequestWatch {
  next(options?: { now?: boolean }): Promise<PullRequestRead>
  poke(): void
  kick(): void
  close(): void
}

export interface PullRequestWatchOptions {
  gh: Pick<Gh, 'graphql'>
  clock?: Clock
  everyMs: number
  urgentGapMs?: number
  urgentBurst?: number
  refs(): PullRequestRef[]
  onRead(read: PullRequestRead): Promise<void>
  inBackground(what: string, work: () => Promise<void>): void
}

const emptyRead = (): PullRequestRead => ({
  pulls: new Map(),
  failed: new Map(),
  hostOf: new Map(),
})

export function createPullRequestWatch(options: PullRequestWatchOptions): PullRequestWatch {
  const clock = options.clock ?? systemClock
  const waiters: { resolve: (read: PullRequestRead) => void; now: boolean }[] = []
  let running = false
  let closed = false
  let wake: (() => void) | undefined
  let stopPause: (() => void) | undefined
  let readAt: number | undefined
  const burst = options.urgentBurst ?? 60
  let allowed = burst
  const gap = options.urgentGapMs ?? Math.min(options.everyMs, 5_000)

  function start(): void {
    if (running || closed) return
    running = true
    options.inBackground('watch GitHub pull requests', loop)
  }

  async function loop(): Promise<void> {
    try {
      while (!closed) {
        if (options.refs().length === 0 && waiters.length === 0) return
        // A caller that asks again and again for a fresh read must not spend GitHub’s hourly
        // GraphQL allowance: after `burst` reads in a row, reads start at least `gap` apart.
        const now = clock.now()
        allowed = Math.min(burst, allowed + (readAt === undefined ? 0 : (now - readAt) / gap))
        if (allowed < 1) await pause(Math.ceil((1 - allowed) * gap))
        if (closed) return
        const refs = options.refs()
        const waiting = waiters.splice(0)
        allowed = Math.min(burst, allowed + (clock.now() - now) / gap) - 1
        readAt = clock.now()
        const read = await readByHost(options.gh, refs)
        for (const waiter of waiting) waiter.resolve(read)
        if (closed) return
        await options
          .onRead(read)
          .catch((error: unknown) => console.error('couldn’t act on what GitHub reported:', error))
        if (closed) return
        if (waiters.some((w) => w.now)) continue
        await nap()
      }
    } finally {
      running = false
      if (closed) for (const waiter of waiters.splice(0)) waiter.resolve(emptyRead())
      else if (waiters.length > 0 || options.refs().length > 0) start()
    }
  }

  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = clock.timeout(done, ms)
      stopPause = done
      function done() {
        timer.cancel()
        stopPause = undefined
        resolve()
      }
    })
  }

  function nap(): Promise<void> {
    return new Promise((resolve) => {
      const timer = clock.timeout(done, options.everyMs)
      wake = done
      function done() {
        timer.cancel()
        wake = undefined
        resolve()
      }
    })
  }

  return {
    next({ now = false } = {}) {
      return new Promise((resolve) => {
        if (closed) {
          resolve(emptyRead())
          return
        }
        waiters.push({ resolve, now })
        if (now) wake?.()
        start()
      })
    },
    poke: start,
    kick() {
      wake?.()
      start()
    },
    close() {
      closed = true
      wake?.()
      stopPause?.()
      for (const waiter of waiters.splice(0)) waiter.resolve(emptyRead())
    },
  }
}
