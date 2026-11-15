import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { agentStageIds, type DaemonEvent, type Task } from '@ted/protocol'
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

  test('activity counts actual unfinished Runs, not held Task launches', async () => {
    const store = await openStore({ directory: dir })
    try {
      const task = await store.createTask({ title: 'Waiting for an agent' })
      store.holdTaskRun({ taskId: task.id, agent: 'claude' })
      expect(store.activity().runs.active).toBe(0)
      store.startRun({
        id: 'run-1',
        taskId: task.id,
        agent: 'claude',
        prompt: 'Hello',
        cwd: '/tmp',
      })
      expect(store.activity().runs.active).toBe(1)
      store.pauseAgent('claude', 'Usage limit')
      expect(store.activity().runs).toMatchObject({ working: 0, active: 1 })
      store.pauseAgent('claude', undefined)
      store.recordRunOutput('run-1', { toOffset: 1, state: 'idle' })
      expect(store.activity().runs).toMatchObject({ working: 0, active: 1 })
      store.recordRunOutput('run-1', { toOffset: 2, state: 'finished' })
      expect(store.activity().runs.active).toBe(0)
    } finally {
      await store.close()
    }
  })

  test('an event a listener causes reaches later listeners after the event it answers', async () => {
    const store = await openStore({ directory: dir })
    try {
      const first = await store.createTask({ title: 'First' })
      const second = await store.createTask({ title: 'Second' })
      store.queueTask(first.id, 'intake')
      store.queueTask(second.id, 'intake')
      const places = (ids: string[]) =>
        store.setQueueActivity({
          taskPlaces: ids.map((id, index) => ({ id, place: index + 1 })),
          queuedTasks: [],
          queuedRuns: [],
          startingRuns: [],
          startingTasks: [],
        })
      places([first.id, second.id])
      let moved = false
      store.subscribe((event) => {
        if (moved || event.type !== 'task-updated' || event.task.id !== second.id) return
        moved = true
        places([second.id, first.id])
      })
      const seen: DaemonEvent[] = []
      store.subscribe((event) => seen.push(event))
      store.rankTask(second.id, first.rank - 1, second.priority)
      expect(
        seen.flatMap((event) =>
          event.type === 'task-updated' && event.task.id === second.id ? [event.task.status] : [],
        ),
      ).toEqual([
        { kind: 'queued', place: 2 },
        { kind: 'queued', place: 1 },
      ])
    } finally {
      await store.close()
    }
  })

  test('a load or disk hold sends again only the Tasks waiting for a slot', async () => {
    const store = await openStore({ directory: dir })
    try {
      const queued = await store.createTask({ title: 'Queued' })
      const reviewing = await store.createTask({ title: 'Reviewing' })
      await store.createTask({ title: 'Idle' })
      store.queueTask(queued.id, 'intake')
      store.requestSubAgent({
        id: 'child',
        taskId: reviewing.id,
        parentRunId: 'lead',
        name: 'Reviewer',
        agent: 'claude',
        prompt: '',
        ownWorktree: false,
      })
      const seen: Task[] = []
      store.subscribe((event) => {
        if (event.type === 'task-updated') seen.push(event.task)
      })
      store.holdForLoad(true)
      expect(seen.map((task) => task.id).sort()).toEqual([queued.id, reviewing.id].sort())
      expect(seen.find((task) => task.id === queued.id)?.status).toMatchObject({
        kind: 'queued',
        hold: expect.any(String),
      })
      seen.length = 0
      store.holdNewWork('disk full')
      expect(seen.map((task) => task.id).sort()).toEqual([queued.id, reviewing.id].sort())
      expect(seen.find((task) => task.id === queued.id)?.status).toMatchObject({
        kind: 'queued',
        hold: 'disk full',
      })
    } finally {
      await store.close()
    }
  })

  test('queued work and start holds count once and disappear as real Runs start', async () => {
    const store = await openStore({ directory: dir })
    try {
      const task = await store.createTask({ title: 'Queued' })
      store.queueTask(task.id, 'intake')
      store.holdTaskRun({ taskId: task.id, agent: 'claude' })
      expect(store.activity().runs).toMatchObject({ active: 0, queued: 1 })
      const seen: DaemonEvent[] = []
      const unsubscribe = store.subscribe((event) => seen.push(event))
      store.setQueueActivity({
        queuedTasks: [task.id, task.id],
        queuedRuns: ['plan', 'plan', 'sub'],
        startingRuns: ['draft'],
        startingTasks: [task.id],
      })
      expect(store.activity()).toMatchObject({ runs: { active: 0, queued: 2 }, startingWork: 2 })
      store.startRun({ id: 'draft', agent: 'claude', prompt: 'Draft', cwd: '/tmp' })
      store.startRun({ id: 'plan', agent: 'claude', prompt: 'Plan', cwd: '/tmp' })
      store.startRun({ id: 'lead', taskId: task.id, agent: 'claude', prompt: 'Lead', cwd: '/tmp' })
      store.setQueueActivity({
        queuedTasks: [],
        queuedRuns: ['sub'],
        startingRuns: [],
        startingTasks: [],
      })
      expect(store.activity().runs).toMatchObject({ active: 3, queued: 1 })
      expect(store.activity().startingWork).toBeUndefined()
      store.setQueueActivity({
        queuedTasks: [],
        queuedRuns: [],
        startingRuns: [],
        startingTasks: [],
      })
      expect(store.activity().runs.queued).toBe(0)
      expect(seen.filter((event) => event.type === 'activity-changed').at(-1)).toMatchObject({
        activity: { runs: { active: 3, queued: 0 } },
      })
      unsubscribe()
      store.recordRunOutput('draft', { toOffset: 1, state: 'finished' })
      store.setQueueActivity({
        queuedTasks: [],
        queuedRuns: [],
        startingRuns: ['draft'],
        startingTasks: [],
      })
      expect(store.activity().startingWork).toBe(1)
    } finally {
      await store.close()
    }
  })

  test('records a Run with its session ID, read offset, last output time and state', async () => {
    const first = await openStore({ directory: dir })
    const run = first.startRun({
      id: 'run-1',
      agent: 'claude',
      sessionId: 'session-1',
      prompt: 'Hello',
      cwd: '/tmp',
    })
    expect(run).toMatchObject({ id: 'run-1', sessionId: 'session-1', state: 'working' })
    expect(first.lastOutputAt('run-1')).toBeUndefined()

    first.recordRunOutput('run-1', {
      toOffset: 40,
      output: { lastAt: '2026-01-02T03:04:05.000Z' },
    })
    first.recordRunOutput('run-1', { toOffset: 60, state: 'idle' })
    await first.close()

    const second = await openStore({ directory: dir })
    try {
      expect(second.getRun('run-1')).toMatchObject({ sessionId: 'session-1', state: 'idle' })
      expect(second.runReadOffset('run-1')).toBe(60)
      expect(second.lastOutputAt('run-1')).toBe('2026-01-02T03:04:05.000Z')
      expect(second.listRuns().map((r) => r.id)).toEqual(['run-1'])
      expect(second.getRun('missing')).toBeUndefined()
    } finally {
      await second.close()
    }
  })

  test('persists steering release intent without exposing it in the public Run', async () => {
    let store = await openStore({ directory: dir })
    try {
      store.startRun({ id: 'run-1', agent: 'claude', sessionId: 's', prompt: 'Hi', cwd: '/tmp' })
      const message = store.queueRunMessage({ runId: 'run-1', text: 'Held note' })
      const hold = store.recordTurnInterrupted('run-1', true)
      const release = { messageIds: [message.id], first: message.id, holdId: hold.id }
      store.releaseRunSteering('run-1', release)
      await store.persisted()
      await store.close()
      store = await openStore({ directory: dir })
      expect(store.runSteeringRelease('run-1')).toEqual(release)
      expect(store.getRun('run-1')).not.toHaveProperty('steeringRelease')
      expect(store.listRuns()[0]).not.toHaveProperty('steeringRelease')
      const nextHold = store.recordTurnInterrupted('run-1', true)
      expect(store.runSteeringRelease('run-1')?.holdId).not.toBe(nextHold.id)
    } finally {
      await store.close()
    }
  })

  test('what Runs used is summed per agent over the last days, counting only Runs with a cost as priced', async () => {
    const store = await openStore({ directory: dir })
    try {
      expect(store.apiCost(30)).toMatchObject({ days: 30, agents: [] })
      expect(store.apiCost(30).countedFrom).toBeUndefined()
      store.recordRunUsage({
        runId: 'a',
        agent: 'claude',
        model: 'm',
        input: 100,
        output: 10,
        cost: 1.5,
      })
      store.recordRunUsage({ runId: 'b', agent: 'claude', input: 200, output: 20 })
      store.recordRunUsage({ runId: 'c', agent: 'codex', input: 5, output: 1, cost: 0.25 })
      store.recordRunUsage({
        runId: 'a',
        agent: 'claude',
        model: 'm',
        input: 300,
        output: 30,
        cost: 2,
      })
      const report = store.apiCost(30)
      expect(report.countedFrom).toBeDefined()
      expect(report.agents).toEqual([
        { agent: 'claude', runs: 2, pricedRuns: 1, cost: 2, input: 500, output: 50 },
        { agent: 'codex', runs: 1, pricedRuns: 1, cost: 0.25, input: 5, output: 1 },
      ])
      const later = store.apiCost(30, new Date(Date.now() + 31 * 86_400_000))
      expect(later.agents).toEqual([])
      expect(later.countedFrom).toBe(report.countedFrom)
    } finally {
      await store.close()
    }
  })

  test('Run starts store shared prompt text once and rebuild the same prompts from a mixed log', async () => {
    const fixed = `# Working in TED\n\n${'Fixed guidance. '.repeat(40)}`
    const stage = `# Work\n\n${'Stage steps. '.repeat(30)}`
    const instructions = `# Review\n\n${'Read the diff. '.repeat(30)}`
    const leadPrompt = (title: string) => `${fixed}\n\n${stage}\n\n# Your Task: ${title}`
    const subPrompt = `${fixed}\n\n# Your instructions\n\n${instructions}`
    const first = await openStore({ directory: dir })
    const task = await first.createTask({ title: 'Fix login' })
    const start = (id: string, prompt: string, parentRunId?: string) =>
      first.startRun({
        id,
        taskId: task.id,
        agent: 'claude',
        prompt,
        cwd: '/tmp',
        shared: [fixed, stage, 'too short to share'],
        ...(parentRunId !== undefined && { parentRunId }),
      })
    start('old-lead', leadPrompt('Old'))
    start('new-lead', leadPrompt('New'))
    first.requestSubAgent({
      id: 'sub-1',
      taskId: task.id,
      parentRunId: 'new-lead',
      name: 'Review',
      agent: 'claude',
      prompt: `\n${instructions}\n`,
      ownWorktree: false,
    })
    start('sub-1', subPrompt, 'new-lead')
    const run = first.getRun('new-lead')
    expect(run?.prompt).toBeUndefined()
    expect(first.runPrompt('new-lead')).toBe(leadPrompt('New'))
    expect(first.runPrompt('sub-1')).toBe(subPrompt)
    expect(first.subAgentRequests(task.id)).toEqual([])
    await first.persisted()
    await first.close()

    const log = new DatabaseSync((await eventlogFile(dir)) as string)
    try {
      const rows = log
        .prepare(`SELECT name, argsJson FROM eventlog ORDER BY seqNumGlobal`)
        .all() as { name: string; argsJson: string }[]
      const starts = rows.filter((r) => r.name === 'v5.RunStarted')
      expect(starts).toHaveLength(3)
      for (const r of starts) {
        expect(r.argsJson).not.toContain('Fixed guidance.')
        expect(r.argsJson).not.toContain('Read the diff.')
      }
      const seen = rows.filter((r) => r.name === 'v1.PromptTextSeen')
      expect(seen.map((r) => (JSON.parse(r.argsJson) as { text: string }).text).sort()).toEqual(
        [fixed, stage].sort(),
      )
      const oldStart = starts.find((r) => r.argsJson.includes('"old-lead"'))?.argsJson ?? ''
      const { promptParts: _, ...oldArgs } = JSON.parse(oldStart) as Record<string, unknown>
      log
        .prepare(`UPDATE eventlog SET name = 'v4.RunStarted', argsJson = ? WHERE argsJson = ?`)
        .run(JSON.stringify({ ...oldArgs, prompt: leadPrompt('Old') }), oldStart)
    } finally {
      log.close()
    }
    const folder = path.dirname((await eventlogFile(dir)) as string)
    for (const file of await readdir(folder)) {
      if (file.startsWith('state')) await rm(path.join(folder, file))
    }

    const second = await openStore({ directory: dir })
    try {
      expect(second.runPrompt('old-lead')).toBe(leadPrompt('Old'))
      expect(second.runPrompt('new-lead')).toBe(leadPrompt('New'))
      expect(second.runPrompt('sub-1')).toBe(subPrompt)
      expect(second.runPrompt('missing')).toBe('')
    } finally {
      await second.close()
    }
  })

  test('an event log that holds v2.RunOutputRead lines loads, and its lines stay out of the state database', async () => {
    const first = await openStore({ directory: dir })
    first.startRun({ id: 'run-1', agent: 'claude', sessionId: 's', prompt: 'Hello', cwd: '/tmp' })
    expect(first.recordRunOutput('run-1', { toOffset: 20, output: {} })).toBe(false)
    expect(first.runReadOffset('run-1')).toBe(20)
    expect(first.recordRunOutput('run-1', { toOffset: 40, state: 'idle' })).toBe(true)
    expect(first.lastOutputAt('run-1')).toBeDefined()
    await first.persisted()
    await first.close()
    const old = {
      runId: 'run-1',
      toOffset: 60,
      entries: [
        { offset: 10, line: '{"a":1}', at: '2026-01-02T03:04:05.000Z' },
        { offset: 40, line: '{"b":2}', at: '2026-01-02T03:04:06.000Z' },
      ],
    }
    const log = new DatabaseSync((await eventlogFile(dir)) as string)
    try {
      log
        .prepare(`UPDATE eventlog SET name = 'v2.RunOutputRead', argsJson = ? WHERE name = ?`)
        .run(JSON.stringify(old), 'v3.RunOutputRead')
    } finally {
      log.close()
    }
    const folder = path.dirname((await eventlogFile(dir)) as string)
    for (const file of await readdir(folder)) {
      if (file.startsWith('state')) await rm(path.join(folder, file))
    }

    const second = await openStore({ directory: dir })
    try {
      expect(second.runReadOffset('run-1')).toBe(60)
      expect(second.lastOutputAt('run-1')).toBe('2026-01-02T03:04:06.000Z')
      second.holdRunOutput('run-1', { from: 40, toOffset: 90 })
      expect(second.runReadOffset('run-1')).toBe(60)
      second.holdRunOutput('run-1', { from: 60, toOffset: 90 })
      expect(second.runReadOffset('run-1')).toBe(90)
      expect(second.savedReadOffset('run-1')).toBe(60)
    } finally {
      await second.close()
    }
    for (const file of await readdir(folder)) {
      if (!file.startsWith('state') || !file.endsWith('.db')) continue
      const state = new DatabaseSync(path.join(folder, file), { readOnly: true })
      try {
        const tables = state.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()
        expect(tables.map((t) => t.name)).not.toContain('conversationEntries')
        expect(tables.map((t) => t.name)).toContain('runs')
      } finally {
        state.close()
      }
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
      store.recordRunOutput('run-1', { toOffset: 1, state: 'waiting' })
      store.recordRunOutput('run-1', { toOffset: 2, state: 'finished' })

      const statuses = seen.flatMap((e) => (e.type === 'task-updated' ? [e.task.status?.kind] : []))
      expect(statuses).toEqual(['working', 'waiting-on-you', undefined])
      expect(store.getTask(task.id)?.runs).toEqual([])
    } finally {
      await store.close()
    }
  })

  test('getTask finds a Task by its display ID, per Factory, and nothing for an unknown ref', async () => {
    const store = await openStore({ directory: dir })
    try {
      const factory = (key: string) =>
        store.createFactory({
          key,
          name: key,
          repos: [],
          defaultBranch: 'main',
          showTutorial: false,
        })
      const other = factory('OTHER')
      const dashed = factory('MY-APP')
      const devOne = await store.createTask({ title: 'Dev one' })
      const devTwo = await store.createTask({ title: 'Dev two' })
      const otherOne = await store.createTask({ factoryId: other.id, title: 'Other one' })
      const otherTwo = await store.createTask({ factoryId: other.id, title: 'Other two' })
      const dashedOne = await store.createTask({ factoryId: dashed.id, title: 'Dashed one' })

      expect(store.getTask('DEV-1')).toEqual(store.getTask(devOne.id))
      expect(store.getTask('DEV-1')).toMatchObject({ id: devOne.id, displayId: 'DEV-1' })
      expect(store.getTask('DEV-2')?.id).toBe(devTwo.id)
      expect([otherOne.displayId, otherTwo.displayId]).toEqual(['OTHER-2', 'OTHER-3'])
      expect(store.getTask('OTHER-2')?.id).toBe(otherOne.id)
      expect(store.getTask('OTHER-3')?.id).toBe(otherTwo.id)
      expect(dashedOne.displayId).toBe('MY-APP-2')
      expect(store.getTask('MY-APP-2')?.id).toBe(dashedOne.id)

      for (const ref of [
        'DEV-3',
        'OTHER-1',
        'NOPE-1',
        'DEV-01',
        'DEV-1x',
        'DEV- 1',
        'DEV-',
        'DEV',
      ]) {
        expect(store.getTask(ref), ref).toBeUndefined()
      }
      for (const ref of ['APP-2', 'dev-1', '-1', '1', '']) {
        expect(store.getTask(ref), ref).toBeUndefined()
      }

      store.deleteTask(otherOne.id)
      expect(store.getTask('OTHER-2')).toBeUndefined()
      expect(
        (await store.createTask({ factoryId: other.id, title: 'Other three' })).displayId,
      ).toBe('OTHER-4')

      store.removeFactory(other.id)
      expect(store.getTask('OTHER-3')).toBeUndefined()
      expect(store.getTask('?-3')?.id).toBe(otherTwo.id)
      expect(store.getTask('DEV-2')?.id).toBe(devTwo.id)
    } finally {
      await store.close()
    }
  })

  test('a list of Tasks holds what reading each Task one by one gives', async () => {
    const store = await openStore({ directory: dir })
    try {
      const entry = { layers: [], order: agentStages.map((stage) => ({ stage, enabled: true })) }
      const file = { hash: 'a'.repeat(64), name: 'shot.png', size: 3, mediaType: 'image/png' }
      const blocker = await store.createTask({ title: 'Blocker' })
      const merged = await store.createTask({ title: 'Merged blocker' })
      const gone = await store.createTask({ title: 'Deleted blocker' })
      const blocked = await store.createTask({
        title: 'Blocked',
        blockedBy: [blocker.id, merged.id, gone.id],
        attachments: [file],
      })
      store.changeStage(merged.id, 'done', entry)
      store.deleteTask(gone.id)

      const working = await store.createTask({
        title: 'Working',
        source: { url: 'https://linear.app/acme/issue/ENG-7/fix-login' },
      })
      store.startTask({
        taskId: working.id,
        stage: 'work',
        branch: 'b',
        worktree: '/w',
        entry,
        repo,
      })
      store.pullRequestOpened(working.id, repo.name, {
        number: 7,
        url: 'https://github.com/acme/widgets/pull/7',
        base: 'main',
      })
      store.startRun({ id: 'lead', agent: 'claude', prompt: 'Hi', cwd: '/w', taskId: working.id })
      store.startRun({
        id: 'sub',
        agent: 'codex',
        prompt: 'Hi',
        cwd: '/w',
        taskId: working.id,
        parentRunId: 'lead',
        name: 'Reviewer',
      })
      store.openTab(working.id, 'sub')
      store.requestSubAgent({
        id: 'asked',
        taskId: working.id,
        parentRunId: 'lead',
        name: 'Second',
        agent: 'codex',
        prompt: 'Hi',
        ownWorktree: false,
      })
      store.pauseAgent('codex', 'Usage limit')
      store.writeBrief({ taskId: working.id, text: '## Goal\n\nFix it.\n' })
      store.postComment({
        taskId: working.id,
        body: 'Which one?',
        kind: 'question',
        author: { kind: 'run', runId: 'lead' },
      })
      const answered = store.postComment({
        taskId: working.id,
        body: 'And this?',
        kind: 'question',
        author: { kind: 'run', runId: 'lead' },
      })
      store.answerComment(answered.id, {
        kind: 'answered',
        text: 'Yes',
        at: '2026-11-08T12:00:00.000Z',
      })

      const queued = await store.createTask({ title: 'Queued', lead: { agent: 'codex' } })
      store.queueTask(queued.id, 'intake')
      const followUp = await store.createTask({ title: 'Follow-up', followUpOf: working.id })
      const archived = await store.createTask({ title: 'Archived' })
      store.archiveTask(archived.id)
      const stopped = await store.createTask({ title: 'Stopped' })
      store.startRun({ id: 'ended', agent: 'claude', prompt: 'Hi', cwd: '/w', taskId: stopped.id })
      store.recordRunOutput('ended', { toOffset: 1, state: 'finished' })
      for (const title of ['Nine', 'Ten', 'Eleven', 'Twelve']) await store.createTask({ title })

      const list = store.listTasks()
      const ids = list.map((t) => t.id)
      expect(ids).toHaveLength(12)
      const byId = (id: string) => list.find((t) => t.id === id)
      expect(byId(blocked.id)).toMatchObject({
        blockedBy: [blocker.id, merged.id, gone.id],
        markers: [{ kind: 'blocked-by', by: 'DEV-1' }],
        attachments: [file],
      })
      expect(byId(working.id)).toMatchObject({
        leadRunId: 'lead',
        runs: [{ id: 'lead' }, { id: 'sub', name: 'Reviewer', paused: 'Usage limit' }],
        tabs: [{ runId: 'sub' }],
        repos: [{ name: 'widgets', pullRequest: { number: 7 } }],
        source: { url: 'https://linear.app/acme/issue/ENG-7/fix-login' },
        linearSync: 'ask',
      })
      expect(byId(followUp.id)?.followUpOf).toEqual({ id: working.id, displayId: 'DEV-5' })
      for (const task of list) expect(store.getTask(task.id), task.title).toMatchObject(task)
      expect(store.tasksIn(new Set(ids))).toEqual(list)
      const few = new Set([blocked.id, working.id, queued.id])
      expect(store.tasksIn(few)).toEqual(list.filter((t) => few.has(t.id)))

      let builds = store.taskBuilds()
      expect(store.taskOutlines().map((t) => t.id)).toEqual(ids)
      expect(store.factoryOfTask(working.id)).toBe(working.factoryId)
      expect(store.sourcedTaskIds()).toEqual([working.id])
      expect(store.taskSourceUrls()).toEqual([
        { taskId: working.id, url: 'https://linear.app/acme/issue/ENG-7/fix-login' },
      ])
      expect(store.taskPullRequestUrls(working.id)).toEqual([
        'https://github.com/acme/widgets/pull/7',
      ])
      expect(store.taskPullRequestUrls(blocked.id)).toEqual([])
      expect(
        store
          .commentTexts()
          .map((c) => c.body)
          .sort(),
      ).toEqual(['And this?', 'Which one?'])
      expect(store.listAnsweredRequests('2026-01-01', new Set(['approved']))).toEqual([])
      expect(
        store.listAnsweredRequests('2026-01-01', new Set(['answered'])).map((c) => c.id),
      ).toEqual([answered.id])
      expect(store.taskBuilds()).toBe(builds)

      const updated: Task[] = []
      const version = store.taskVersion()
      const unsubscribe = store.subscribe((event) => {
        if (event.type === 'task-updated') updated.push(event.task)
      })
      builds = store.taskBuilds()
      store.setQueueActivity({
        taskPlaces: ids.map((id, index) => ({ id, place: index + 1 })),
        queuedTasks: [],
        queuedRuns: [],
        startingRuns: [],
        startingTasks: [],
      })
      unsubscribe()
      expect(store.taskBuilds() - builds).toBe(ids.length)
      expect(store.taskVersion()).toBeGreaterThan(version)
      expect(updated).toEqual(ids.map((id) => store.tasksIn(new Set([id])).at(0)))
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
