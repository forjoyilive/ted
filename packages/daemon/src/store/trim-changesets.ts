import { stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { stateFile } from './files.ts'

export type ChangesetTrim =
  | { kind: 'nothing'; tableBytes: number }
  | {
      kind: 'trimmed'
      rows: number
      tableBytes: number
      bytesBefore: number
      bytesAfter: number
      ms: number
    }
  | { kind: 'failed'; reason: string }

export interface TrimOptions {
  atLeastBytes?: number
}

export const trimChangesetsAtBytes = 20 * 1024 * 1024
const table = '__livestore_session_changeset'
const index = 'idx_session_changeset_id'

// ADR 0156: LiveStore reads these rows only to roll back events after a sync backend rebases,
// and Ted has no sync backend. Call only while the store is closed.
export async function trimChangesets(
  directory: string,
  options: TrimOptions = {},
): Promise<ChangesetTrim> {
  try {
    const file = await stateFile(directory)
    if (!file) return { kind: 'nothing', tableBytes: 0 }
    const db = new DatabaseSync(file)
    try {
      const tableBytes = Number(
        (
          db
            .prepare('SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name IN (?, ?)')
            .get(table, index) as { bytes: number }
        ).bytes,
      )
      if (tableBytes < (options.atLeastBytes ?? trimChangesetsAtBytes)) {
        return { kind: 'nothing', tableBytes }
      }
      const startedAt = performance.now()
      const bytesBefore = (await stat(file)).size
      const rows = Number(db.prepare(`DELETE FROM ${table}`).run().changes)
      db.exec('VACUUM')
      return {
        kind: 'trimmed',
        rows,
        tableBytes,
        bytesBefore,
        bytesAfter: (await stat(file)).size,
        ms: Math.round(performance.now() - startedAt),
      }
    } finally {
      db.close()
    }
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}
