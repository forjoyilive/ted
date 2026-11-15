import { constants } from 'node:fs'
import { copyFile, open, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { eventlogFile } from './files.ts'

export const eventKey = ['seqNumGlobal', 'seqNumClient', 'seqNumRebaseGeneration']

export interface RewriteCheck {
  names: readonly string[]
  othersChanged: string
  keptValues: string
  lostValues: string
  decoders: Record<string, (args: unknown) => unknown>
  alsoCheck?: (db: DatabaseSync) => void
}

export type Rewrite =
  | { kind: 'rewritten'; rewritten: number; bytesBefore: number; bytesAfter: number }
  | { kind: 'failed'; reason: string }

export function withDb<T>(file: string, readOnly: boolean, work: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly })
  try {
    return work(db)
  } finally {
    db.close()
  }
}

export const count = (db: DatabaseSync, sql: string): number =>
  (db.prepare(sql).get() as { count: number }).count

export const nameList = (names: readonly string[]): string =>
  `(${names.map((name) => `'${name}'`).join(', ')})`

function sameRows(db: DatabaseSync, sql: (schema: string) => string, what: string): void {
  const rows = (schema: string) => JSON.stringify(db.prepare(sql(schema)).all())
  if (rows('main') !== rows('original')) throw new Error(`${what} differ from the original`)
}

// `keptValues` is SQL over the original’s row `o` and the copy’s row `c` that must hold for
// every row of `names`.
function verify(copy: string, original: string, check: RewriteCheck): void {
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
      .filter((column) => !eventKey.includes(column))
    if (!columns.includes('argsJson') || !columns.includes('name')) {
      throw new Error('the event log table isn’t laid out as expected')
    }
    const joined = `FROM original.eventlog o JOIN main.eventlog c
      ON ${eventKey.map((column) => `o."${column}" = c."${column}"`).join(' AND ')}`
    const same = (list: string[]) => list.map((c) => `o."${c}" IS c."${c}"`).join(' AND ')
    const total = (schema: string, where: string) =>
      count(db, `SELECT COUNT(*) AS count FROM ${schema}.eventlog WHERE ${where}`)

    const names = nameList(check.names)
    const others = `name NOT IN ${names}`
    const untouched = count(
      db,
      `SELECT COUNT(*) AS count ${joined} WHERE o.${others} AND ${same(columns)}`,
    )
    if (untouched !== total('original', others) || untouched !== total('main', others)) {
      throw new Error(check.othersChanged)
    }

    const rewritable = `name IN ${names}`
    const kept = count(
      db,
      `SELECT COUNT(*) AS count ${joined}
       WHERE o.${rewritable} AND ${same(columns.filter((c) => c !== 'argsJson'))}
         AND ${check.keptValues}`,
    )
    if (kept !== total('original', rewritable) || kept !== total('main', rewritable)) {
      throw new Error(check.lostValues)
    }

    const rows = db
      .prepare(`SELECT seqNumGlobal, name, argsJson FROM main.eventlog WHERE ${rewritable}`)
      .iterate() as Iterable<{ seqNumGlobal: number; name: string; argsJson: string }>
    for (const row of rows) {
      try {
        check.decoders[row.name]?.(JSON.parse(row.argsJson))
      } catch (error) {
        throw new Error(`event ${row.seqNumGlobal} no longer fits ${row.name}`, { cause: error })
      }
    }
    check.alsoCheck?.(db)
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

export async function rewriteEventlog(
  directory: string,
  {
    suffix,
    rewrite,
    check,
    beforeVerify,
  }: {
    suffix: string
    rewrite: (db: DatabaseSync) => number | Promise<number>
    check: RewriteCheck
    beforeVerify?: (copy: string) => void | Promise<void>
  },
): Promise<Rewrite> {
  const eventlog = await eventlogFile(directory)
  if (!eventlog) return { kind: 'failed', reason: 'there is no event log' }
  const copy = `${eventlog}.${suffix}`
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
      // The copy is thrown away on any failure, so it needs no rollback journal.
      db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF')
      rewritten = await rewrite(db)
      db.exec('VACUUM')
    } finally {
      db.close()
    }

    await beforeVerify?.(copy)
    verify(copy, eventlog, check)
    await flush(copy)
    const bytesAfter = (await stat(copy)).size
    await rename(copy, eventlog)
    await flush(path.dirname(eventlog)).catch(() => undefined)
    return { kind: 'rewritten', rewritten, bytesBefore, bytesAfter }
  } catch (error) {
    await discard().catch(() => undefined)
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}
