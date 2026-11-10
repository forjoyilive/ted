import { constants } from 'node:fs'
import { copyFile, open, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Schema } from '@livestore/livestore'
import { eventlogFile } from './files.ts'
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
const oldOutput = `('${v1.name}', '${v2.name}')`
const key = ['seqNumGlobal', 'seqNumClient', 'seqNumRebaseGeneration']
const batch = 5000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ADR 0099: keeps what the materializers read (runId, toOffset, the last entry’s `at`)
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

function withDb<T>(file: string, readOnly: boolean, work: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly })
  try {
    return work(db)
  } finally {
    db.close()
  }
}

function useCompactedArgs(db: DatabaseSync, onRewrite?: () => void): void {
  db.function('ted_compacted_args', { deterministic: true }, (name, argsJson) => {
    const compacted = compactedArgs(String(name), String(argsJson))
    if (compacted !== argsJson) onRewrite?.()
    return compacted
  })
}

const count = (db: DatabaseSync, sql: string): number =>
  (db.prepare(sql).get() as { count: number }).count

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

function sameRows(db: DatabaseSync, sql: (schema: string) => string, what: string): void {
  const rows = (schema: string) => JSON.stringify(db.prepare(sql(schema)).all())
  if (rows('main') !== rows('original')) throw new Error(`${what} differ from the original`)
}

function verify(copy: string, original: string): void {
  withDb(copy, true, (db) => {
    const integrity = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new Error(`the copy fails SQLite’s integrity check: ${JSON.stringify(integrity[0])}`)
    }
    db.prepare('ATTACH DATABASE ? AS original').run(original)

    for (const pragma of ['page_size', 'user_version', 'encoding', 'auto_vacuum']) {
      sameRows(db, (schema) => `PRAGMA ${schema}.${pragma}`, `${pragma} settings`)
    }
    sameRows(
      db,
      (schema) =>
        `SELECT type, name, tbl_name, sql FROM ${schema}.sqlite_master ORDER BY type, name`,
      'tables and indexes',
    )
    const tables = db
      .prepare(`SELECT name FROM main.sqlite_master WHERE type = 'table' AND name != 'eventlog'`)
      .all() as { name: string }[]
    for (const { name } of tables) {
      sameRows(db, (schema) => `SELECT * FROM ${schema}."${name}" ORDER BY rowid`, `${name} rows`)
    }
    sameRows(
      db,
      (schema) =>
        `SELECT name, COUNT(*) AS count FROM ${schema}.eventlog GROUP BY name ORDER BY name`,
      'event counts by name',
    )

    const columns = (db.prepare('PRAGMA main.table_info(eventlog)').all() as { name: string }[])
      .map((column) => column.name)
      .filter((column) => !key.includes(column))
    if (!columns.includes('argsJson') || !columns.includes('name')) {
      throw new Error('the event log table isn’t laid out as expected')
    }
    const joined = `FROM original.eventlog o JOIN main.eventlog c
      ON ${key.map((column) => `o."${column}" = c."${column}"`).join(' AND ')}`
    const same = (list: string[]) => list.map((c) => `o."${c}" IS c."${c}"`).join(' AND ')
    const total = (schema: string, where: string) =>
      count(db, `SELECT COUNT(*) AS count FROM ${schema}.eventlog WHERE ${where}`)

    const others = `name NOT IN ${oldOutput}`
    const untouched = count(
      db,
      `SELECT COUNT(*) AS count ${joined} WHERE o.${others} AND ${same(columns)}`,
    )
    if (untouched !== total('original', others) || untouched !== total('main', others)) {
      throw new Error('an event other than old Run output changed')
    }

    const outputs = `name IN ${oldOutput}`
    const value = (alias: string, at: string) => `json_extract(${alias}.argsJson, '${at}')`
    const sameValues = ['$.runId', '$.toOffset', '$.entries[#-1].at']
      .map((at) => `${value('o', at)} IS ${value('c', at)}`)
      .join(' AND ')
    const kept = count(
      db,
      `SELECT COUNT(*) AS count ${joined}
       WHERE o.${outputs} AND ${same(columns.filter((c) => c !== 'argsJson'))} AND ${sameValues}`,
    )
    if (kept !== total('original', outputs) || kept !== total('main', outputs)) {
      throw new Error('an old Run output event lost its Run, offset or last output time')
    }

    const decoders: Record<string, (args: unknown) => unknown> = {
      [v1.name]: Schema.decodeUnknownSync(v1.schema),
      [v2.name]: Schema.decodeUnknownSync(v2.schema),
    }
    const rows = db
      .prepare(`SELECT seqNumGlobal, name, argsJson FROM main.eventlog WHERE ${outputs}`)
      .iterate() as Iterable<{ seqNumGlobal: number; name: string; argsJson: string }>
    for (const row of rows) {
      try {
        decoders[row.name]?.(JSON.parse(row.argsJson))
      } catch (error) {
        throw new Error(`event ${row.seqNumGlobal} no longer fits ${row.name}`, { cause: error })
      }
    }
  })
}

async function flush(file: string): Promise<void> {
  const handle = await open(file, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function compactOutputEvents(
  directory: string,
  options: CompactOptions = {},
): Promise<Compaction> {
  const eventlog = await eventlogFile(directory)
  if (!eventlog) return { kind: 'failed', reason: 'there is no event log' }
  const copy = `${eventlog}.compacting`
  const discard = async () => {
    await rm(copy, { force: true })
    await rm(`${copy}-journal`, { force: true })
  }
  try {
    await discard()
    const bytesBefore = (await stat(eventlog)).size
    await copyFile(eventlog, copy, constants.COPYFILE_FICLONE)

    let rewritten = 0
    const db = new DatabaseSync(copy)
    try {
      useCompactedArgs(db, () => rewritten++)
      // The copy is thrown away on any failure, so it needs no rollback journal.
      db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF')
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
      db.exec('VACUUM')
    } finally {
      db.close()
    }

    await options.beforeVerify?.(copy)
    verify(copy, eventlog)
    await flush(copy)
    const bytesAfter = (await stat(copy)).size
    await rename(copy, eventlog)
    await flush(path.dirname(eventlog)).catch(() => undefined)
    return { kind: 'compacted', rewritten, bytesBefore, bytesAfter }
  } catch (error) {
    await discard().catch(() => undefined)
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}
