export interface CheckSlots {
  take(input: { taskId?: string; signal?: AbortSignal }): Promise<(() => void) | undefined>
  full(): boolean
  recheck(): void
  watch(listener: (places: ReadonlyMap<string, number>) => void): void
}

interface Waiter {
  taskId?: string
  start: () => void
}

export function createCheckSlots(options: { limit: () => number }): CheckSlots {
  const line: Waiter[] = []
  let running = 0
  let listener: ((places: ReadonlyMap<string, number>) => void) | undefined

  const changed = () => {
    const places = new Map<string, number>()
    for (const [index, waiter] of line.entries()) {
      if (waiter.taskId !== undefined) places.set(waiter.taskId, index + 1)
    }
    listener?.(places)
  }

  const release = () => {
    let released = false
    return () => {
      if (released) return
      released = true
      running -= 1
      recheck()
    }
  }

  function recheck(): void {
    let started = false
    while (running < options.limit()) {
      const next = line.shift()
      if (!next) break
      running += 1
      started = true
      next.start()
    }
    if (started) changed()
  }

  const full = () => line.length > 0 || running >= options.limit()

  return {
    take({ taskId, signal }) {
      if (signal?.aborted) return Promise.resolve(undefined)
      if (!full()) {
        running += 1
        return Promise.resolve(release())
      }
      return new Promise((resolve) => {
        const waiter: Waiter = {
          ...(taskId !== undefined && { taskId }),
          start: () => {
            signal?.removeEventListener('abort', leave)
            resolve(release())
          },
        }
        const leave = () => {
          const index = line.indexOf(waiter)
          if (index === -1) return
          line.splice(index, 1)
          resolve(undefined)
          changed()
        }
        signal?.addEventListener('abort', leave, { once: true })
        line.push(waiter)
        changed()
      })
    },
    full,
    recheck,
    watch(next) {
      listener = next
    },
  }
}
