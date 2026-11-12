import { type Clock, systemClock, type Timer } from '../clock.ts'

export interface Fetches {
  fresh(clone: string): Promise<void>
  soon(clone: string): Promise<void>
  close(): void
}

export const backgroundFetchEveryMs = 60_000
export const fetchLimitMs = 120_000

interface Later {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
  timer: Timer
}

export function createFetches(options: {
  fetch: (clone: string) => Promise<void>
  now?: () => number
  everyMs?: number
  timeout?: Clock['timeout']
  limitMs?: number
}): Fetches {
  const now = options.now ?? Date.now
  const everyMs = options.everyMs ?? backgroundFetchEveryMs
  const timeout = options.timeout ?? systemClock.timeout
  const limitMs = options.limitMs ?? fetchLimitMs
  const clones = new Map<
    string,
    { running?: Promise<void>; next?: Promise<void>; at?: number; later?: Later }
  >()
  let closed = false

  function stateOf(clone: string) {
    let state = clones.get(clone)
    if (!state) {
      state = {}
      clones.set(clone, state)
    }
    return state
  }

  function limited(clone: string): Promise<void> {
    const { promise, reject } = Promise.withResolvers<void>()
    const timer = timeout(
      () => reject(new Error(`the fetch took more than ${Math.round(limitMs / 1000)} s`)),
      limitMs,
    )
    timer.unref()
    const done = options.fetch(clone)
    const cancel = () => timer.cancel()
    done.then(cancel, cancel)
    return Promise.race([done, promise])
  }

  function start(clone: string): Promise<void> {
    const state = stateOf(clone)
    const running = limited(clone).then(() => {
      state.at = now()
      const later = state.later
      if (!later) return
      delete state.later
      later.timer.cancel()
      later.resolve()
    })
    state.running = running
    const settle = () => {
      if (state.running === running) delete state.running
    }
    running.then(settle, settle)
    return running
  }

  function afterWindow(clone: string, wait: number): Promise<void> {
    const state = stateOf(clone)
    if (state.later) return state.later.promise
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const timer = timeout(() => {
      if (state.later !== later) return
      const fetch = state.next ?? state.running ?? start(clone)
      fetch.catch((error: unknown) => {
        if (state.later !== later) return
        delete state.later
        reject(error)
      })
    }, wait)
    timer.unref()
    const later: Later = { promise, resolve, reject, timer }
    state.later = later
    return promise
  }

  return {
    fresh(clone) {
      const state = stateOf(clone)
      if (!state.running) return start(clone)
      if (!state.next) {
        const next = state.running
          .catch(() => undefined)
          .then(() => {
            delete state.next
            return start(clone)
          })
        state.next = next
      }
      return state.next
    },
    soon(clone) {
      const state = stateOf(clone)
      if (state.next) return state.next
      if (state.running) return state.running
      if (closed) return Promise.resolve()
      const since = state.at === undefined ? everyMs : now() - state.at
      if (since < everyMs) return afterWindow(clone, everyMs - since)
      return start(clone)
    },
    close() {
      closed = true
      for (const state of clones.values()) {
        const later = state.later
        if (!later) continue
        delete state.later
        later.timer.cancel()
        later.resolve()
      }
    },
  }
}
