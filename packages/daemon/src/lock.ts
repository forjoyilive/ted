import { DatabaseSync } from 'node:sqlite'

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
