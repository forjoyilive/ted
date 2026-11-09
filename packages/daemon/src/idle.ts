export interface IdleTimer {
  hold(): () => void
  cancel(): void
}

export function startIdleTimer({
  afterMs,
  onIdle,
}: {
  afterMs: number
  onIdle: () => void
}): IdleTimer {
  let holds = 0
  let timer: NodeJS.Timeout | undefined
  const restart = () => {
    clearTimeout(timer)
    timer = holds === 0 ? setTimeout(onIdle, afterMs) : undefined
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
      clearTimeout(timer)
    },
  }
}
