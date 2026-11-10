import type { Clock, Timer } from '../../src/clock.ts'

interface Scheduled {
  at: number
  callback: () => void
  every?: number
}

export class ManualClock implements Clock {
  #at: number
  #timers = new Set<Scheduled>()
  #listeners = new Set<() => void>()

  constructor(at = Date.now()) {
    this.#at = at
  }

  now = (): number => this.#at

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  get pending(): number[] {
    return [...this.#timers].map((timer) => timer.at - this.#at)
  }

  timeout(callback: () => void, ms: number): Timer {
    return this.#schedule({ callback, at: this.#at + Math.max(1, ms) })
  }

  interval(callback: () => void, ms: number): Timer {
    const every = Math.max(1, ms)
    return this.#schedule({ callback, at: this.#at + every, every })
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('advance needs a finite positive duration')
    const until = this.#at + ms
    for (;;) {
      const timer = [...this.#timers].sort((a, b) => a.at - b.at)[0]
      if (!timer || timer.at > until) break
      this.#at = timer.at
      if (timer.every === undefined) this.#timers.delete(timer)
      else timer.at += timer.every
      timer.callback()
    }
    this.#at = until
  }

  #schedule(timer: Scheduled): Timer {
    this.#timers.add(timer)
    for (const listener of this.#listeners) listener()
    return {
      cancel: () => {
        this.#timers.delete(timer)
      },
      unref() {},
    }
  }
}
