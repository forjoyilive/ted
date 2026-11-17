import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { type ConversationEntry, readDaemonInfo } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  assistantTexts,
  killRunHosts,
  makeTempHome,
  spawnDaemonProcess,
  storeDbFiles,
  stubClaudePath,
  testAppToken,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let cwd: string
let daemon: RunningDaemon | undefined
let child: ChildProcess | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  cwd = await mkdtemp(path.join(tmpdir(), 'ted-run-output-'))
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  if (child && child.exitCode === null) {
    child.kill('SIGKILL')
    await once(child, 'exit')
  }
  child = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(cwd, { recursive: true, force: true })
})

async function start() {
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  return api(daemon.port, { appKey: daemon.appToken })
}

async function stop() {
  await daemon?.stop()
  daemon = undefined
}

const logFile = (runId: string) => path.join(home, 'runs', runId, 'host.log')

async function entriesInLog(runId: string): Promise<ConversationEntry[]> {
  const log = await readFile(logFile(runId))
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

async function eventlog<T>(read: (db: DatabaseSync) => T): Promise<T> {
  const dir = path.join(home, 'store', 'ted')
  const file = (await storeDbFiles(dir)).find((f) => f.startsWith('eventlog'))
  if (!file) throw new Error('no event log')
  const db = new DatabaseSync(path.join(dir, file))
  try {
    return read(db)
  } finally {
    db.close()
  }
}

const outputEvents = () =>
  eventlog(
    (db) =>
      db
        .prepare(
          `SELECT name, COUNT(*) AS count, SUM(LENGTH(argsJson)) AS bytes FROM eventlog
           WHERE name LIKE '%.RunOutputRead' GROUP BY name`,
        )
        .all() as { name: string; count: number; bytes: number }[],
  )

async function idle(client: Awaited<ReturnType<typeof start>>, runId: string) {
  return waitUntil(
    async () => {
      const r = await client.getRun(runId)
      return r.run.state === 'idle' ? r : undefined
    },
    'the Run to go idle',
    60_000,
  )
}

async function stopRun(client: Awaited<ReturnType<typeof start>>, runId: string) {
  expect((await client.call('POST', `/runs/${runId}/stop`)).status).toBe(200)
  await waitUntil(
    async () => (await client.getRun(runId)).run.state === 'finished' || undefined,
    'the Run to finish',
  )
}

test('thousands of output lines reach the Conversation from host.log and never enter the event log', async () => {
  const client = await start()
  const lines = 3000
  const run = await client.startRun([{ lines, everyMs: 0, pad: 200 }, { endTurn: true }], cwd)

  const done = await idle(client, run.id)

  expect(assistantTexts(done.conversation)).toEqual(
    Array.from({ length: lines }, (_, i) => `line ${i + 1}${'x'.repeat(200)}`),
  )
  expect(done.conversation).toEqual(await entriesInLog(run.id))
  const chat = await client.call('GET', `/runs/${run.id}/chat`)
  expect(chat.status).toBe(200)

  await stop()
  const logBytes = (await stat(logFile(run.id))).size
  expect(logBytes).toBeGreaterThan(lines * 200)
  const saved = await outputEvents()
  expect(saved.map((e) => e.name)).toEqual(['v3.RunOutputRead'])
  expect(saved[0]?.count).toBeLessThan(10)
  expect(saved[0]?.bytes).toBeLessThan(logBytes / 20)
  const total = await eventlog(
    (db) =>
      (db.prepare('SELECT SUM(LENGTH(argsJson)) AS bytes FROM eventlog').get() as { bytes: number })
        .bytes,
  )
  expect(total).toBeLessThan(logBytes / 10)
})

test('a Run whose host.log is gone still answers, with no Conversation', async () => {
  const client = await start()
  const run = await client.startRun([{ say: 'hello' }, { endTurn: true }], cwd)
  await idle(client, run.id)
  await stopRun(client, run.id)

  await rm(path.join(home, 'runs', run.id), { recursive: true, force: true })

  const gone = await client.call('GET', `/runs/${run.id}`)
  expect(gone.status).toBe(200)
  expect(gone.body.conversation).toEqual([])
  const chat = await client.call('GET', `/runs/${run.id}/chat`)
  expect(chat.status).toBe(200)
  expect(chat.body.items).toContainEqual({
    kind: 'ted',
    id: 'output-not-kept',
    title: 'Output no longer kept',
    text: 'Ted no longer keeps this Run’s output, so its messages and tool calls can’t be shown.',
  })
})

test('lines an older Ted saved as v2.RunOutputRead stay out of the state database, and the Conversation comes from host.log', async () => {
  let client = await start()
  const run = await client.startRun([{ say: 'hello' }, { say: 'world' }, { endTurn: true }], cwd)
  await idle(client, run.id)
  await stopRun(client, run.id)
  const entries = await entriesInLog(run.id)
  const toOffset = (await stat(logFile(run.id))).size
  await stop()

  await eventlog((db) => {
    const last = db
      .prepare(`SELECT MAX(seqNumGlobal) AS seq FROM eventlog WHERE name = 'v3.RunOutputRead'`)
      .get() as { seq: number }
    db.prepare(
      `UPDATE eventlog SET name = 'v2.RunOutputRead', argsJson = ? WHERE seqNumGlobal = ?`,
    ).run(JSON.stringify({ runId: run.id, toOffset, entries }), last.seq)
  })
  const dir = path.join(home, 'store', 'ted')
  for (const file of await readdir(dir)) {
    if (file.startsWith('state')) await rm(path.join(dir, file))
  }

  client = await start()
  const old = await client.getRun(run.id)
  expect(old.conversation).toEqual(entries)
  expect(assistantTexts(old.conversation)).toEqual(['hello', 'world'])
  await stop()
  const states = (await storeDbFiles(dir)).filter((f) => f.startsWith('state'))
  expect(states).toHaveLength(1)
  const state = new DatabaseSync(path.join(dir, states[0] as string), { readOnly: true })
  try {
    const tables = state.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()
    expect(tables.map((t) => t.name)).not.toContain('conversationEntries')
    const row = state.prepare('SELECT readOffset FROM runs WHERE id = ?').get(run.id)
    expect(row?.readOffset).toBe(toOffset)
  } finally {
    state.close()
  }

  await rm(path.join(home, 'runs', run.id), { recursive: true, force: true })
  client = await start()
  expect((await client.getRun(run.id)).conversation).toEqual([])
})

test('a finished Run whose host.log was cut to its tail answers with the tail', async () => {
  const client = await start()
  const run = await client.startRun([{ lines: 50, everyMs: 0 }, { endTurn: true }], cwd)
  await idle(client, run.id)
  await stopRun(client, run.id)
  const whole = (await client.getRun(run.id)).conversation
  const kept = whole.slice(-20)

  const log = await readFile(logFile(run.id))
  await writeFile(logFile(run.id), log.subarray(kept[0]?.offset))

  expect((await client.getRun(run.id)).conversation).toEqual(kept)
  const chat = await client.call('GET', `/runs/${run.id}/chat`)
  expect(
    (chat.body.items as { id: string; title?: string }[]).find((i) => i.id === 'output-not-kept')
      ?.title,
  ).toBe('Earlier output no longer kept')

  const shorter = whole.slice(-5)
  await writeFile(logFile(run.id), log.subarray(shorter[0]?.offset))
  expect((await client.getRun(run.id)).conversation).toEqual(shorter)
})

test('killing the daemon mid-Run neither loses a line nor repeats one', async () => {
  const startProcess = async () => {
    await rm(path.join(home, 'daemon.json'), { force: true })
    child = spawnDaemonProcess([], {
      ...process.env,
      TED_HOME: home,
      TED_CLAUDE_BIN: stubClaudePath,
    })
    const info = await waitUntil(() => readDaemonInfo(home), 'daemon.json')
    return api(info.port, { appKey: testAppToken })
  }
  let client = await startProcess()
  const lines = 400
  const run = await client.startRun([{ lines, everyMs: 5 }, { endTurn: true }], cwd)
  await waitUntil(
    async () => (await client.getRun(run.id)).conversation.length >= 50 || undefined,
    'some output',
  )

  const killed = child
  killed?.kill('SIGKILL')
  if (killed) await once(killed, 'exit')
  const held = JSON.parse(
    await readFile(path.join(home, 'runs', run.id, 'read-offset.json'), 'utf8'),
  ) as { toOffset: number }
  expect(held.toOffset).toBeGreaterThan(0)
  await sleep(500)
  client = await startProcess()

  const done = await idle(client, run.id)
  expect(assistantTexts(done.conversation)).toEqual(
    Array.from({ length: lines }, (_, i) => `line ${i + 1}`),
  )
  expect(done.conversation).toEqual(await entriesInLog(run.id))
  const saved = await outputEvents()
  expect(saved.map((e) => e.name)).toEqual(['v3.RunOutputRead'])
  expect(saved[0]?.count).toBeLessThan(10)
})
