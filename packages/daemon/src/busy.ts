import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { type BusyHold, busyMarks, type MachineUsage, tedEnv } from '@ted/protocol'

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
  cores: number
}

interface CpuTimes extends CpuSample {
  at: number
}

function cpuTimes(): CpuSample {
  let busy = 0
  let total = 0
  const cpus = os.cpus()
  for (const { times } of cpus) {
    const all = times.user + times.nice + times.sys + times.idle + times.irq
    total += all
    busy += all - times.idle
  }
  return { busy, total, cores: cpus.length }
}

export interface CpuReaderOptions {
  now?: () => number
  sample?: () => CpuSample
  wait?: (ms: number) => Promise<void>
}

export interface CpuWindow {
  elapsedMs: number
  cores: number
  busyMs: number
  countedMs: number
  share: number
}

export interface CpuReader {
  read(): Promise<number>
  last(): CpuWindow | undefined
}

const cpuSettleMs = 1_000
const cpuSampleFreshMs = 60_000
const leastCountedShare = 0.5

function cpuWindow(since: CpuTimes, current: CpuTimes): CpuWindow {
  const elapsedMs = current.at - since.at
  const busyMs = current.busy - since.busy
  const countedMs = current.total - since.total
  const trusted =
    current.cores > 0 &&
    current.cores === since.cores &&
    elapsedMs > 0 &&
    busyMs >= 0 &&
    countedMs > 0 &&
    busyMs <= countedMs &&
    countedMs >= elapsedMs * current.cores * leastCountedShare
  return {
    elapsedMs,
    cores: current.cores,
    busyMs,
    countedMs,
    share: trusted ? busyMs / countedMs : Number.NaN,
  }
}

export function createCpuReader(options: CpuReaderOptions = {}): CpuReader {
  const now = options.now ?? (() => performance.now())
  const sample = options.sample ?? cpuTimes
  const wait = options.wait ?? ((ms: number) => sleep(ms))
  const take = (): CpuTimes => ({ ...sample(), at: now() })
  let previous: CpuTimes | undefined
  let last: CpuWindow | undefined
  let settling: Promise<number> | undefined
  const measure = (since: CpuTimes, current: CpuTimes) => {
    previous = current
    last = cpuWindow(since, current)
    return last.share
  }
  return {
    last: () => last,
    async read() {
      const fake = options.sample === undefined ? tedEnv('TED_LOAD_FILE') : undefined
      if (fake) return Number(readFileSync(fake, 'utf8'))
      if (settling) return settling
      const current = take()
      const since = previous
      const elapsed = since ? current.at - since.at : Number.NaN
      if (since && elapsed >= 0 && elapsed < cpuSettleMs) return last?.share ?? Number.NaN
      if (since && elapsed >= cpuSettleMs && elapsed <= cpuSampleFreshMs) {
        return measure(since, current)
      }
      settling = (async () => {
        await wait(cpuSettleMs)
        return measure(current, take())
      })().finally(() => {
        settling = undefined
      })
      return settling
    },
  }
}

export function describeCpuWindow(window: CpuWindow | undefined): string {
  if (!window) return 'CPU: not sampled yet'
  const counted = `${Math.round(window.busyMs)} ms busy of ${Math.round(window.countedMs)} ms counted on ${window.cores} cores over ${Math.round(window.elapsedMs)} ms`
  return Number.isFinite(window.share)
    ? `CPU: ${Math.round(window.share * 100)}% (${counted})`
    : `CPU: last sample refused (${counted})`
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
  reading(): Promise<MachineUsage>
  cpuSample(): string
}

export function createBusyHold(options: BusyHoldOptions): Busy {
  const now = options.now ?? Date.now
  const reader = createCpuReader()
  const cpuInUse = options.loadRatio ?? reader.read
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
    async reading() {
      const [cpu, memoryAvailable] = await Promise.all([
        Promise.resolve(cpuInUse()).catch(() => Number.NaN),
        memoryShare(),
      ])
      return {
        cpuInUse: Number.isFinite(cpu) ? rounded(cpu) : null,
        memoryInUse: Number.isFinite(memoryAvailable) ? rounded(1 - memoryAvailable) : null,
      }
    },
    cpuSample: () => describeCpuWindow(reader.last()),
  }
}
