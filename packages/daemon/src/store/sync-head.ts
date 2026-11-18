import { DatabaseSync } from 'node:sqlite'
import { eventlogFile } from './files.ts'

export type SyncHeadMark =
  | { kind: 'nothing' }
  | { kind: 'marked'; from: number; to: number }
  | { kind: 'failed'; reason: string }

// LiveStore keeps every event above this head in memory as not yet pushed to a sync
// backend, and Ted has none. Call only while the store is closed.
export async function markEventsSynced(directory: string): Promise<SyncHeadMark> {
  try {
    const file = await eventlogFile(directory)
    if (!file) return { kind: 'nothing' }
    const db = new DatabaseSync(file)
    try {
      const row = db
        .prepare(
          `SELECT head, (SELECT COALESCE(MAX(seqNumGlobal), 0) FROM eventlog) AS newest
           FROM __livestore_sync_status`,
        )
        .get() as { head: number; newest: number } | undefined
      if (!row || row.head === row.newest) return { kind: 'nothing' }
      db.prepare('UPDATE __livestore_sync_status SET head = ?').run(row.newest)
      return { kind: 'marked', from: row.head, to: row.newest }
    } finally {
      db.close()
    }
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}
