export interface Timer {
  cancel(): void
  unref(): void
}

export interface Clock {
  now(): number
  timeout(callback: () => void, ms: number): Timer
  interval(callback: () => void, ms: number): Timer
}

export const systemClock: Clock = {
  now: () => Date.now(),
  timeout(callback, ms) {
    const timer = setTimeout(callback, ms)
    return {
      cancel: () => clearTimeout(timer),
      unref: () => {
        timer.unref()
      },
    }
  },
  interval(callback, ms) {
    const timer = setInterval(callback, ms)
    return {
      cancel: () => clearInterval(timer),
      unref: () => {
        timer.unref()
      },
    }
  },
}

export function clockWait(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = clock.timeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      timer.cancel()
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}
