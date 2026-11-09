import { execFile } from 'node:child_process'
import { rm, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { diskFullHold, diskLimits, formatBytes } from '@ted/protocol'
import type { Banners } from './banners.ts'

const run = promisify(execFile)

export interface DiskReading {
  freeBytes: number
  held: boolean
}

export interface DiskWatchOptions {
  storeDir: string
  banners: Banners
  hold: (reason: string | undefined) => void
  freeBytes: () => Promise<number>
  probe?: () => Promise<void>
  checkEveryMs?: number
}

export interface DiskWatch {
  check(): Promise<DiskReading | undefined>
  reading(): DiskReading | undefined
  held(): boolean
  cantSave(): boolean
  writeFailed(): void
  writeSucceeded(): void
  start(): void
  close(): void
}

export const cantSaveMessage = 'TED can’t save changes: disk full'

const openStorage = {
  label: 'Open Storage',
  opens: { kind: 'settings' as const, section: 'storage' },
}
const almostFull = { problem: 'disk-almost-full' }
const full = { problem: 'disk-full' }
const unsaved = { problem: 'store-write-failed' }
const probeBytes = 1024 * 1024

export function createDiskWatch(options: DiskWatchOptions): DiskWatch {
  const { banners } = options
  const probe = options.probe ?? (() => probeStore(options.storeDir))
  let last: DiskReading | undefined
  let held = false
  let failing = false
  let timer: NodeJS.Timeout | undefined
  let checking: Promise<DiskReading | undefined> | undefined

  function setHeld(next: boolean): void {
    if (next === held) return
    held = next
    options.hold(next ? diskFullHold : undefined)
  }

  function show(freeBytes: number): void {
    const free = `${formatBytes(freeBytes)} free`
    if (held) {
      banners.clear(almostFull)
      banners.raise({
        ...full,
        severity: 'stops-work',
        text: `Disk full · new work held · ${free}`,
        action: openStorage,
      })
      return
    }
    banners.clear(full)
    if (freeBytes < diskLimits.warnBelowBytes) {
      banners.raise({
        ...almostFull,
        severity: 'warning',
        text: `Disk almost full · ${free}`,
        action: openStorage,
      })
    } else banners.clear(almostFull)
  }

  async function measure(): Promise<DiskReading | undefined> {
    if (failing) {
      const saved = await probe().then(
        () => true,
        () => false,
      )
      if (saved) watch.writeSucceeded()
    }
    let freeBytes: number
    try {
      freeBytes = await options.freeBytes()
    } catch (error) {
      console.error('couldn’t read free disk space:', error)
      return last
    }
    if (held && freeBytes > diskLimits.releaseAboveBytes) setHeld(false)
    else if (!held && freeBytes < diskLimits.holdBelowBytes) setHeld(true)
    last = { freeBytes, held }
    if (!failing) {
      try {
        show(freeBytes)
      } catch (error) {
        console.error('couldn’t show the disk banner:', error)
      }
    }
    return last
  }

  const watch: DiskWatch = {
    check() {
      checking ??= measure().finally(() => {
        checking = undefined
      })
      return checking
    },
    reading: () => last,
    held: () => held,
    cantSave: () => failing,
    writeFailed() {
      if (failing) return
      failing = true
      console.error('a store write failed because the disk is full')
      banners.raiseUnsaved({
        ...unsaved,
        severity: 'stops-work',
        text: cantSaveMessage,
        action: openStorage,
      })
    },
    writeSucceeded() {
      if (!failing) return
      failing = false
      banners.clear(unsaved)
      if (last) show(last.freeBytes)
    },
    start() {
      timer ??= setInterval(() => void watch.check(), options.checkEveryMs ?? 60_000)
      timer.unref()
    },
    close() {
      clearInterval(timer)
      timer = undefined
    },
  }
  return watch
}

export async function freeBytesAt(dir: string): Promise<number> {
  const stats = await statfs(dir)
  return Number(stats.bavail) * Number(stats.bsize)
}

async function probeStore(storeDir: string): Promise<void> {
  const file = path.join(storeDir, '.write-check')
  try {
    await writeFile(file, Buffer.alloc(probeBytes), { flush: true })
  } finally {
    await rm(file, { force: true })
  }
}

export function isDiskFullError(error: unknown): boolean {
  for (let at: unknown = error, depth = 0; at && depth < 10; depth++) {
    const current = at as { code?: unknown; message?: unknown; cause?: unknown }
    if (current.code === 'ENOSPC' || current.code === 'SQLITE_FULL') return true
    if (
      typeof current.message === 'string' &&
      /ENOSPC|SQLITE_FULL|database or disk is full|no space left on device/i.test(current.message)
    ) {
      return true
    }
    at = current.cause
  }
  return false
}

export async function volumeName(dir: string, platform = process.platform): Promise<string> {
  const { stdout } = await run('df', ['-P', dir])
  const line = stdout.trim().split('\n').at(-1) ?? ''
  const mount = /\d+%\s+(\/.*)$/.exec(line)?.[1] ?? '/'
  if (platform !== 'darwin') return mount
  const target = mount === '/System/Volumes/Data' ? '/' : mount
  const info = await run('diskutil', ['info', '-plist', target]).catch(() => undefined)
  const name = info && /<key>VolumeName<\/key>\s*<string>([^<]*)<\/string>/.exec(info.stdout)?.[1]
  return name ? name : mount
}

export async function excludeFromTimeMachine(
  dirs: readonly string[],
  platform = process.platform,
): Promise<void> {
  if (platform !== 'darwin' || dirs.length === 0) return
  await run('tmutil', ['addexclusion', ...dirs])
}
