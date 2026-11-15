import { busyMarks } from '@ted/protocol'

export interface MemoryWatching {
  lowest(): number | undefined
  finish(): Promise<number | undefined>
}

export interface MemoryWatch {
  watch(): MemoryWatching
  freed(signal?: AbortSignal): Promise<boolean>
}

export interface MemoryEnding {
  signal?: string | undefined
  exitCode?: number | undefined
}

export function memoryKill(ending: MemoryEnding, lowest: number | undefined): boolean {
  const killed = ending.signal === 'SIGKILL' || ending.exitCode === 137
  return killed && lowest !== undefined && lowest < busyMarks.memory.holdBelow
}

export function runKilledForMemory(
  ending: { how: string; signal?: string | undefined; code?: number | undefined },
  lowest: number | undefined,
): boolean {
  return (
    ending.how === 'exited' && memoryKill({ signal: ending.signal, exitCode: ending.code }, lowest)
  )
}

export function createMemoryWatch(options: {
  read: () => Promise<number>
  everyMs?: number
}): MemoryWatch {
  const everyMs = options.everyMs ?? 5_000
  const open = new Set<{ lowest: number | undefined }>()
  let timer: NodeJS.Timeout | undefined

  async function read(): Promise<number> {
    return await options.read().catch(() => Number.NaN)
  }

  function note(entries: Iterable<{ lowest: number | undefined }>, share: number): void {
    if (!Number.isFinite(share)) return
    for (const entry of entries) entry.lowest = Math.min(entry.lowest ?? share, share)
  }

  function sample(): void {
    const entries = [...open]
    void read().then((share) => note(entries, share))
  }

  return {
    watch() {
      const entry: { lowest: number | undefined } = { lowest: undefined }
      open.add(entry)
      const first = read().then((share) => note([entry], share))
      if (timer === undefined) {
        timer = setInterval(sample, everyMs)
        timer.unref()
      }
      return {
        lowest: () => entry.lowest,
        async finish() {
          await first
          open.delete(entry)
          if (open.size === 0) {
            clearInterval(timer)
            timer = undefined
          }
          return entry.lowest
        },
      }
    },
    async freed(signal) {
      while (!signal?.aborted) {
        const share = await read()
        if (!Number.isFinite(share) || share >= busyMarks.memory.resumeAbove) return true
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(wait)
            signal?.removeEventListener('abort', done)
            resolve()
          }
          const wait = setTimeout(done, everyMs)
          signal?.addEventListener('abort', done)
        })
      }
      return false
    },
  }
}
