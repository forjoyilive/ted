import { constants } from 'node:fs'
import { copyFile, open, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { eventlogFile } from './files.ts'
import { events } from './schema.ts'

export type OutputDrop =
  | { kind: 'nothing' }
  | { kind: 'dropped'; dropped: number; events: number; bytesBefore: number; bytesAfter: number }
  | { kind: 'failed'; reason: string }

export interface DropOptions {
  atLeast?: number
  backUp?: () => Promise<unknown>
  beforeVerify?: (copy: string) => void | Promise<void>
}

const v1 = events.runOutputRead.name
const v2 = events.runOutputReadV2.name
const v3 = events.runOutputReadV3.name
const outputs = `('${v1}', '${v2}', '${v3}')`
const body = ['name', 'argsJson', 'clientId', 'sessionId', 'schemaHash', 'syncMetadataJson']

interface Row {
  name: string
  argsJson: string
  [column: string]: unknown
}

interface Read {
  runId: string
  toOffset: number
  at?: string
}

// What the three materializers take from an event; undefined when it isn’t the shipped shape.
function readOf(name: string, argsJson: string): Read | undefined {
  let args: unknown
  try {
    args = JSON.parse(argsJson)
  } catch {
    return undefined
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const { runId, toOffset, entries, lastOutputAt } = args as Record<string, unknown>
  if (typeof runId !== 'string' || typeof toOffset !== 'number') return undefined
  if (name === v1) return { runId, toOffset }
  if (name === v2) {
    if (!Array.isArray(entries)) return undefined
    const last: unknown = entries.at(-1)
    if (last === undefined) return { runId, toOffset }
    const at = (last as { at?: unknown } | null)?.at
    return typeof at === 'string' ? { runId, toOffset, at } : undefined
  }
  if (lastOutputAt === null) return { runId, toOffset }
  return typeof lastOutputAt === 'string' ? { runId, toOffset, at: lastOutputAt } : undefined
}

const isOutput = (name: string) => name === v1 || name === v2 || name === v3

function withDb<T>(file: string, readOnly: boolean, work: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly })
  try {
    return work(db)
  } finally {
    db.close()
  }
}

const one = <T>(db: DatabaseSync, sql: string): T => db.prepare(sql).get() as T

const ordered = (db: DatabaseSync, schema: string, where = '1') =>
  db
    .prepare(
      `SELECT seqNumGlobal, ${body.join(', ')} FROM ${schema}.eventlog WHERE ${where}
       ORDER BY seqNumGlobal`,
    )
    .iterate() as Iterable<Row & { seqNumGlobal: number }>

// The sequence numbers of the output events a later one for the same Run replaces: every one
// but each Run’s last and the last that carries an output time.
function superseded(db: DatabaseSync): number[] {
  const lastRead = new Map<string, number>()
  const lastTimed = new Map<string, number>()
  const known: { seq: number; runId: string }[] = []
  for (const row of ordered(db, 'main', `name IN ${outputs}`)) {
    const read = readOf(row.name, row.argsJson)
    if (!read) continue
    known.push({ seq: row.seqNumGlobal, runId: read.runId })
    lastRead.set(read.runId, row.seqNumGlobal)
    if (read.at !== undefined) lastTimed.set(read.runId, row.seqNumGlobal)
  }
  return known.flatMap(({ seq, runId }) =>
    lastRead.get(runId) !== seq && lastTimed.get(runId) !== seq ? [seq] : [],
  )
}

// Renumbering assumes one client’s unbroken chain: 1, 2, 3… each pointing at the one before.
function isPlainChain(db: DatabaseSync, schema = 'main'): boolean {
  const { odd } = one<{ odd: number }>(
    db,
    `SELECT COUNT(*) AS odd FROM ${schema}.eventlog
     WHERE seqNumClient != 0 OR seqNumRebaseGeneration != 0 OR parentSeqNumClient != 0
        OR parentSeqNumRebaseGeneration != 0 OR parentSeqNumGlobal != seqNumGlobal - 1`,
  )
  const { count, first, last } = one<{ count: number; first: number | null; last: number | null }>(
    db,
    `SELECT COUNT(*) AS count, MIN(seqNumGlobal) AS first, MAX(seqNumGlobal) AS last
     FROM ${schema}.eventlog`,
  )
  return odd === 0 && (count === 0 || (last ?? 0) - (first ?? 0) + 1 === count)
}

function sameRows(db: DatabaseSync, sql: (schema: string) => string, what: string): void {
  const rows = (schema: string) => JSON.stringify(db.prepare(sql(schema)).all())
  if (rows('main') !== rows('original')) throw new Error(`${what} differ from the original`)
}

function finalReads(db: DatabaseSync, schema: string): string {
  const reads = new Map<string, { toOffset: number; at?: string }>()
  for (const row of ordered(db, schema, `name IN ${outputs}`)) {
    const read = readOf(row.name, row.argsJson)
    if (!read) continue
    const at = read.at ?? reads.get(read.runId)?.at
    reads.set(read.runId, { toOffset: read.toOffset, ...(at !== undefined && { at }) })
  }
  return JSON.stringify([...reads].sort(([a], [b]) => a.localeCompare(b)))
}

function verify(copy: string, original: string, dropped: number): void {
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

    if (!isPlainChain(db)) throw new Error('the copy’s events aren’t numbered in one chain')
    const first = (schema: string) =>
      one<{ first: number | null }>(db, `SELECT MIN(seqNumGlobal) AS first FROM ${schema}.eventlog`)
        .first
    if (first('main') !== first('original')) throw new Error('the copy starts at another number')

    // Walks both logs in order: every event of the copy must be the original’s next event,
    // unchanged, and the original events passed over must be readable Run output events.
    const kept = ordered(db, 'main')[Symbol.iterator]()
    let next = kept.next()
    let skipped = 0
    for (const row of ordered(db, 'original')) {
      const copyRow = next.done ? undefined : next.value
      if (copyRow && body.every((column) => copyRow[column] === row[column])) {
        next = kept.next()
        continue
      }
      if (!isOutput(row.name) || !readOf(row.name, row.argsJson)) {
        throw new Error(`event ${row.seqNumGlobal} (${row.name}) is missing or changed`)
      }
      skipped++
    }
    if (!next.done) throw new Error('the copy holds an event the original doesn’t')
    if (skipped !== dropped) throw new Error(`${skipped} events are gone, not ${dropped}`)
    if (finalReads(db, 'main') !== finalReads(db, 'original')) {
      throw new Error('a Run’s read offset or last output time changed')
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

export async function supersededOutputCount(directory: string): Promise<number> {
  const eventlog = await eventlogFile(directory)
  if (!eventlog) return 0
  return withDb(eventlog, true, (db) => (isPlainChain(db) ? superseded(db).length : 0))
}

// ADR 0122: run only with the store closed, when the state is about to be rebuilt from the
// event log. Every state file, of any schema, goes before the renumbered log is in place.
export async function dropSupersededOutput(
  directory: string,
  options: DropOptions = {},
): Promise<OutputDrop> {
  const eventlog = await eventlogFile(directory)
  if (!eventlog) return { kind: 'nothing' }
  const copy = `${eventlog}.dropping`
  const discard = async () => {
    await rm(copy, { force: true })
    await rm(`${copy}-journal`, { force: true })
  }
  try {
    const drop = withDb(eventlog, true, (db) => (isPlainChain(db) ? superseded(db) : []))
    if (drop.length < (options.atLeast ?? 1000)) return { kind: 'nothing' }
    await options.backUp?.()
    await discard()
    const bytesBefore = (await stat(eventlog)).size
    await copyFile(eventlog, copy, constants.COPYFILE_FICLONE)

    const events = withDb(copy, false, (db) => {
      // The copy is thrown away on any failure, so it needs no rollback journal.
      db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF')
      db.exec('CREATE TEMP TABLE gone (seq INTEGER PRIMARY KEY)')
      const gone = db.prepare('INSERT INTO gone (seq) VALUES (?)')
      db.exec('BEGIN')
      for (const seq of drop) gone.run(seq)
      db.exec('COMMIT')
      const { first } = one<{ first: number }>(
        db,
        'SELECT MIN(seqNumGlobal) AS first FROM eventlog',
      )
      db.exec('DELETE FROM eventlog WHERE seqNumGlobal IN (SELECT seq FROM gone)')
      db.exec('CREATE TEMP TABLE renumbered (old INTEGER PRIMARY KEY, new INTEGER NOT NULL)')
      db.prepare(
        `INSERT INTO renumbered (old, new)
         SELECT seqNumGlobal, ROW_NUMBER() OVER (ORDER BY seqNumGlobal) + ? - 1 FROM eventlog`,
      ).run(first)
      // Negative numbers first, so no row takes a number another row still has.
      db.exec(
        `UPDATE eventlog
         SET seqNumGlobal = -(SELECT new FROM renumbered WHERE old = eventlog.seqNumGlobal)`,
      )
      db.exec(
        'UPDATE eventlog SET parentSeqNumGlobal = -seqNumGlobal - 1, seqNumGlobal = -seqNumGlobal',
      )
      db.exec('DROP TABLE gone; DROP TABLE renumbered; VACUUM')
      return one<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM eventlog').count
    })

    await options.beforeVerify?.(copy)
    verify(copy, eventlog, drop.length)
    await flush(copy)
    const bytesAfter = (await stat(copy)).size
    const folder = path.dirname(eventlog)
    for (const file of await readdir(folder)) {
      if (file.startsWith('state')) await rm(path.join(folder, file), { force: true })
    }
    await rename(copy, eventlog)
    await flush(folder).catch(() => undefined)
    return { kind: 'dropped', dropped: drop.length, events, bytesBefore, bytesAfter }
  } catch (error) {
    await discard().catch(() => undefined)
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}
