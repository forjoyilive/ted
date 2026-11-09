import { lstat, open, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { isLockHeld } from './lock.ts'
import { runFiles } from './runs/host-files.ts'

export const runOutputKeepMs = 14 * 24 * 60 * 60 * 1000
export const runOutputMaxBytes = 100 * 1024 * 1024

const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface PruneOptions {
  runsDir: string
  isLive: (runId: string) => boolean
  now?: Date
  keepMs?: number
  maxBytes?: number
}

export interface PruneResult {
  removed: string[]
  trimmed: string[]
}

export async function pruneRunOutput(options: PruneOptions): Promise<PruneResult> {
  const now = (options.now ?? new Date()).getTime()
  const keepMs = options.keepMs ?? runOutputKeepMs
  const maxBytes = options.maxBytes ?? runOutputMaxBytes
  const result: PruneResult = { removed: [], trimmed: [] }
  const names = await readdir(options.runsDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const runId of names) {
    if (!runIdPattern.test(runId) || options.isLive(runId)) continue
    const dir = path.join(options.runsDir, runId)
    const entry = await lstat(dir).catch(() => undefined)
    if (!entry?.isDirectory()) continue
    const files = runFiles(dir)
    if (await hostRunning(files.lock)) continue
    const log = await lstat(files.log).catch(() => undefined)
    const stoppedAt = (log ?? entry).mtimeMs
    try {
      if (now - stoppedAt > keepMs) {
        await rm(dir, { recursive: true, force: true })
        result.removed.push(runId)
      } else if (log?.isFile() && log.size > maxBytes) {
        await keepTail(files.log, log.size, maxBytes)
        result.trimmed.push(runId)
      }
    } catch (error) {
      console.error(`couldn’t prune Run ${runId}’s output:`, error)
    }
  }
  return result
}

async function hostRunning(lock: string): Promise<boolean> {
  const found = await stat(lock).catch(() => undefined)
  return found !== undefined && isLockHeld(lock)
}

async function keepTail(file: string, size: number, maxBytes: number): Promise<void> {
  const source = await open(file, 'r')
  let tail: Buffer
  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await source.read(buffer, 0, maxBytes, size - maxBytes)
    const firstLineEnd = buffer.indexOf(10)
    tail = buffer.subarray(firstLineEnd + 1, bytesRead)
  } finally {
    await source.close()
  }
  const tmp = `${file}.${process.pid}.trim`
  const target = await open(tmp, 'w', 0o600)
  try {
    await target.writeFile(tail)
  } finally {
    await target.close()
  }
  await rename(tmp, file)
}
