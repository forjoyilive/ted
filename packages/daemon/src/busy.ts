import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { type BusyHold, busyMarks, tedEnv } from '@ted/protocol'

const execFileAsync = promisify(execFile)

export const busyCheckEveryMs = 15_000

export interface BusyReading {
  cpuInUse: number
  memoryAvailable: number
  at: number
}

export interface BusyState {
  hold?: BusyHold
  cpuHighSince?: number
  lastAt?: number
}

export interface CpuSample {
  busy: number
  total: number
}

interface CpuTimes extends CpuSample {
  at: number
}

function cpuTimes(): CpuSample {
  let busy = 0
  let total = 0
  for (const { times } of os.cpus()) {
    const all = times.user + times.nice + times.sys + times.idle + times.irq
    total += all
    busy += all - times.idle
  }
  return { busy, total }
}

export interface CpuReaderOptions {
  now?: () => number
  sample?: () => CpuSample
  wait?: (ms: number) => Promise<void>
}

const cpuSettleMs = 1_000
const cpuSampleFreshMs = 60_000

function busyShare(since: CpuTimes, current: CpuTimes): number {
  if (current.total <= since.total) return Number.NaN
  return (current.busy - since.busy) / (current.total - since.total)
}

export function createCpuReader(options: CpuReaderOptions = {}): () => Promise<number> {
  const now = options.now ?? Date.now
  const sample = options.sample ?? cpuTimes
  const wait = options.wait ?? ((ms: number) => sleep(ms))
  const take = (): CpuTimes => ({ ...sample(), at: now() })
  let previous: CpuTimes | undefined
  let last = Number.NaN
  let settling: Promise<number> | undefined
  return async () => {
    const fake = options.sample === undefined ? tedEnv('TED_LOAD_FILE') : undefined
    if (fake) return Number(readFileSync(fake, 'utf8'))
    if (settling) return settling
    const current = take()
    const since = previous
    if (since && current.at - since.at < cpuSettleMs) return last
    if (since && current.at - since.at <= cpuSampleFreshMs) {
      previous = current
      last = busyShare(since, current)
      return last
    }
    settling = (async () => {
      await wait(cpuSettleMs)
      const after = take()
      previous = after
      last = busyShare(current, after)
      return last
    })().finally(() => {
      settling = undefined
    })
    return settling
  }
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

const rounded = (share: number) => Math.round(share * 100) / 100

export function nextBusy(
  previous: BusyState,
  { cpuInUse, memoryAvailable, at }: BusyReading,
  confirmMs = busyCheckEveryMs,
): BusyState {
  const { cpu, memory } = busyMarks
  const memoryInUse = 1 - memoryAvailable
  const held = previous.hold
  const stale =
    previous.lastAt === undefined || at - previous.lastAt > Math.max(60_000, 4 * confirmMs)
  const cpuKnown = Number.isFinite(cpuInUse)
  const cpuHigh = cpuKnown && cpuInUse > cpu.holdAbove
  const cpuHighSince = cpuHigh
    ? stale || previous.cpuHighSince === undefined
      ? at
      : previous.cpuHighSince
    : undefined
  const cpuHeld =
    cpuKnown &&
    ((held?.cpuHeld === true && cpuInUse >= cpu.resumeBelow) ||
      (cpuHighSince !== undefined && at - cpuHighSince >= confirmMs))
  const memoryKnown = Number.isFinite(memoryAvailable)
  const memoryHeld =
    memoryKnown &&
    (memoryInUse > memory.holdAbove ||
      (held?.memoryHeld === true && memoryInUse >= memory.resumeBelow))
  const state: BusyState = {
    lastAt: at,
    ...(cpuHighSince !== undefined && { cpuHighSince }),
  }
  if (!cpuHeld && !memoryHeld) return state
  return {
    ...state,
    hold: {
      ...(cpuKnown && { cpuInUse: rounded(cpuInUse) }),
      ...(memoryKnown && { memoryInUse: rounded(memoryInUse) }),
      ...(cpuHeld && { cpuHeld: true as const }),
      ...(memoryHeld && { memoryHeld: true as const }),
      since: held?.since ?? new Date(at).toISOString(),
      checkedAt: new Date(at).toISOString(),
    },
  }
}

export interface BusyHoldOptions {
  on(): boolean
  loadRatio?: () => number | Promise<number>
  memoryAvailable?: () => number | Promise<number>
  memoryCacheMs?: number
  confirmMs?: number
  now?: () => number
}

export interface Busy {
  check(): Promise<BusyHold | undefined>
  current(): BusyHold | undefined
  pending(): boolean
  memory(): Promise<number>
}

export function createBusyHold(options: BusyHoldOptions): Busy {
  const now = options.now ?? Date.now
  const cpuInUse = options.loadRatio ?? createCpuReader({ now })
  const readMemory = options.memoryAvailable ?? memoryAvailableShare
  const cacheMs =
    options.memoryCacheMs ??
    (options.memoryAvailable !== undefined || tedEnv('TED_MEMORY_FILE') ? 0 : 5_000)
  const minGapMs = Math.min(1_000, options.confirmMs ?? busyCheckEveryMs)
  let state: BusyState = {}
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
        state = {}
        return undefined
      }
      if (state.lastAt !== undefined && now() - state.lastAt < minGapMs) return state.hold
      const [cpu, memoryAvailable] = await Promise.all([cpuInUse(), memoryShare()])
      if (!options.on()) {
        state = {}
        return undefined
      }
      state = nextBusy(state, { cpuInUse: cpu, memoryAvailable, at: now() }, options.confirmMs)
      return state.hold
    },
    current: () => state.hold,
    pending: () => state.hold === undefined && state.cpuHighSince !== undefined,
    memory: memoryShare,
  }
}
