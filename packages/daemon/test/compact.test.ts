import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BackupsSummary, Comment, ConversationEntry, DataStatus, Task } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type DaemonOptions, type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  killRunHosts,
  makeTempHome,
  pretendStateSchemaChanged,
  storeDbFiles,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let cwd: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  cwd = await mkdtemp(path.join(tmpdir(), 'ted-compact-'))
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(cwd, { recursive: true, force: true })
})

type Client = ReturnType<typeof api>

async function start(
  version: string,
  statuses: DataStatus[] = [],
  compaction?: DaemonOptions['compaction'],
): Promise<Client> {
  daemon = await startDaemon({
    home,
    version,
    claudeBin: stubClaudePath,
    onDataStatus: (status) => statuses.push(status),
    ...(compaction && { compaction }),
  })
  return api(daemon.port, { appKey: daemon.appToken })
}

async function stop(): Promise<void> {
  await daemon?.stop()
  daemon = undefined
}

const storeDir = () => path.join(home, 'store', 'ted')
const metaFile = () => path.join(home, 'store', 'ted-store.json')

async function eventlogPath(dir = storeDir()): Promise<string> {
  const file = (await storeDbFiles(dir)).find((f) => f.startsWith('eventlog'))
  if (!file) throw new Error('no event log')
  return path.join(dir, file)
}

async function inEventlog<T>(work: (db: DatabaseSync) => T, dir = storeDir()): Promise<T> {
  const db = new DatabaseSync(await eventlogPath(dir))
  try {
    return work(db)
  } finally {
    db.close()
  }
}

const eventlogBytes = async () => (await stat(await eventlogPath())).size

interface LogRow {
  seqNumGlobal: number
  name: string
  argsJson: string
}

const loggedEvents = (dir?: string) =>
  inEventlog(
    (db) => db.prepare('SELECT * FROM eventlog ORDER BY seqNumGlobal').all() as unknown as LogRow[],
    dir,
  )

const isOldOutput = (row: LogRow) =>
  row.name === 'v1.RunOutputRead' || row.name === 'v2.RunOutputRead'

async function expectUnchangedEvents(before: LogRow[]): Promise<void> {
  const after = await loggedEvents()
  expect(after.slice(0, before.length)).toEqual(before)
  expect(
    after
      .slice(before.length)
      .every((event) =>
        [
          'v1.IntervalObservationStarted',
          'v1.IntervalObservationEnded',
          'v1.TaskWaitObserved',
        ].includes(event.name),
      ),
  ).toBe(true)
}

async function runRows(): Promise<unknown[]> {
  const states = (await storeDbFiles(storeDir())).filter((f) => f.startsWith('state'))
  expect(states).toHaveLength(1)
  const db = new DatabaseSync(path.join(storeDir(), states[0] as string), { readOnly: true })
  try {
    return db.prepare('SELECT id, readOffset, lastOutputAt, state FROM runs ORDER BY id').all()
  } finally {
    db.close()
  }
}

async function entriesInLog(runId: string): Promise<ConversationEntry[]> {
  const log = await readFile(path.join(home, 'runs', runId, 'host.log'))
  const entries: ConversationEntry[] = []
  for (let pos = 0; pos < log.length; ) {
    const end = log.indexOf(10, pos)
    const record = JSON.parse(log.toString('utf8', pos, end)) as {
      t: string
      line: string
      at: string
    }
    if (record.t === 'out') entries.push({ offset: pos, line: record.line, at: record.at })
    pos = end + 1
  }
  return entries
}

async function finishedRun(client: Client, steps: unknown[]): Promise<string> {
  const run = await client.startRun(steps, cwd)
  await waitUntil(
    async () => (await client.getRun(run.id)).run.state === 'idle' || undefined,
    'the Run to go idle',
    60_000,
  )
  expect((await client.call('POST', `/runs/${run.id}/stop`)).status).toBe(200)
  await waitUntil(
    async () => (await client.getRun(run.id)).run.state === 'finished' || undefined,
    'the Run to finish',
  )
  return run.id
}

async function turnOutputIntoOldEvents(runId: string, version: 'v1' | 'v2'): Promise<void> {
  const entries = await entriesInLog(runId)
  await inEventlog((db) => {
    const rows = db
      .prepare(
        `SELECT seqNumGlobal, argsJson FROM eventlog
         WHERE name = 'v3.RunOutputRead' AND json_extract(argsJson, '$.runId') = ?
         ORDER BY seqNumGlobal`,
      )
      .all(runId) as { seqNumGlobal: number; argsJson: string }[]
    const update = db.prepare('UPDATE eventlog SET name = ?, argsJson = ? WHERE seqNumGlobal = ?')
    let from = 0
    for (const row of rows) {
      const { toOffset } = JSON.parse(row.argsJson) as { toOffset: number }
      const read = entries
        .filter((e) => e.offset >= from && e.offset < toOffset)
        .map((e) => (version === 'v1' ? { offset: e.offset, line: e.line } : e))
      update.run(
        `${version}.RunOutputRead`,
        JSON.stringify({ runId, toOffset, entries: read }),
        row.seqNumGlobal,
      )
      from = toOffset
    }
  })
}

const forgetCompaction = async () => {
  const meta = JSON.parse(await readFile(metaFile(), 'utf8')) as Record<string, unknown>
  delete meta.outputCompaction
  await writeFile(metaFile(), JSON.stringify(meta))
}

const compactionMarker = async () =>
  (JSON.parse(await readFile(metaFile(), 'utf8')) as { outputCompaction?: Record<string, unknown> })
    .outputCompaction

const preUpdateBackups = async (client: Client) =>
  ((await client.call('GET', '/backups')).body as BackupsSummary).backups.filter(
    (b) => b.kind === 'pre-update',
  )

interface Snapshot {
  tasks: Task[]
  comments: Comment[]
  conversations: ConversationEntry[][]
}

async function snapshot(client: Client, runIds: string[]): Promise<Snapshot> {
  const tasks = (await client.call('GET', '/tasks')).body as Task[]
  const comments: Comment[] = []
  for (const task of tasks) {
    comments.push(...((await client.call('GET', `/tasks/${task.id}/comments`)).body as Comment[]))
  }
  const conversations = []
  for (const id of runIds) conversations.push((await client.getRun(id)).conversation)
  return { tasks, comments, conversations }
}

const padding = 'x'.repeat(200)

async function homeFromAnOlderTed(): Promise<{
  runIds: string[]
  before: Snapshot
  runsBefore: unknown[]
}> {
  let client = await start('1.0.0')
  const task = (await client.call('POST', '/tasks', { title: 'Fix login' })).body as Task
  await client.call('POST', '/tasks', { title: 'Add dark mode' })
  const posted = await client.call('POST', `/tasks/${task.id}/comments`, { body: 'Use the cookie' })
  expect(posted.status).toBe(201)
  const first = await finishedRun(client, [{ lines: 300, everyMs: 0, pad: 200 }, { endTurn: true }])
  const second = await finishedRun(client, [{ say: 'hello' }, { say: 'world' }, { endTurn: true }])
  const runIds = [first, second]
  await stop()
  await turnOutputIntoOldEvents(first, 'v2')
  await turnOutputIntoOldEvents(second, 'v1')

  await pretendStateSchemaChanged(home)
  client = await start('1.0.0')
  const before = await snapshot(client, runIds)
  expect(before.comments.map((c) => c.body)).toContain('Use the cookie')
  expect(before.conversations[0]).toHaveLength((await entriesInLog(first)).length)
  await stop()
  const runsBefore = await runRows()
  await forgetCompaction()
  return { runIds, before, runsBefore }
}

test('the first open by a new version backs the store up, then drops the lines from old Run output events and nothing else', async () => {
  const { runIds, before, runsBefore } = await homeFromAnOlderTed()
  const eventsBefore = await loggedEvents()
  const bytesBefore = await eventlogBytes()
  const oldOutput = eventsBefore.filter(isOldOutput)
  expect(oldOutput.map((e) => e.name)).toContain('v1.RunOutputRead')
  expect(oldOutput.map((e) => e.name)).toContain('v2.RunOutputRead')
  expect(oldOutput.some((e) => e.argsJson.includes(padding))).toBe(true)

  await writeFile(`${await eventlogPath()}.compacting`, 'left by a killed TED')

  const statuses: DataStatus[] = []
  let compactedBytes = 0
  let client = await start('1.1.0', statuses, {
    async beforeVerify(copy) {
      compactedBytes = (await stat(copy)).size
    },
  })

  expect(statuses.at(-1)).toEqual({ state: 'ready' })
  const updates = statuses.filter((s) => s.state === 'updating')
  expect(updates.at(-1)).toMatchObject({ done: eventsBefore.length, total: eventsBefore.length })
  expect(await snapshot(client, runIds)).toEqual(before)
  const backups = await preUpdateBackups(client)
  expect(backups[0]).toMatchObject({ takenBy: '1.1.0', dataFrom: '1.0.0' })
  const backedUp = await loggedEvents(
    path.join(home, 'backups', backups[0]?.name ?? '', 'store', 'ted'),
  )
  expect(backedUp).toEqual(eventsBefore)
  await stop()

  const eventsAfter = await loggedEvents()
  expect(await eventlogBytes()).toBeLessThan(bytesBefore / 2)
  const compactedEvents = eventsAfter.slice(0, eventsBefore.length)
  await expectUnchangedEvents(compactedEvents)
  expect(compactedEvents.map((e) => [e.seqNumGlobal, e.name])).toEqual(
    eventsBefore.map((e) => [e.seqNumGlobal, e.name]),
  )
  expect(compactedEvents.filter((e) => !isOldOutput(e))).toEqual(
    eventsBefore.filter((e) => !isOldOutput(e)),
  )
  for (const event of eventsAfter.filter(isOldOutput)) {
    const args = JSON.parse(event.argsJson) as { entries: { line: string }[] }
    expect(args.entries.length).toBeLessThanOrEqual(event.name === 'v1.RunOutputRead' ? 0 : 1)
    expect(args.entries.every((entry) => entry.line === '')).toBe(true)
  }
  expect((await readFile(await eventlogPath())).includes(padding)).toBe(false)
  expect(await runRows()).toEqual(runsBefore)
  expect(await compactionMarker()).toMatchObject({
    state: 'done',
    by: '1.1.0',
    rewritten: oldOutput.filter((e) => e.argsJson.includes('"line"')).length,
    bytesBefore,
    bytesAfter: compactedBytes,
  })
  expect((await readdir(storeDir())).filter((f) => f.includes('compacting'))).toEqual([])

  const compacted = await loggedEvents()
  const again: DataStatus[] = []
  client = await start('1.1.0', again)
  expect(again.some((s) => s.state === 'updating')).toBe(false)
  expect(await preUpdateBackups(client)).toHaveLength(backups.length)
  await stop()
  await expectUnchangedEvents(compacted)

  await pretendStateSchemaChanged(home)
  client = await start('1.2.0')
  expect(await snapshot(client, runIds)).toEqual(before)
  await stop()
  expect(await runRows()).toEqual(runsBefore)
})

test('an open that also rebuilds state takes one backup, compacts, then rebuilds the same state', async () => {
  const { runIds, before, runsBefore } = await homeFromAnOlderTed()
  const bytesBefore = await eventlogBytes()
  await pretendStateSchemaChanged(home)

  const statuses: DataStatus[] = []
  const client = await start('1.1.0', statuses)

  expect(statuses.at(-1)).toEqual({ state: 'ready' })
  expect(await snapshot(client, runIds)).toEqual(before)
  const backups = await preUpdateBackups(client)
  expect(backups.filter((b) => b.takenBy === '1.1.0')).toHaveLength(1)
  await stop()
  expect(await eventlogBytes()).toBeLessThan(bytesBefore / 2)
  expect(await runRows()).toEqual(runsBefore)
  expect(await compactionMarker()).toMatchObject({ state: 'done', by: '1.1.0' })
})

test('a copy that fails verification is thrown away: the event log stays as it was and the store opens', async () => {
  const { runIds, before, runsBefore } = await homeFromAnOlderTed()
  const original = await loggedEvents()
  const tamper = (copy: string) => {
    const db = new DatabaseSync(copy)
    db.exec(`UPDATE eventlog SET argsJson = replace(argsJson, 'Fix login', 'Fix logins')`)
    db.close()
  }

  const statuses: DataStatus[] = []
  let client = await start('1.1.0', statuses, { beforeVerify: tamper })

  expect(statuses.at(-1)).toEqual({ state: 'ready' })
  expect(await snapshot(client, runIds)).toEqual(before)
  const backups = await preUpdateBackups(client)
  expect(backups[0]).toMatchObject({ takenBy: '1.1.0', dataFrom: '1.0.0' })
  await stop()
  await expectUnchangedEvents(original)
  expect((await readdir(storeDir())).filter((f) => f.includes('compacting'))).toEqual([])
  expect(await compactionMarker()).toMatchObject({
    state: 'failed',
    by: '1.1.0',
    reason: 'an event other than old Run output changed',
  })
  expect(await runRows()).toEqual(runsBefore)

  client = await start('1.1.0')
  expect(await preUpdateBackups(client)).toHaveLength(backups.length)
  await stop()
  await expectUnchangedEvents(original)

  client = await start('1.2.0')
  expect(await snapshot(client, runIds)).toEqual(before)
  await stop()
  expect(await compactionMarker()).toMatchObject({ state: 'done', by: '1.2.0' })
  expect((await loggedEvents()).slice(0, original.length)).not.toEqual(original)
})

test('without a backup the event log isn’t compacted, and the store opens', async () => {
  const { runIds, before } = await homeFromAnOlderTed()
  const eventsBefore = await loggedEvents()
  await rm(path.join(home, 'backups'), { recursive: true, force: true })
  await writeFile(path.join(home, 'backups'), 'not a folder')

  const statuses: DataStatus[] = []
  const client = await start('1.1.0', statuses)

  expect(statuses.at(-1)).toEqual({ state: 'ready' })
  expect(await snapshot(client, runIds)).toEqual(before)
  await stop()
  expect((await loggedEvents()).slice(0, eventsBefore.length)).toEqual(eventsBefore)
  expect(await compactionMarker()).toBeUndefined()
})
