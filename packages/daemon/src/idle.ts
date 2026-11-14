import { type Clock, systemClock, type Timer } from './clock.ts'
export interface IdleTimer {
  hold(): () => void
  attend(): () => void
  heard(): void
  cancel(): void
}

export function startIdleTimer({
  afterMs,
  onIdle,
  unattended,
  clock = systemClock,
}: {
  afterMs: number
  onIdle: () => void
  unattended?: { afterMs: number; onUnattended: () => void }
  clock?: Clock
}): IdleTimer {
  let holds = 0
  let clients = 0
  let timer: Timer | undefined
  let watch: Timer | undefined
  const restart = () => {
    timer?.cancel()
    timer = holds === 0 ? clock.timeout(onIdle, afterMs) : undefined
  }
  const rewatch = () => {
    watch?.cancel()
    watch =
      unattended && clients === 0
        ? clock.timeout(unattended.onUnattended, unattended.afterMs)
        : undefined
  }
  const hold = () => {
    holds++
    restart()
    let released = false
    return () => {
      if (released) return
      released = true
      holds--
      restart()
    }
  }
  restart()
  rewatch()
  return {
    hold,
    attend() {
      const release = hold()
      clients++
      rewatch()
      let released = false
      return () => {
        if (released) return
        released = true
        clients--
        rewatch()
        release()
      }
    },
    heard() {
      if (unattended && clients === 0) rewatch()
    },
    cancel() {
      timer?.cancel()
      watch?.cancel()
    },
  }
}
