import { type Clock, systemClock, type Timer } from './clock.ts'
export interface IdleTimer {
  hold(): () => void
  cancel(): void
}

export function startIdleTimer({
  afterMs,
  onIdle,
  clock = systemClock,
}: {
  afterMs: number
  onIdle: () => void
  clock?: Clock
}): IdleTimer {
  let holds = 0
  let timer: Timer | undefined
  const restart = () => {
    timer?.cancel()
    timer = holds === 0 ? clock.timeout(onIdle, afterMs) : undefined
  }
  restart()
  return {
    hold() {
      holds++
      restart()
      let released = false
      return () => {
        if (released) return
        released = true
        holds--
        restart()
      }
    },
    cancel() {
      timer?.cancel()
    },
  }
}
