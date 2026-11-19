import { cp, mkdtemp, readdir, readFile, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import type { NewTaskDraft } from '@ted/protocol'
import { afterEach, beforeEach, expect, expectTypeOf, test } from 'vitest'
import { blankReplacedText, replacedTextCount } from '../src/store/blank-replaced.ts'
import type { StoreContext } from '../src/store/context.ts'
import { eventlogFile } from '../src/store/files.ts'
import { openStore } from '../src/store/open.ts'

expectTypeOf<StoreContext>().toHaveProperty('store')

let root: string
let dir: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ted-blank-'))
  dir = path.join(root, 'store')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

interface LogRow extends Record<string, SQLOutputValue> {
  seqNumGlobal: number
  name: string
  argsJson: string
}

const long = (text: string) => `${text} ${'More text. '.repeat(100)}`

async function inEventlog<T>(work: (db: DatabaseSync) => T, folder = dir): Promise<T> {
  const db = new DatabaseSync((await eventlogFile(folder)) as string)
  try {
    return work(db)
  } finally {
    db.close()
  }
}

const loggedEvents = (folder = dir) =>
  inEventlog(
    (db) =>
      db
        .prepare('SELECT seqNumGlobal, name, argsJson FROM eventlog ORDER BY seqNumGlobal')
        .all() as LogRow[],
    folder,
  )

const args = (row: LogRow | undefined) =>
  JSON.parse(row?.argsJson ?? '{}') as Record<string, unknown>

// Opening the store records an observation session, so boundaries from events after the log’s
// last one differ between any two opens.
async function stateTables(folder: string): Promise<Record<string, unknown[]>> {
  const ted = path.dirname((await eventlogFile(folder)) as string)
  const last = await inEventlog(
    (db) =>
      (db.prepare('SELECT MAX(seqNumGlobal) AS last FROM eventlog').get() as { last: number }).last,
    folder,
  )
  for (const file of await readdir(ted)) {
    if (file.startsWith('state')) await rm(path.join(ted, file))
  }
  const store = await openStore({ directory: folder })
  await store.close()
  const states = (await readdir(ted)).filter((f) => f.startsWith('state') && f.endsWith('.db'))
  expect(states).toHaveLength(1)
  const db = new DatabaseSync(path.join(ted, states[0] as string), { readOnly: true })
  try {
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE '\\_\\_livestore%' ESCAPE '\\' ORDER BY name`,
      )
      .all() as { name: string }[]
    return Object.fromEntries(
      tables.map(({ name }) => [
        name,
        name === 'intervalBoundaries'
          ? db
              .prepare('SELECT * FROM intervalBoundaries WHERE sequence < ? ORDER BY rowid')
              .all((last + 1) * 1_000_000)
          : db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
      ]),
    )
  } finally {
    db.close()
  }
}

// Coordinators wrote v1.CoordinatorChanged only when a saved conversation was restored; the
// second restore lands on a row a v2 patch changed, so a blanked first one must still parse.
let oldCoordinatorEvents: [string, unknown][] = []
async function homeWithReplacedText(): Promise<void> {
  const store = await openStore({ directory: dir })
  const factory = store.addFactory({
    key: 'NB',
    name: 'Notebooks',
    repo: 'acme/notes',
    cloneUrl: path.join(root, 'notes.git'),
    defaultBranch: 'main',
  })
  const task = await store.createTask({ title: 'Fix login', factoryId: factory.id })
  for (const id of ['started', 'dropped', 'queued']) {
    store.requestSubAgent({
      id,
      taskId: task.id,
      parentRunId: 'lead',
      name: 'Review',
      agent: 'claude',
      prompt: long(`Review for ${id}.`),
      ownWorktree: false,
    })
  }
  store.startRun({
    id: 'started',
    taskId: task.id,
    agent: 'claude',
    prompt: long('Started sub-agent.'),
    cwd: '/tmp',
    parentRunId: 'lead',
  })
  store.dropSubAgentRequest('dropped')

  const chat = {
    factoryId: factory.id,
    runId: 'run-1',
    runIds: ['run-1'],
    lead: { agent: 'claude' as const },
    phase: 'ready' as const,
    opening: long('Opening prompt.'),
    receipts: [],
    taskIds: [],
  }
  const saved = (id: string, value: typeof chat) => {
    const endedAt = '2026-01-01T00:00:00.000Z'
    const data = { id, startedAt: '2025-12-31T00:00:00.000Z', endedAt, chat: value }
    return { id, factoryId: factory.id, endedAt, data: JSON.stringify(data) }
  }
  const second = { ...chat, runId: 'run-2', runIds: ['run-2'] }
  const patch = (set: Partial<Omit<typeof chat, 'phase'>> & { phase?: string }) => ({
    factoryId: factory.id,
    set: JSON.stringify(set),
    unset: [],
    lists: null,
  })
  oldCoordinatorEvents = [
    ['v2.CoordinatorChanged', patch(chat)],
    ['v1.CoordinatorConversationSaved', saved('conversation-a', chat)],
    ['v2.CoordinatorChanged', patch(second)],
    ['v1.CoordinatorConversationSaved', saved('conversation-b', second)],
    ['v1.CoordinatorConversationContinued', { id: 'conversation-a', factoryId: factory.id }],
    ['v1.CoordinatorChanged', { factoryId: factory.id, data: JSON.stringify(chat) }],
    ['v2.CoordinatorChanged', patch({ phase: 'working' })],
    ['v1.CoordinatorConversationContinued', { id: 'conversation-b', factoryId: factory.id }],
    ['v1.CoordinatorChanged', { factoryId: factory.id, data: JSON.stringify(second) }],
    ['v2.CoordinatorChanged', patch({ phase: 'working' })],
  ]
  for (const [i] of oldCoordinatorEvents.entries())
    store.coordinators.save({ ...chat, id: `placeholder-${i}`, phase: 'ready' })

  const layers = ['library', 'library', 'library', `factory:${factory.id}`, `factory:${factory.id}`]
  for (const [i, layer] of layers.entries()) {
    store.acceptWorkflowLayer(layer, {
      files: { 'workflow.yaml': long(`${layer} version ${i}`) },
      version: '1.0.0',
    })
  }

  for (const title of ['Draft one', 'Draft two', 'Draft three']) {
    store.saveTaskDraft(factory.id, {
      revision: 'r1',
      title,
      description: long(title),
      priority: 'none',
      blockedBy: [],
      attachments: [],
      start: false,
      moreOpen: false,
      dismissed: [],
      filled: {},
    } satisfies NewTaskDraft)
  }
  await store.persisted()
  await store.close()

  await inEventlog((db) => {
    for (const [name, args] of oldCoordinatorEvents)
      db.prepare(
        `UPDATE eventlog SET name = ?, argsJson = ? WHERE seqNumGlobal = (SELECT seqNumGlobal
           FROM eventlog WHERE name = 'v1.CoordinatorChatChanged' ORDER BY seqNumGlobal LIMIT 1)`,
      ).run(name, JSON.stringify(args))
    db.exec(`UPDATE eventlog SET name = 'v1.SubAgentRequested' WHERE name = 'v2.SubAgentRequested'`)
    const start = db
      .prepare(`SELECT argsJson FROM eventlog WHERE name = 'v5.RunStarted'`)
      .get() as { argsJson: string }
    const { promptParts: _, ...rest } = JSON.parse(start.argsJson) as Record<string, unknown>
    db.prepare(`UPDATE eventlog SET name = 'v4.RunStarted', argsJson = ? WHERE argsJson = ?`).run(
      JSON.stringify({ ...rest, prompt: long('Started sub-agent.') }),
      start.argsJson,
    )
  })
}

test('blanking replaced text keeps the state a rebuild makes, and keeps the last event of each kind whole', async () => {
  await homeWithReplacedText()
  const before = await loggedEvents()
  const count = (name: string) => before.filter((e) => e.name === name).length
  expect(count('v1.SubAgentRequested')).toBe(3)
  expect(count('v4.RunStarted')).toBe(1)
  expect(count('v1.CoordinatorChanged')).toBe(2)
  expect(count('v1.WorkflowLayerAccepted')).toBe(5)
  expect(count('v2.TaskDraftSaved')).toBe(3)
  const original = path.join(root, 'original')
  await cp(dir, original, { recursive: true })

  const expected = 2 + 1 + 3 + 2
  expect(await replacedTextCount(dir)).toBe(expected)
  const result = await blankReplacedText(dir)
  expect(result).toMatchObject({ kind: 'blanked', blanked: expected })
  if (result.kind !== 'blanked') throw new Error(result.reason)
  expect(result.bytesAfter).toBeLessThan(result.bytesBefore)
  expect(await replacedTextCount(dir)).toBe(0)
  expect(
    (await readdir(path.dirname((await eventlogFile(dir)) as string))).filter((f) =>
      f.includes('blanking'),
    ),
  ).toEqual([])

  const after = await loggedEvents()
  expect(after.map((e) => [e.seqNumGlobal, e.name])).toEqual(
    before.map((e) => [e.seqNumGlobal, e.name]),
  )
  const changed = after.filter((e, i) => e.argsJson !== before[i]?.argsJson)
  expect(changed).toHaveLength(expected)
  const requests = after.filter((e) => e.name === 'v1.SubAgentRequested')
  expect(requests.map((e) => [args(e).id, args(e).prompt === ''])).toEqual([
    ['started', true],
    ['dropped', true],
    ['queued', false],
  ])
  const last = (name: string, by: string) => {
    const seen = new Map<unknown, LogRow>()
    for (const event of after.filter((e) => e.name === name)) seen.set(args(event)[by], event)
    return [...seen.values()]
  }
  for (const [name, by, field] of [
    ['v1.CoordinatorChanged', 'factoryId', 'data'],
    ['v1.WorkflowLayerAccepted', 'layer', 'files'],
    ['v2.TaskDraftSaved', 'factoryId', 'draft'],
  ] as const) {
    const kept = last(name, by)
    for (const event of kept) {
      expect(event.argsJson).toBe(
        before.find((e) => e.seqNumGlobal === event.seqNumGlobal)?.argsJson,
      )
    }
    for (const event of after.filter((e) => e.name === name && !kept.includes(e))) {
      const blanked = args(event)
      const was = args(before.find((e) => e.seqNumGlobal === event.seqNumGlobal))
      expect(blanked[field]).toBe('{}')
      expect({ ...blanked, [field]: null }).toEqual({ ...was, [field]: null })
    }
  }

  expect(await stateTables(dir)).toEqual(await stateTables(original))
})

test('a copy that fails a check is thrown away and the event log stays exactly as it was', async () => {
  await homeWithReplacedText()
  const eventlog = (await eventlogFile(dir)) as string
  const bytes = await readFile(eventlog)
  const tampering: [string, string][] = [
    [
      `UPDATE eventlog SET argsJson = replace(argsJson, 'Fix login', 'Fix logins')`,
      'an event other than the four blanked kinds changed',
    ],
    [
      `UPDATE eventlog SET argsJson = json_set(argsJson, '$.prompt', '')
       WHERE name = 'v1.SubAgentRequested' AND json_extract(argsJson, '$.id') = 'queued'`,
      'was blanked, but no later event replaces its text',
    ],
    [
      `UPDATE eventlog SET argsJson = json_set(argsJson, '$.name', 'Renamed')
       WHERE name = 'v1.SubAgentRequested' AND json_extract(argsJson, '$.id') = 'started'`,
      'a blanked event changed in more than its replaced text',
    ],
  ]
  for (const [sql, reason] of tampering) {
    const result = await blankReplacedText(dir, {
      beforeVerify(copy) {
        const db = new DatabaseSync(copy)
        db.exec(sql)
        db.close()
      },
    })
    expect(result).toMatchObject({ kind: 'failed' })
    expect(result.kind === 'failed' && result.reason).toContain(reason)
    expect((await readFile(eventlog)).equals(bytes)).toBe(true)
    expect((await readdir(path.dirname(eventlog))).filter((f) => f.includes('blanking'))).toEqual(
      [],
    )
  }

  const elsewhere = path.join(root, 'elsewhere')
  await rename(path.dirname(eventlog), elsewhere)
  await symlink(elsewhere, path.dirname(eventlog))
  const linked = await blankReplacedText(dir)
  expect(linked).toMatchObject({ kind: 'failed' })
  expect(linked.kind === 'failed' && linked.reason).toContain('isn’t a plain folder')
  expect((await readFile(path.join(elsewhere, path.basename(eventlog)))).equals(bytes)).toBe(true)
  expect((await readdir(elsewhere)).filter((f) => f.includes('blanking'))).toEqual([])
})
