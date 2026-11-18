import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { Schema } from '@livestore/livestore'
import { eventlogFile } from './files.ts'
import { eventKey, nameList, rewriteEventlog, withDb } from './rewrite-eventlog.ts'
import { events } from './schema.ts'

export type Blanking =
  | { kind: 'blanked'; blanked: number; bytesBefore: number; bytesAfter: number }
  | { kind: 'failed'; reason: string }

export interface BlankOptions {
  beforeVerify?: (copy: string) => void | Promise<void>
}

// Each kind’s text field, what it becomes, and the field that matches it to the later
// event replacing it.
// The three JSON fields become `{}` because a `v2.CoordinatorChanged` between two
// `v1.CoordinatorChanged` events parses the row.
const kinds = {
  [events.subAgentRequested.name]: {
    field: 'prompt',
    blank: '',
    by: 'id',
  },
  [events.coordinatorChanged.name]: {
    field: 'data',
    blank: '{}',
    by: 'factoryId',
  },
  [events.workflowLayerAccepted.name]: {
    field: 'files',
    blank: '{}',
    by: 'layer',
  },
  [events.taskDraftSavedV2.name]: {
    field: 'draft',
    blank: '{}',
    by: 'factoryId',
  },
} as const

const request = events.subAgentRequested.name
const requestEnds: string[] = [events.runStartedV4.name, events.subAgentRequestDropped.name]
const blankable = Object.keys(kinds)

type Row = {
  g: number
  c: number
  r: number
  name: string
  grp: SQLOutputValue
  blank: number
}

const keyOf = (row: Pick<Row, 'g' | 'c' | 'r'>) => `${row.g}:${row.c}:${row.r}`
const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`

function planBlanks(db: DatabaseSync, schema = 'main'): Row[] {
  const groups = [
    ...Object.entries(kinds).map(([name, kind]) => [name, kind.by] as const),
    ...requestEnds.map((name) => [name, 'id'] as const),
  ]
  const blanks = Object.entries(kinds)
    .map(
      ([name, kind]) =>
        `WHEN ${quoted(name)} THEN json_extract(argsJson, '$.${kind.field}') = ${quoted(kind.blank)}`,
    )
    .join(' ')
  // SAFETY: the SELECT returns exactly Row's columns: g, c, r and blank are integers, name is text.
  const rows = db
    .prepare(
      `SELECT seqNumGlobal AS g, seqNumClient AS c, seqNumRebaseGeneration AS r, name,
         CASE name ${groups.map(([name, by]) => `WHEN ${quoted(name)} THEN json_extract(argsJson, '$.${by}')`).join(' ')} END AS grp,
         CASE name ${blanks} ELSE 0 END AS blank
       FROM ${schema}.eventlog
       WHERE name IN ${nameList([...blankable, ...requestEnds])} AND json_valid(argsJson)
       ORDER BY seqNumGlobal DESC, seqNumClient DESC, seqNumRebaseGeneration DESC`,
    )
    .all() as Row[]

  const planned: Row[] = []
  const later = new Set<string>()
  const ended = new Set<string>()
  for (const row of rows) {
    if (typeof row.grp !== 'string') continue
    if (requestEnds.includes(row.name)) {
      ended.add(row.grp)
    } else if (row.name === request) {
      if (ended.has(row.grp) && !row.blank) planned.push(row)
    } else {
      const group = `${row.name}\0${row.grp}`
      if (!later.has(group)) later.add(group)
      else if (!row.blank) planned.push(row)
    }
  }
  return planned
}

export async function replacedTextCount(directory: string): Promise<number> {
  const eventlog = await eventlogFile(directory)
  if (!eventlog) return 0
  return withDb(eventlog, true, (db) => planBlanks(db).length)
}

const extract = (alias: string, field: string) => `json_extract(${alias}.argsJson, '$.${field}')`

const keptValues = `CASE o.name ${Object.entries(kinds)
  .map(
    ([name, { field, blank }]) =>
      `WHEN ${quoted(name)} THEN json_remove(o.argsJson, '$.${field}') = json_remove(c.argsJson, '$.${field}')
        AND (${extract('c', field)} IS ${extract('o', field)} OR ${extract('c', field)} = ${quoted(blank)})`,
  )
  .join(' ')} ELSE 0 END`

function blankedOnlyReplaced(db: DatabaseSync): void {
  const planned = new Set(planBlanks(db, 'original').map(keyOf))
  // SAFETY: the SELECT returns only g, c and r, the integer sequence columns of the eventlog.
  const changed = db
    .prepare(
      `SELECT o.seqNumGlobal AS g, o.seqNumClient AS c, o.seqNumRebaseGeneration AS r
       FROM original.eventlog o JOIN main.eventlog c
         ON ${eventKey.map((column) => `o."${column}" = c."${column}"`).join(' AND ')}
       WHERE o.argsJson IS NOT c.argsJson`,
    )
    .all() as Pick<Row, 'g' | 'c' | 'r'>[]
  for (const row of changed) {
    if (!planned.has(keyOf(row))) {
      throw new Error(`event ${row.g} was blanked, but no later event replaces its text`)
    }
  }
}

const check = {
  names: blankable,
  othersChanged: 'an event other than the four blanked kinds changed',
  keptValues,
  lostValues: 'a blanked event changed in more than its replaced text',
  decoders: {
    [events.subAgentRequested.name]: Schema.decodeUnknownSync(events.subAgentRequested.schema),
    [events.coordinatorChanged.name]: Schema.decodeUnknownSync(events.coordinatorChanged.schema),
    [events.workflowLayerAccepted.name]: Schema.decodeUnknownSync(
      events.workflowLayerAccepted.schema,
    ),
    [events.taskDraftSavedV2.name]: Schema.decodeUnknownSync(events.taskDraftSavedV2.schema),
  },
  alsoCheck: blankedOnlyReplaced,
}

export async function blankReplacedText(
  directory: string,
  options: BlankOptions = {},
): Promise<Blanking> {
  const result = await rewriteEventlog(directory, {
    suffix: 'blanking',
    check,
    ...(options.beforeVerify && { beforeVerify: options.beforeVerify }),
    rewrite(db) {
      const update = db.prepare(
        `UPDATE eventlog SET argsJson = json_set(argsJson, ?, ?)
         WHERE seqNumGlobal = ? AND seqNumClient = ? AND seqNumRebaseGeneration = ?`,
      )
      const planned = planBlanks(db)
      db.exec('BEGIN')
      for (const row of planned) {
        const { field, blank } = kinds[row.name as keyof typeof kinds]
        update.run(`$.${field}`, blank, row.g, row.c, row.r)
      }
      db.exec('COMMIT')
      return planned.length
    },
  })
  if (result.kind === 'failed') return result
  const { rewritten, bytesBefore, bytesAfter } = result
  return { kind: 'blanked', blanked: rewritten, bytesBefore, bytesAfter }
}
