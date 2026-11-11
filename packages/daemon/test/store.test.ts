import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { agentStageIds, type DaemonEvent } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { eventlogFile } from '../src/store/files.ts'
import { openStore } from '../src/store/index.ts'
import { events } from '../src/store/schema.ts'

let dir: string
const repo = { name: 'widgets', repo: 'acme/widgets', copied: [], skipped: [] }
const agentStages = [...agentStageIds]

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-store-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('TedStore', () => {
  test('creates Tasks with a stable ID and numbered display IDs', async () => {
    const store = await openStore({ directory: dir })
    try {
      const first = await store.createTask({ title: 'Fix login' })
      const second = await store.createTask({ title: 'Add dark mode' })

      expect(first.displayId).toBe('DEV-1')
      expect(second.displayId).toBe('DEV-2')
      expect(first.id).not.toBe(second.id)
      expect(store.getTask(first.displayId)).toEqual(store.getTask(first.id))
      expect(store.getTask(second.displayId)).toEqual(store.getTask(second.id))
      expect(store.getTask('DEV-01')).toBeUndefined()
      expect(store.getTask('dev-1')).toBeUndefined()
      expect(store.getTask('DEV-999')).toBeUndefined()
      expect(store.listTasks().map((t) => [t.displayId, t.title])).toEqual([
        ['DEV-1', 'Fix login'],
        ['DEV-2', 'Add dark mode'],
      ])
      const factory = store.addFactory({
        key: 'NB',
        name: 'Notebooks',
        repo: 'acme/notes',
        cloneUrl: path.join(dir, 'notes.git'),
        defaultBranch: 'main',
      })
      const other = await store.createTask({ title: 'Add export', factoryId: factory.id })
      expect(other.displayId).toBe('NB-1')
      expect(store.getTask('NB-1')).toEqual(store.getTask(other.id))
      expect(store.getTask('DEV-1')).toEqual(store.getTask(first.id))
    } finally {
      await store.close()
    }
  })

  test('a write is in the event log on disk once persisted() resolves', async () => {
    const store = await openStore({ directory: dir })
    try {
      const file = (await eventlogFile(dir)) as string
      const savedEvents = () => {
        const db = new DatabaseSync(file, { readOnly: true })
        try {
          return (db.prepare('SELECT COUNT(*) AS count FROM eventlog').get() as { count: number })
            .count
        } finally {
          db.close()
        }
      }
      const before = savedEvents()

      await store.createTask({ title: 'Fix login' })
      await store.persisted()

      expect(savedEvents()).toBeGreaterThan(before)
    } finally {
      await store.close()
    }
  })

  test('keeps Tasks after the store is closed and reopened', async () => {
    const first = await openStore({ directory: dir })
    const created = await first.createTask({ title: 'Fix login' })
    await first.close()

    const second = await openStore({ directory: dir })
    try {
      expect(second.listTasks()).toEqual([created])
      expect((await second.createTask({ title: 'Next' })).displayId).toBe('DEV-2')
    } finally {
      await second.close()
    }
  })

  test('rebuilds state from the event log', async () => {
    const first = await openStore({ directory: dir })
    const a = await first.createTask({ title: 'Fix login' })
    const b = await first.createTask({ title: 'Add dark mode' })
    await first.close()

    const storeFiles = await readdir(path.join(dir, 'ted'))
    const stateFiles = storeFiles.filter((f) => f.startsWith('state'))
    expect(stateFiles).not.toHaveLength(0)
    for (const f of stateFiles) await rm(path.join(dir, 'ted', f), { force: true })

    const second = await openStore({ directory: dir })
    try {
      expect(second.listTasks()).toEqual([a, b])
    } finally {
      await second.close()
    }
  })

  test('records a Run with its session ID, Conversation, read offset and state', async () => {
    const first = await openStore({ directory: dir })
    const run = first.startRun({
      id: 'run-1',
      agent: 'claude',
      sessionId: 'session-1',
      prompt: 'Hello',
      cwd: '/tmp',
    })
    expect(run).toMatchObject({ id: 'run-1', sessionId: 'session-1', state: 'working' })

    first.recordRunOutput('run-1', {
      toOffset: 40,
      entries: [
        { offset: 10, line: '{"a":1}' },
        { offset: 25, line: '{"b":2}' },
      ],
    })
    first.recordRunOutput('run-1', {
      toOffset: 60,
      entries: [{ offset: 40, line: '{"c":3}' }],
      state: 'idle',
    })
    await first.close()

    const second = await openStore({ directory: dir })
    try {
      expect(second.getRun('run-1')).toMatchObject({ sessionId: 'session-1', state: 'idle' })
      expect(second.runReadOffset('run-1')).toBe(60)
      expect(second.conversation('run-1').map((e) => e.line)).toEqual([
        '{"a":1}',
        '{"b":2}',
        '{"c":3}',
      ])
      expect(second.listRuns().map((r) => r.id)).toEqual(['run-1'])
      expect(second.getRun('missing')).toBeUndefined()
    } finally {
      await second.close()
    }
  })

  test('a new Task has no status, a Not started activity line and every default Stage ahead', async () => {
    const store = await openStore({ directory: dir })
    try {
      const task = await store.createTask({ title: 'Fix login' })

      expect(task.status).toBeUndefined()
      expect(task.markers).toEqual([])
      expect(task.activity).toBe('Not started')
      expect(task.runs).toEqual([])
      expect(task.track.map((s) => s.stage)).toEqual(agentStages)
      expect(task.track.every((s) => s.state === 'future')).toBe(true)
    } finally {
      await store.close()
    }
  })

  test('the Stage track follows the Workflow order and strikes through Stages the Task skipped', async () => {
    const first = await openStore({ directory: dir })
    const task = await first.createTask({ title: 'Fix login' })
    const order = [
      { stage: 'intake', enabled: true },
      { stage: 'clarify', enabled: false },
      { stage: 'design', enabled: true },
      { stage: 'work', enabled: true },
      { stage: 'review', enabled: true },
      { stage: 'merge', enabled: false },
    ] as const
    const entry = { layers: [], order: [...order] }
    first.startTask({ taskId: task.id, stage: 'intake', branch: 'b', worktree: '/w', entry, repo })
    first.changeStage(task.id, 'work', entry)
    await first.close()

    const second = await openStore({ directory: dir })
    try {
      expect(second.getTask(task.id)?.track).toEqual([
        { stage: 'intake', state: 'past' },
        { stage: 'clarify', state: 'skipped' },
        { stage: 'design', state: 'skipped' },
        { stage: 'work', state: 'current' },
        { stage: 'review', state: 'future' },
        { stage: 'merge', state: 'skipped' },
      ])
      second.changeStage(task.id, 'done', entry)
      expect(second.getTask(task.id)?.track.map((s) => s.state)).toEqual([
        'past',
        'skipped',
        'skipped',
        'past',
        'skipped',
        'skipped',
      ])
    } finally {
      await second.close()
    }
  })

  test('writing a Task brief updates the Task for the app', async () => {
    const store = await openStore({ directory: dir })
    try {
      const task = await store.createTask({ title: 'Fix login' })
      const seen: DaemonEvent[] = []
      store.subscribe((event) => seen.push(event))

      const brief = store.writeBrief({ taskId: task.id, text: '## Goal\n\nFix it.\n' })

      expect(seen.map((e) => e.type === 'task-updated' && [e.task.id, e.task.updatedAt])).toEqual([
        [task.id, brief.createdAt],
      ])
    } finally {
      await store.close()
    }
  })

  test('a Task waiting on an unmerged blocker says so, and updates when the blocker is done', async () => {
    const store = await openStore({ directory: dir })
    try {
      const blocker = await store.createTask({ title: 'First' })
      const task = await store.createTask({ title: 'Second', blockedBy: [blocker.id] })

      expect(task.markers).toEqual([{ kind: 'blocked-by', by: 'DEV-1' }])
      expect(task.activity).toBe('Starts when DEV-1 merges')
      const seen: DaemonEvent[] = []
      store.subscribe((event) => seen.push(event))
      const entry = { layers: [], order: agentStages.map((stage) => ({ stage, enabled: true })) }
      store.changeStage(blocker.id, 'done', entry)

      const freed = store.getTask(task.id)
      expect(freed?.markers).toEqual([])
      expect(freed?.activity).toBe('Not started')
      expect(seen.map((e) => e.type === 'task-updated' && e.task.id)).toEqual([blocker.id, task.id])
    } finally {
      await store.close()
    }
  })

  test('the agent’s activity line lasts until the Task changes Stage', async () => {
    const store = await openStore({ directory: dir })
    try {
      const task = await store.createTask({ title: 'Fix login' })
      const entry = { layers: [], order: agentStages.map((stage) => ({ stage, enabled: true })) }
      store.startTask({
        taskId: task.id,
        stage: 'intake',
        branch: 'b',
        worktree: '/w',
        entry,
        repo,
      })
      const seen: DaemonEvent[] = []
      store.subscribe((event) => seen.push(event))

      const updated = store.setActivity(task.id, 'Running Checks · Tests (2 of 3)')

      expect(updated.activity).toBe('Running Checks · Tests (2 of 3)')
      expect(seen).toEqual([{ type: 'task-updated', task: updated }])
      store.changeStage(task.id, 'clarify', entry)
      expect(store.getTask(task.id)?.activity).toBeUndefined()
      vi.useFakeTimers({ now: new Date('2026-11-08T12:00:00Z'), toFake: ['Date'] })
      store.setActivity(task.id, 'Asking round 1')
      store.changeStage(task.id, 'design', entry)
      expect(store.getTask(task.id)?.activity).toBeUndefined()
    } finally {
      vi.useRealTimers()
      await store.close()
    }
  })

  test('a Task with a working Run is Working, shows its Runs, and updates when the Run’s state changes', async () => {
    const store = await openStore({ directory: dir })
    try {
      const task = await store.createTask({ title: 'Fix login' })
      const seen: DaemonEvent[] = []
      store.subscribe((event) => seen.push(event))
      store.startRun({ id: 'run-1', agent: 'codex', prompt: 'Hi', cwd: '/tmp', taskId: task.id })

      expect(store.getTask(task.id)).toMatchObject({
        status: { kind: 'working' },
        runs: [{ id: 'run-1', agent: 'codex', state: 'working' }],
      })
      store.recordRunOutput('run-1', { toOffset: 1, entries: [], state: 'waiting' })
      store.recordRunOutput('run-1', { toOffset: 2, entries: [], state: 'finished' })

      const statuses = seen.flatMap((e) => (e.type === 'task-updated' ? [e.task.status?.kind] : []))
      expect(statuses).toEqual(['working', 'waiting-on-you', undefined])
      expect(store.getTask(task.id)?.runs).toEqual([])
    } finally {
      await store.close()
    }
  })

  test('every event has a versioned name', () => {
    for (const event of Object.values(events)) {
      expect(event.name).toMatch(/^v[1-9][0-9]*\.[A-Z][A-Za-z]+$/)
    }
  })
})
