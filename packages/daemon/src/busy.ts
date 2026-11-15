import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import { promisify } from 'node:util'
import { type BusyHold, busyMarks, tedEnv } from '@ted/protocol'

const execFileAsync = promisify(execFile)

export interface BusyReading {
  loadRatio: number
  memoryAvailable: number
}

export function machineLoadRatio(): number {
  const fake = tedEnv('TED_LOAD_FILE')
  if (fake) return Number(readFileSync(fake, 'utf8'))
  return (os.loadavg()[0] ?? 0) / os.availableParallelism()
}

function fakeMemory(): { totalBytes: number; availableBytes: number } | undefined {
  const file = tedEnv('TED_MEMORY_FILE')
  if (!file) return undefined
  const values = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  return { totalBytes: Number(values.totalBytes), availableBytes: Number(values.availableBytes) }
}

export function totalMemory(): number {
  return fakeMemory()?.totalBytes ?? os.totalmem()
}

export async function availableMemory(): Promise<number> {
  const fake = fakeMemory()
  if (fake) return fake.availableBytes
  const total = os.totalmem()
  if (process.platform === 'linux') {
    const meminfo = await readFile('/proc/meminfo', 'utf8').catch(() => '')
    const kb = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo)?.[1]
    if (kb !== undefined) return Math.min(total, Number(kb) * 1024)
  }
  if (process.platform === 'darwin') {
    const level = await execFileAsync('sysctl', ['-n', 'kern.memorystatus_level'], {
      timeout: 5_000,
    }).then(
      ({ stdout }) => Number(stdout.trim()),
      () => Number.NaN,
    )
    if (level > 0 && level <= 100) return Math.round((total * level) / 100)
  }
  return os.freemem()
}

export async function memoryAvailableShare(): Promise<number> {
  const total = totalMemory()
  return total > 0 ? (await availableMemory()) / total : Number.NaN
}

export function nextBusy(
  previous: BusyHold | undefined,
  { loadRatio, memoryAvailable }: BusyReading,
): BusyHold | undefined {
  const { load, memory } = busyMarks
  const loadHeld =
    Number.isFinite(loadRatio) &&
    (loadRatio >= load.holdAt ||
      (loadRatio >= load.resumeBelow && previous?.loadRatio !== undefined))
  const memoryHeld =
    Number.isFinite(memoryAvailable) &&
    (memoryAvailable < memory.holdBelow ||
      (memoryAvailable <= memory.resumeAbove && previous?.memoryAvailable !== undefined))
  if (!loadHeld && !memoryHeld) return undefined
  return {
    ...(loadHeld && { loadRatio: Math.round(loadRatio * 100) / 100 }),
    ...(memoryHeld && { memoryAvailable: Math.round(memoryAvailable * 100) / 100 }),
  }
}

export interface BusyHoldOptions {
  on(): boolean
  loadRatio?: () => number
  memoryAvailable?: () => number | Promise<number>
  memoryCacheMs?: number
  now?: () => number
}

export interface Busy {
  check(): Promise<BusyHold | undefined>
  current(): BusyHold | undefined
  memory(): Promise<number>
}

export function createBusyHold(options: BusyHoldOptions): Busy {
  const loadRatio = options.loadRatio ?? machineLoadRatio
  const readMemory = options.memoryAvailable ?? memoryAvailableShare
  const cacheMs =
    options.memoryCacheMs ??
    (options.memoryAvailable !== undefined || tedEnv('TED_MEMORY_FILE') ? 0 : 5_000)
  const now = options.now ?? Date.now
  let held: BusyHold | undefined
  let memory: { at: number; share: number } | undefined

  async function memoryShare(): Promise<number> {
    if (memory && now() - memory.at < cacheMs) return memory.share
    const share = await Promise.resolve(readMemory()).catch(() => Number.NaN)
    memory = { at: now(), share }
    return share
  }

  return {
    async check() {
      if (!options.on()) {
        held = undefined
        return undefined
      }
      const memoryAvailable = await memoryShare()
      if (!options.on()) {
        held = undefined
        return undefined
      }
      held = nextBusy(held, { loadRatio: loadRatio(), memoryAvailable })
      return held
    },
    current: () => held,
    memory: memoryShare,
  }
}
