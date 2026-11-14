import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  Comment,
  Factory,
  InboxItem,
  PlanDetail,
  PlanRequest,
  RunChat,
  Task,
  ThreadEvent,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-plan-task-'))
  origin = await makeOriginRepo(scratch)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

const proposal = {
  title: 'Offline editing, in three Tasks',
  tasks: [
    {
      title: 'Local note cache',
      scope: 'Notes save to a local cache first.',
      description: 'Save every note to a local cache first; a queue syncs it later.',
      priority: 'high',
    },
    { title: 'Sync queue', scope: 'Send offline edits in order.', blockedBy: [1] },
    { title: 'Offline badge', scope: 'A badge while edits wait to sync.', priority: 'low' },
  ],
}

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })

const tooBig = {
  run: [
    'ted',
    'clarify',
    'too-big',
    '--settle',
    'Which piece ships first',
    'Offline editing touches storage, sync and the editor.',
  ],
}

async function start() {
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, clarify, work]\n',
  })
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const proposalFile = path.join(scratch, 'proposal.json')
  await writeFile(proposalFile, JSON.stringify(proposal))
  return { ...client, ok, proposalFile }
}

type Client = Awaited<ReturnType<typeof start>>

async function tooBigTask(
  client: Client,
  extra: Record<string, unknown> = {},
): Promise<{ task: Task; sizeCheck: Comment }> {
  const task = await client.ok<Task>('POST', '/tasks', {
    ...extra,
    title: steps(
      { everyMessage: [{ endTurn: true }] },
      { run: ['ted', 'outcome', 'advance'] },
      tooBig,
      { endTurn: true },
    ),
    description: 'Let notes be edited offline and sync later.',
    factory: 'NB',
  })
  await client.ok('POST', `/tasks/${task.id}/start`)
  const item = await waitUntil(
    async () => {
      const items = await client.ok<InboxItem[]>('GET', '/inbox')
      return items.find((i) => i.request.sizeCheck !== undefined)
    },
    'the size check',
    20_000,
  )
  return { task, sizeCheck: item.request }
}

async function planInChat(client: Client, sizeCheck: Comment, ...planner: unknown[]) {
  const answered = await client.ok<Comment>('POST', `/comments/${sizeCheck.id}/answer`, {
    action: 'answer',
    choice: 'Plan in chat',
    text: steps(...planner),
  })
  const planId = answered.answer?.kind === 'answered' ? answered.answer.planId : undefined
  if (planId === undefined) throw new Error('no planning chat')
  return { answered, planId }
}

const getTask = async (client: Client, id: string) => {
  const task = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

const leadMessages = async (client: Client, task: Task) => {
  const { leadRunId } = await getTask(client, task.id)
  if (!leadRunId) return []
  return (await client.getRun(leadRunId)).conversation.flatMap((e) => {
    const line = JSON.parse(e.line) as { type: string; message?: { content?: unknown } }
    return line.type === 'user' && typeof line.message?.content === 'string'
      ? [line.message.content]
      : []
  })
}

const leadHears = (client: Client, task: Task, text: string) =>
  waitUntil(
    async () => (await leadMessages(client, task)).find((m) => m.includes(text)),
    `the Task Lead to hear “${text}”`,
    20_000,
  )

const detail = (client: Client, id: string) => client.ok<PlanDetail>('GET', `/plans/${id}`)

const waitForPlan = (client: Client, id: string, check: (d: PlanDetail) => boolean, what: string) =>
  waitUntil(
    async () => {
      const found = await detail(client, id)
      return check(found) ? found : undefined
    },
    what,
    20_000,
  )

const threadLines = async (client: Client, task: Task) =>
  (await client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)).map((e) => e.text)

describe('Plan in chat from a Task', () => {
  test('opens a chat linked to the Task, which waits in Clarify; approval makes it the parent of every row and stops its Task Lead', async () => {
    const client = await start()
    const lead = { agent: 'claude', effort: 'high' }
    const { task, sizeCheck } = await tooBigTask(client, { lead })
    const { answered, planId } = await planInChat(
      client,
      sizeCheck,
      { run: ['ted', 'task', 'propose', '--file', client.proposalFile] },
      { endTurn: true },
    )
    expect(answered.answer).toMatchObject({ kind: 'answered', choice: 'Plan in chat' })

    const opened = await detail(client, planId)
    expect(opened.plan.title).toBe(`Plan: ${task.title}`.slice(0, 200))
    expect(opened.plan.fromTask).toMatchObject({
      id: task.id,
      displayId: task.displayId,
      stage: 'clarify',
    })
    expect(await getTask(client, task.id)).toMatchObject({
      stage: 'clarify',
      activity: 'Planning in chat',
    })
    const told = await leadHears(client, task, 'Plan in chat')
    expect(told).toContain(opened.plan.title)
    expect(told).not.toContain('ted task propose')
    const events = await client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)
    expect(events.find((e) => e.text.startsWith('Planning in chat'))).toMatchObject({
      text: `Planning in chat: ${opened.plan.title}`,
      planId,
    })

    const proposed = await waitForPlan(
      client,
      planId,
      (d) => d.requests.some((r) => r.kind === 'proposal'),
      'the proposal',
    )
    const request = proposed.requests.find((r) => r.kind === 'proposal') as PlanRequest
    expect(request.proposal?.firstPiece).toEqual({ id: task.id, displayId: task.displayId })
    const chat = await client.ok<RunChat>('GET', `/runs/${planId}/chat`)
    const instructions = chat.items.find((i) => i.kind === 'instructions')
    expect(JSON.stringify(instructions)).toContain('Which piece ships first')
    expect(chat.items.find((i) => i.kind === 'human')).toMatchObject({
      text: expect.stringContaining(`Plan ${task.displayId}:`),
    })

    const leadBefore = (await getTask(client, task.id)).leadRunId
    const approved = await client.ok<PlanRequest>('POST', `/plan-requests/${request.id}/answer`, {
      action: 'approve',
      proposal: { skip: [], startUnblocked: false },
    })
    expect(approved.answer).toMatchObject({
      kind: 'approved',
      created: { tasks: [{ row: 1 }, { row: 2 }, { row: 3 }] },
    })
    const tasks = await client.ok<Task[]>('GET', '/tasks')
    const cache = tasks.find((t) => t.title === 'Local note cache' && t.id !== task.id)
    const sync = tasks.find((t) => t.title === 'Sync queue')
    const badge = tasks.find((t) => t.title === 'Offline badge')
    expect(cache).toMatchObject({ stage: 'backlog', blockedBy: [], parentId: task.id, lead })
    expect(sync).toMatchObject({
      stage: 'backlog',
      blockedBy: [cache?.id],
      parentId: task.id,
      createdBy: 'planning',
      lead,
    })
    expect(badge).toMatchObject({ stage: 'backlog', blockedBy: [], parentId: task.id, lead })
    expect(await getTask(client, task.id)).toMatchObject({
      stage: 'clarify',
      title: task.title,
      description: task.description,
    })
    await waitUntil(
      async () => (await client.getRun(leadBefore ?? '')).run.state === 'finished',
      'the Task Lead to stop',
    )

    const done = await waitForPlan(client, planId, (d) => d.plan.status === 'finished', 'finish')
    expect(done.requests.filter((r) => r.kind === 'note').map((r) => r.body)).toEqual([
      `Created 3 Tasks under ${task.displayId}: ${cache?.displayId}, ${sync?.displayId}, ${badge?.displayId}. ${task.displayId} waits for them to merge.`,
      `Stopped ${task.displayId}’s Task Lead while its child Tasks are built.`,
    ])
    const lines = await threadLines(client, task)
    expect(lines).toContain(
      `The plan created ${cache?.displayId}, ${sync?.displayId} and ${badge?.displayId}. This Task waits for them to merge.`,
    )
    expect(lines).toContain(
      'The plan was approved. TED stopped the Task Lead while the Tasks it created are built.',
    )
    expect((await getTask(client, task.id)).activity).not.toBe('Planning in chat')
  })

  test('stopping the chat tells the Task Lead to ask its size question again', async () => {
    const client = await start()
    const { task, sizeCheck } = await tooBigTask(client)
    const { planId } = await planInChat(
      client,
      sizeCheck,
      { say: 'Let us plan' },
      { endTurn: true },
    )
    const again = await client.call('POST', `/comments/${sizeCheck.id}/answer`, {
      action: 'answer',
      choice: 'Plan in chat',
    })
    expect(again.status).toBe(409)
    await waitForPlan(client, planId, (d) => d.plan.status === 'idle', 'the planner to idle')
    await client.ok('POST', `/plans/${planId}/stop`)
    const told = await leadHears(client, task, 'without an approved plan')
    expect(told).toContain('ted clarify too-big')
    expect(await threadLines(client, task)).toContain(
      'Planning chat stopped without approval. TED told the Task Lead to ask its size question again.',
    )
    const after = await getTask(client, task.id)
    expect(after.stage).toBe('clarify')
    expect(after.activity).not.toBe('Planning in chat')
  })

  test('a chat that ends while no Task Lead Run is live tells the next Run', async () => {
    const client = await start()
    const { task, sizeCheck } = await tooBigTask(client)
    const { planId } = await planInChat(
      client,
      sizeCheck,
      { say: 'Let us plan' },
      { endTurn: true },
    )
    await waitForPlan(client, planId, (d) => d.plan.status === 'idle', 'the planner to idle')
    const stoppedRun = (await getTask(client, task.id)).leadRunId
    await client.ok('POST', `/tasks/${task.id}/stop`)
    await waitUntil(async () => {
      const run = await client.getRun(stoppedRun ?? '')
      return run.run.state === 'finished' || undefined
    }, 'the Task Lead to stop')
    await client.ok('POST', `/plans/${planId}/stop`)
    await waitForPlan(client, planId, (d) => d.plan.status === 'stopped', 'the chat to stop')

    await client.ok('POST', `/tasks/${task.id}/resume`, {})
    const told = await waitUntil(
      async () => {
        const now = await getTask(client, task.id)
        if (!now.leadRunId || now.leadRunId === stoppedRun) return undefined
        return (await leadMessages(client, now)).find((m) => m.includes('without an approved plan'))
      },
      'the next Run to hear the chat ended',
      20_000,
    )
    expect(told).toContain('ted clarify too-big')
  })

  test('archiving the Task mid-plan unlinks it and notes why; approval then creates a new parent for every row', async () => {
    const client = await start()
    const { task, sizeCheck } = await tooBigTask(client)
    const { planId } = await planInChat(
      client,
      sizeCheck,
      { run: ['ted', 'task', 'propose', '--file', client.proposalFile] },
      { endTurn: true },
    )
    const proposed = await waitForPlan(
      client,
      planId,
      (d) => d.requests.some((r) => r.kind === 'proposal'),
      'the proposal',
    )
    const request = proposed.requests.find((r) => r.kind === 'proposal') as PlanRequest
    expect(request.proposal?.firstPiece).toBeDefined()

    await client.ok('POST', `/tasks/${task.id}/archive`, {})
    const standalone = await detail(client, planId)
    expect(standalone.plan.fromTask).toMatchObject({ id: task.id, gone: 'archived' })
    expect(standalone.plan.status).not.toBe('stopped')
    const shown = standalone.requests.find((r) => r.id === request.id)
    expect(shown?.proposal?.firstPiece).toBeUndefined()
    expect(standalone.requests.at(-1)).toMatchObject({
      kind: 'note',
      author: 'ted',
      body: `Unlinked this chat from ${task.displayId} because it was archived. The chat carries on as a standalone plan, and TED creates a new parent Task for the Tasks it creates.`,
    })

    const approved = await client.ok<PlanRequest>('POST', `/plan-requests/${request.id}/answer`, {
      action: 'approve',
      proposal: { skip: [], startUnblocked: false },
    })
    expect(approved.answer).toMatchObject({
      created: { tasks: [{ row: 1 }, { row: 2 }, { row: 3 }] },
    })
    const archived = await getTask(client, task.id)
    expect(archived.title).toBe(task.title)
    const all = await client.ok<Task[]>('GET', '/tasks')
    const parent = all.find((t) => t.title === standalone.plan.title && t.id !== task.id)
    expect(parent).toMatchObject({ stage: 'backlog', childIds: expect.any(Array) })
    expect(
      all
        .filter((t) => t.parentId === parent?.id)
        .map((t) => t.title)
        .sort(),
    ).toEqual(['Local note cache', 'Offline badge', 'Sync queue'])
    expect(
      (await threadLines(client, archived)).some((l) => l.includes('waits for them to merge')),
    ).toBe(false)
  })
})
