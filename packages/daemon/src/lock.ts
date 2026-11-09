import { DatabaseSync } from 'node:sqlite'

export class DaemonAlreadyRunningError extends Error {
  constructor() {
    super(`TED's daemon is already running`)
  }
}

const sqliteBusy = 5

// SQLite's exclusive lock is an OS file lock, so the OS releases it when the process
// exits, even on SIGKILL. Never delete the lock file: a waiter would lock a new inode.
export function acquireLock(lockPath: string): { release(): void } {
  const db = new DatabaseSync(lockPath, { timeout: 0 })
  try {
    db.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    db.close()
    if ((error as { errcode?: number }).errcode === sqliteBusy)
      throw new DaemonAlreadyRunningError()
    throw error
  }
  return {
    release() {
      db.exec('ROLLBACK')
      db.close()
    },
  }
}
