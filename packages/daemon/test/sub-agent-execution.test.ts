import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { executionIds } from '@ted/protocol'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createAgents } from '../src/agents/index.ts'
import { addWorktree } from '../src/git.ts'
import { eventlogFile } from '../src/store/files.ts'
import { openStore, type TedStore } from '../src/store/index.ts'
import { createTaskExecution } from '../src/tasks/execution.ts'
import { createSubAgents, type SubAgentDeps, type SubAgents } from '../src/tasks/sub-agents.ts'
import { makeOriginRepo } from './helpers.ts'

let dir: string
let store: TedStore
let children: SubAgents | undefined

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-legacy-sub-agent-'))
  store = await openStore({ directory: path.join(dir, 'store') })
})

afterEach(async () => {
  children?.close()
  children = undefined
  vi.restoreAllMocks()
  await store.close()
  await rm(dir, { recursive: true, force: true })
})

test.each([false, true])(
  'legacy sub-agent ownership barrier, persistence failure: %s',
  async (fail) => {
    const origin = await makeOriginRepo(path.join(dir, 'source'))
    const cwd = path.join(dir, 'lead')
    await addWorktree(origin, { path: cwd, branch: 'legacy', from: 'main' })
    const task = await store.createTask({ title: 'Legacy live lead' })
    store.startTask({
      taskId: task.id,
      stage: 'work',
      branch: 'legacy',
      worktree: cwd,
      entry: { layers: [], order: [{ stage: 'work', enabled: true }] },
      repo: { name: 'widgets', repo: 'acme/widgets', copied: [], skipped: [] },
    })
    const lead = store.startRun({
      id: randomUUID(),
      agent: 'claude',
      taskId: task.id,
      cwd,
      prompt: 'Lead',
    })
    await store.persisted()
    expect(store.execution.assignment(task.id)).toBeUndefined()
    const file = await eventlogFile(path.join(dir, 'store'))
    if (!file) throw new Error('missing event log')
    const assertPersisted = () => {
      const log = new DatabaseSync(file, { readOnly: true })
      try {
        expect(
          log
            .prepare(
              "SELECT COUNT(*) AS n FROM eventlog WHERE name = 'v1.TaskExecutionAssigned' AND json_extract(argsJson, '$.taskId') = ?",
            )
            .get(task.id)?.n,
        ).toBe(1)
      } finally {
        log.close()
      }
    }
    const execution = createTaskExecution(store)
    const start = vi.fn<SubAgentDeps['runs']['start']>(async (input) => {
      assertPersisted()
      return store.startRun({ ...input, id: input.id ?? randomUUID() })
    })
    const clone = vi.fn(() => {
      assertPersisted()
      return origin
    })
    let pending: Promise<void> | undefined
    children = createSubAgents({
      store,
      runs: {
        start,
        stop: async () => {},
        send: async () => {},
        observe: () => () => {},
        output: { entries: () => [] },
      },
      agents: createAgents({}),
      find(ref) {
        const found = store.getTask(ref)
        if (!found) throw new Error('missing Task')
        return found
      },
      leadFor: async () => ({ agent: 'claude' }),
      reviewerFor: async () => ({ lead: { agent: 'claude' } }),
      visitStart: () => '',
      planReview: async (found, prompt) => ({
        prompt,
        scope: { taskId: found.id, scope: 'full', round: 1, commits: [] },
      }),
      validateSubAgents: async () => false,
      envFor: async () => ({}),
      permissionsFor: async () => 'auto',
      clonePathFor: clone,
      runFolder: async () => cwd,
      prepareExecution: async (task) => {
        await execution.local(task.id)
      },
      worktreesDir: path.join(dir, 'worktrees'),
      pump() {},
      inBackground(_what, work) {
        pending = work()
      },
    })
    const request = await children.request(
      task.id,
      { kind: 'run', runId: lead.id },
      { prompt: 'Explore', ownWorktree: true },
    )
    if (fail) vi.spyOn(store, 'persisted').mockRejectedValueOnce(new Error('event log unavailable'))
    children.begin(request.id)
    if (!pending) throw new Error('sub-agent did not enter the queue')
    if (fail) {
      await expect(pending).rejects.toThrow('event log unavailable')
      expect(clone).not.toHaveBeenCalled()
      expect(start).not.toHaveBeenCalled()
      expect(await stat(path.join(dir, 'worktrees')).catch(() => undefined)).toBeUndefined()
      expect(store.getRun(request.id)).toBeUndefined()
    } else {
      await pending
      expect(clone).toHaveBeenCalled()
      expect(start).toHaveBeenCalledOnce()
      const child = store.getRun(request.id)
      expect(child?.parentRunId).toBe(lead.id)
      expect(child?.cwd).toContain(`${path.sep}sub-agents${path.sep}`)
    }
  },
)

test('a reviewer request in Validate checks who owns the Task before Ted plans the review', async () => {
  const task = await store.createTask({ title: 'Owned elsewhere' })
  store.execution.assign({
    taskId: task.id,
    machineId: executionIds.machine('other-mac'),
    assignmentId: executionIds.assignment(randomUUID()),
    reservationId: executionIds.reservation(randomUUID()),
    operationId: executionIds.operation(randomUUID()),
    expectedGeneration: 0,
  })
  const cwd = path.join(dir, 'stale-worktree')
  store.startTask({
    taskId: task.id,
    stage: 'validate',
    branch: 'stale',
    worktree: cwd,
    entry: { layers: [], order: [{ stage: 'validate', enabled: true }] },
    repo: { name: 'widgets', repo: 'acme/widgets', copied: [], skipped: [] },
  })
  const lead = store.startRun({
    id: randomUUID(),
    agent: 'claude',
    taskId: task.id,
    cwd,
    prompt: 'Lead',
  })
  const execution = createTaskExecution(store)
  const planReview = vi.fn<SubAgentDeps['planReview']>(async (found, prompt) => ({
    prompt,
    scope: { taskId: found.id, scope: 'full', round: 1, commits: [] },
  }))
  const reviewerFor = vi.fn<SubAgentDeps['reviewerFor']>(async () => ({
    lead: { agent: 'claude' },
  }))
  children = createSubAgents({
    store,
    runs: {
      start: async () => {
        throw new Error('no Run should start')
      },
      stop: async () => {},
      send: async () => {},
      observe: () => () => {},
      output: { entries: () => [] },
    },
    agents: createAgents({}),
    find(ref) {
      const found = store.getTask(ref)
      if (!found) throw new Error('missing Task')
      return found
    },
    leadFor: async () => ({ agent: 'claude' }),
    reviewerFor,
    visitStart: () => '',
    planReview,
    validateSubAgents: async () => false,
    envFor: async () => ({}),
    permissionsFor: async () => 'auto',
    clonePathFor: () => cwd,
    runFolder: async () => cwd,
    prepareExecution: async (found) => {
      await execution.local(found.id)
    },
    worktreesDir: path.join(dir, 'worktrees'),
    pump() {},
    inBackground() {},
  })

  await expect(
    children.request(
      task.id,
      { kind: 'run', runId: lead.id },
      { prompt: 'Review', reviewer: true },
    ),
  ).rejects.toThrow('Task execution belongs to another machine')
  expect(planReview).not.toHaveBeenCalled()
  expect(reviewerFor).not.toHaveBeenCalled()
  expect(store.subAgentRequests()).toEqual([])
  expect(store.reviewScopes(task.id)).toEqual([])
})
