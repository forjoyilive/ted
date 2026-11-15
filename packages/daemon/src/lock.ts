import { readdir, readlink, realpath } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { openPaths } from './leftover-processes.ts'

export class DaemonAlreadyRunningError extends Error {
  constructor() {
    super(`TED’s daemon is already running`)
  }
}

const sqliteBusy = 5

export interface Lock {
  release(): void
}

// SQLite's exclusive lock is an OS file lock, so the OS releases it when the process
// exits, even on SIGKILL. Never delete the lock file: a waiter would lock a new inode.
export function tryLock(lockPath: string): Lock | undefined {
  const db = new DatabaseSync(lockPath, { timeout: 0 })
  try {
    db.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    db.close()
    if ((error as { errcode?: number }).errcode === sqliteBusy) return undefined
    throw error
  }
  return {
    release() {
      db.exec('ROLLBACK')
      db.close()
    },
  }
}

export async function waitForLock(lockPath: string, ms: number): Promise<Lock | undefined> {
  const until = Date.now() + ms
  for (;;) {
    const lock = tryLock(lockPath)
    if (lock || Date.now() >= until) return lock
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

export function acquireLock(lockPath: string): Lock {
  const lock = tryLock(lockPath)
  if (!lock) throw new DaemonAlreadyRunningError()
  return lock
}

export function isLockHeld(lockPath: string): boolean {
  const lock = tryLock(lockPath)
  lock?.release()
  return lock === undefined
}

export async function lockHolders(...lockPaths: string[]): Promise<number[]> {
  const files = (
    await Promise.all(lockPaths.map((lockPath) => realpath(lockPath).catch(() => undefined)))
  ).filter((file) => file !== undefined)
  if (files.length === 0) return []
  if (process.platform === 'linux') return openedByOnLinux(new Set(files))
  return lsofHolders(new Set(files))
}

// Naming the files would make lsof stat them and every mount point, which -b forbids,
// so this lists the user's open files and matches the lock files' real paths.
async function lsofHolders(files: Set<string>): Promise<number[]> {
  const holders = new Set<number>()
  for (const { pid, path } of await openPaths()) if (files.has(path)) holders.add(pid)
  return [...holders]
}

export async function holdsLock(lockPath: string, pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false
  return (await lockHolders(lockPath).catch((): number[] => [])).includes(pid)
}

async function openedByOnLinux(files: Set<string>): Promise<number[]> {
  const pids = (await readdir('/proc').catch(() => [])).filter((name) => /^\d+$/.test(name))
  const holders: number[] = []
  for (const pid of pids) {
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => [])
    for (const fd of fds) {
      if (files.has(await readlink(`/proc/${pid}/fd/${fd}`).catch(() => ''))) {
        holders.push(Number(pid))
        break
      }
    }
  }
  return holders
}
