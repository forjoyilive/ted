import { execFile } from 'node:child_process'
import { readdir, readlink, realpath } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'

export class DaemonAlreadyRunningError extends Error {
  constructor() {
    super(`TED's daemon is already running`)
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

export async function lockHolders(lockPath: string): Promise<number[]> {
  const file = await realpath(lockPath).catch(() => undefined)
  if (file === undefined) return []
  if (process.platform === 'linux') return openedByOnLinux(file)
  const { stdout } = await promisify(execFile)('/usr/sbin/lsof', ['-t', '--', file]).catch(() => ({
    stdout: '',
  }))
  return stdout
    .split('\n')
    .filter((line) => /^\d+$/.test(line))
    .map(Number)
}

async function openedByOnLinux(file: string): Promise<number[]> {
  const pids = (await readdir('/proc').catch(() => [])).filter((name) => /^\d+$/.test(name))
  const holders: number[] = []
  for (const pid of pids) {
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => [])
    for (const fd of fds) {
      if ((await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')) === file) {
        holders.push(Number(pid))
        break
      }
    }
  }
  return holders
}
