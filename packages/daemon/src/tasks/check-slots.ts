import os from 'node:os'

export function checkCpus(cores: number, running: number, percent: number): number {
  return Math.max(1, Math.floor((cores * percent) / 100 / Math.max(1, running)))
}

export function checkCpusEnv(cpus: number) {
  return { TED_CHECK_CPUS: String(cpus) }
}

export type CheckSlotBoundary = 'entered' | 'acquired' | 'canceled'

export interface CheckSlotRequest {
  taskId?: string
  signal?: AbortSignal
  observe?(boundary: CheckSlotBoundary, at: string): void
}

export interface CheckSlots {
  take(input: CheckSlotRequest): Promise<(() => void) | undefined>
  full(): boolean
  cpus(): number
  recheck(): void
  watch(listener: (places: ReadonlyMap<string, number>) => void): void
}

interface Waiter {
  taskId?: string
  start: () => void
}

export function createCheckSlots(options: {
  limit: () => number
  cpuPercent: () => number
  cores?: () => number
}): CheckSlots {
  const cores = options.cores ?? os.availableParallelism
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
    async take({ taskId, signal, observe }) {
      const at = new Date().toISOString()
      observe?.('entered', at)
      if (signal?.aborted) {
        observe?.('canceled', at)
        return Promise.resolve(undefined)
      }
      if (!full()) {
        running += 1
        try {
          observe?.('acquired', at)
        } catch (error) {
          running -= 1
          recheck()
          throw error
        }
        return release()
      }
      return new Promise((resolve, reject) => {
        const waiter: Waiter = {
          ...(taskId !== undefined && { taskId }),
          start: () => {
            signal?.removeEventListener('abort', leave)
            try {
              observe?.('acquired', new Date().toISOString())
              resolve(release())
            } catch (error) {
              running -= 1
              reject(error)
            }
          },
        }
        const leave = () => {
          const index = line.indexOf(waiter)
          if (index === -1) return
          line.splice(index, 1)
          try {
            observe?.('canceled', new Date().toISOString())
            resolve(undefined)
          } catch (error) {
            reject(error)
          } finally {
            changed()
          }
        }
        signal?.addEventListener('abort', leave, { once: true })
        line.push(waiter)
        changed()
      })
    },
    full,
    cpus: () => checkCpus(cores(), running, options.cpuPercent()),
    recheck,
    watch(next) {
      listener = next
    },
  }
}
