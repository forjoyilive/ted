import type { DatabaseSync } from 'node:sqlite'
import { Schema } from '@livestore/livestore'
import { eventlogFile } from './files.ts'
import { count, nameList, rewriteEventlog, withDb } from './rewrite-eventlog.ts'
import { events } from './schema.ts'

export type Compaction =
  | { kind: 'compacted'; rewritten: number; bytesBefore: number; bytesAfter: number }
  | { kind: 'failed'; reason: string }

export interface CompactOptions {
  onProgress?: (progress: { done: number; total: number }) => void
  beforeVerify?: (copy: string) => void | Promise<void>
}

const v1 = events.runOutputRead
const v2 = events.runOutputReadV2
const oldOutput = nameList([v1.name, v2.name])
const batch = 5000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Keeps what the materializers read (runId, toOffset, the last entry’s `at`)
// and drops the lines. Anything that isn’t exactly the shipped shape comes back unchanged.
function compactedArgs(name: string, argsJson: string): string {
  if (name !== v1.name && name !== v2.name) return argsJson
  let args: unknown
  try {
    args = JSON.parse(argsJson)
  } catch {
    return argsJson
  }
  if (!isRecord(args) || Object.keys(args).length !== 3) return argsJson
  const { runId, toOffset, entries } = args
  if (typeof runId !== 'string' || typeof toOffset !== 'number' || !Array.isArray(entries)) {
    return argsJson
  }
  let kept: unknown[] = []
  if (name === v2.name && entries.length > 0) {
    const last: unknown = entries.at(-1)
    if (!isRecord(last) || typeof last.offset !== 'number' || typeof last.at !== 'string') {
      return argsJson
    }
    kept = [{ offset: last.offset, line: '', at: last.at }]
  }
  const compacted = JSON.stringify({ runId, toOffset, entries: kept })
  return compacted.length < argsJson.length ? compacted : argsJson
}

function useCompactedArgs(db: DatabaseSync, onRewrite?: () => void): void {
  db.function('ted_compacted_args', { deterministic: true }, (name, argsJson) => {
    const compacted = compactedArgs(String(name), String(argsJson))
    if (compacted !== argsJson) onRewrite?.()
    return compacted
  })
}

export async function hasOutputToCompact(directory: string): Promise<boolean> {
  const eventlog = await eventlogFile(directory)
  if (!eventlog) return false
  return withDb(eventlog, true, (db) => {
    useCompactedArgs(db)
    const found = db
      .prepare(
        `SELECT 1 FROM eventlog
         WHERE name IN ${oldOutput} AND ted_compacted_args(name, argsJson) IS NOT argsJson
         LIMIT 1`,
      )
      .get()
    return found !== undefined
  })
}

const value = (alias: string, at: string) => `json_extract(${alias}.argsJson, '${at}')`

const check = {
  names: [v1.name, v2.name],
  othersChanged: 'an event other than old Run output changed',
  keptValues: ['$.runId', '$.toOffset', '$.entries[#-1].at']
    .map((at) => `${value('o', at)} IS ${value('c', at)}`)
    .join(' AND '),
  lostValues: 'an old Run output event lost its Run, offset or last output time',
  decoders: {
    [v1.name]: Schema.decodeUnknownSync(v1.schema),
    [v2.name]: Schema.decodeUnknownSync(v2.schema),
  },
}

export async function compactOutputEvents(
  directory: string,
  options: CompactOptions = {},
): Promise<Compaction> {
  const result = await rewriteEventlog(directory, {
    suffix: 'compacting',
    check,
    ...(options.beforeVerify && { beforeVerify: options.beforeVerify }),
    async rewrite(db) {
      let rewritten = 0
      useCompactedArgs(db, () => rewritten++)
      const total = count(db, 'SELECT COUNT(*) AS count FROM eventlog')
      const range = db
        .prepare('SELECT MIN(seqNumGlobal) AS first, MAX(seqNumGlobal) AS last FROM eventlog')
        .get() as { first: number | null; last: number | null }
      const update = db.prepare(
        `UPDATE eventlog SET argsJson = ted_compacted_args(name, argsJson)
         WHERE seqNumGlobal BETWEEN ? AND ? AND name IN ${oldOutput}`,
      )
      const upTo = db.prepare('SELECT COUNT(*) AS count FROM eventlog WHERE seqNumGlobal <= ?')
      const first = range.first ?? 0
      const last = range.last ?? -1
      for (let from = first; from <= last; from += batch) {
        const to = Math.min(from + batch - 1, last)
        update.run(from, to)
        options.onProgress?.({ done: (upTo.get(to) as { count: number }).count, total })
        await new Promise((resolve) => setImmediate(resolve))
      }
      return rewritten
    },
  })
  if (result.kind === 'failed') return result
  const { rewritten, bytesBefore, bytesAfter } = result
  return { kind: 'compacted', rewritten, bytesBefore, bytesAfter }
}
