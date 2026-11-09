import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  Factory,
  Plan,
  PlanDetail,
  PlanInboxItem,
  PlanRequest,
  RunChat,
  RunWithConversation,
  Task,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  stubCodexPath,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-plan-'))
  await makeOriginRepo(scratch)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function startTed() {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    codexBin: stubCodexPath,
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', {
    repo: path.join(scratch, 'acme', 'widgets.git'),
    key: 'NB',
  })
  return { ...client, ok }
}

type Client = Awaited<ReturnType<typeof startTed>>

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })
const gate = (name: string) => path.join(scratch, name)
const open = (name: string) => writeFile(gate(name), '')

async function file(name: string, body: unknown): Promise<string> {
  const at = path.join(scratch, name)
  await writeFile(at, JSON.stringify(body))
  return at
}

const round = {
  title: 'Who can share',
  questions: [
    {
      question: 'Who can share a notebook?',
      choices: ['The owner only', 'Anyone'],
      recommended: 'The owner only',
    },
    { question: 'Where are people told?', recommended: 'In the app only' },
  ],
}

const proposal = {
  title: 'Sharing, in two Tasks',
  tasks: [
    { title: 'Notebook owners', scope: 'Give every notebook an owner.', priority: 'high' },
    { title: 'Share dialog', scope: 'Let the owner share.', blockedBy: [1] },
  ],
}

const detail = (client: Client, id: string) => client.ok<PlanDetail>('GET', `/plans/${id}`)

const waitForPlan = (
  client: Client,
  id: string,
  check: (detail: PlanDetail) => boolean,
  what: string,
) =>
  waitUntil(
    async () => {
      const found = await detail(client, id)
      return check(found) ? found : undefined
    },
    what,
    20_000,
  )

const start = (client: Client, message: string, extra: Record<string, unknown> = {}) =>
  client.ok<Plan>('POST', '/plans', { factory: 'NB', message, ...extra })

describe('Planning chats', () => {
  test('the first message starts a Planning Run in a detached checkout, and Create Tasks finishes it', async () => {
    const client = await startTed()
    const roundFile = await file('round.json', round)
    const proposalFile = await file('proposal.json', proposal)
    const plan = await start(
      client,
      `Plan notebook sharing for web and iPhone, with comments on notes and everything\n${steps(
        { run: ['ted', 'ask', '--round', roundFile] },
        { endTurn: true },
        { waitFor: gate('answered') },
        { run: ['ted', 'task', 'propose', '--file', proposalFile] },
        { endTurn: true },
      )}`,
    )
    expect(plan.title).toBe('Plan notebook sharing for web and iPhone, with comments on n')
    expect(plan.agent).toBe('claude')

    const asked = await waitForPlan(
      client,
      plan.id,
      (d) => d.requests.some((r) => r.kind === 'round'),
      'the round',
    )
    expect(asked.plan.status).toBe('waiting')
    const roundRequest = asked.requests.find((r) => r.kind === 'round') as PlanRequest
    expect(roundRequest).toMatchObject({ title: 'Who can share', round: { number: 1 } })

    const run = await client.ok<RunWithConversation>('GET', `/runs/${plan.id}`)
    const folder = path.join(home, 'plans', plan.id)
    expect(run.run.cwd).toBe(path.join(folder, 'widgets'))
    expect(run.run.taskId).toBeUndefined()
    const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: run.run.cwd,
      encoding: 'utf8',
    })
    expect(head.trim()).toBe('HEAD')

    const chat = await client.ok<RunChat>('GET', `/runs/${plan.id}/chat`)
    expect(chat.items.map((i) => i.kind).slice(0, 2)).toEqual(['instructions', 'human'])
    expect(chat.items[1]).toMatchObject({ text: expect.stringContaining('Plan notebook sharing') })

    const inbox = await client.ok<PlanInboxItem[]>('GET', '/plan-requests')
    expect(inbox.map((i) => [i.request.id, i.plan.title])).toEqual([[roundRequest.id, plan.title]])

    await client.ok('POST', `/plan-requests/${roundRequest.id}/answer`, {
      action: 'accept-recommended',
    })
    await open('answered')
    const proposed = await waitForPlan(
      client,
      plan.id,
      (d) => d.requests.some((r) => r.kind === 'proposal'),
      'the proposal',
    )
    expect(proposed.plan.proposedTasks).toBe(2)
    const proposalRequest = proposed.requests.find((r) => r.kind === 'proposal') as PlanRequest
    expect(proposalRequest.proposal?.rows.map((r) => [r.title, r.priority, r.blockedBy])).toEqual([
      ['Notebook owners', 'high', []],
      ['Share dialog', 'none', [1]],
    ])
    expect(await client.ok<PlanInboxItem[]>('GET', '/plan-requests')).toHaveLength(1)

    await client.ok('POST', `/plan-requests/${proposalRequest.id}/answer`, {
      action: 'approve',
      proposal: { skip: [], startUnblocked: false },
    })
    const done = await waitForPlan(
      client,
      plan.id,
      (d) => d.plan.status === 'finished',
      'the plan to finish',
    )
    expect(done.tasks.map((t) => [t.row, t.displayId, t.stage, t.blockedBy])).toEqual([
      [1, 'NB-1', 'backlog', []],
      [2, 'NB-2', 'backlog', ['NB-1']],
    ])
    expect(done.requests.at(-1)).toMatchObject({
      kind: 'note',
      author: 'ted',
      body: 'Created 2 Tasks in Backlog: NB-1, NB-2',
    })
    expect(done.plan.createdTasks).toBe(2)
    const tasks = await client.ok<Task[]>('GET', '/tasks')
    expect(tasks.map((t) => [t.displayId, t.createdBy, t.fromPlan?.title])).toEqual([
      ['NB-1', 'planning', plan.title],
      ['NB-2', 'planning', plan.title],
    ])
    expect(await client.ok<PlanInboxItem[]>('GET', '/plan-requests')).toEqual([])
    await waitUntil(async () => !existsSync(folder) || undefined, 'the checkout to go')
    const runAfter = await client.ok<RunWithConversation>('GET', `/runs/${plan.id}`)
    expect(runAfter.run.state).toBe('finished')
  })

  test('Request changes goes to the planner, and its next proposal is the open one', async () => {
    const client = await startTed()
    const proposalFile = await file('proposal.json', proposal)
    const plan = await start(
      client,
      `Plan sharing\n${steps(
        { run: ['ted', 'task', 'propose', '--file', proposalFile] },
        { endTurn: true },
        { waitFor: gate('changes') },
        { run: ['ted', 'task', 'propose', '--file', proposalFile] },
        { endTurn: true },
      )}`,
    )
    const first = await waitForPlan(
      client,
      plan.id,
      (d) => d.requests.some((r) => r.kind === 'proposal'),
      'the proposal',
    )
    const old = first.requests.find((r) => r.kind === 'proposal') as PlanRequest
    const missing = await client.call('POST', `/plan-requests/${old.id}/answer`, {
      action: 'request-changes',
      text: '',
    })
    expect(missing.status).toBe(400)
    await client.ok('POST', `/plan-requests/${old.id}/answer`, {
      action: 'request-changes',
      text: 'Split the dialog in two',
    })
    await open('changes')
    await waitUntil(async () => {
      const sent = await client.ok<RunWithConversation>('GET', `/runs/${plan.id}`)
      return JSON.stringify(sent.conversation).includes('Split the dialog in two') || undefined
    }, 'the changes to reach the planner')
    const second = await waitForPlan(
      client,
      plan.id,
      (d) => d.requests.filter((r) => r.kind === 'proposal').length === 2,
      'the second proposal',
    )
    const [before, after] = second.requests.filter((r) => r.kind === 'proposal')
    expect(before?.answer).toMatchObject({
      kind: 'changes-requested',
      text: 'Split the dialog in two',
    })
    expect(after?.answer).toBeUndefined()
    const stale = await client.call('POST', `/plan-requests/${old.id}/answer`, {
      action: 'approve',
    })
    expect(stale.status).toBe(409)
  })

  test('Stop ends the chat with no Tasks and withdraws its open round', async () => {
    const client = await startTed()
    const roundFile = await file('round.json', round)
    const plan = await start(
      client,
      `Plan sharing\n${steps({ run: ['ted', 'ask', '--round', roundFile] }, { endTurn: true })}`,
    )
    await waitForPlan(client, plan.id, (d) => d.plan.status === 'waiting', 'the round')
    const stopped = await client.ok<Plan>('POST', `/plans/${plan.id}/stop`)
    expect(stopped.status).toBe('stopped')
    const after = await detail(client, plan.id)
    expect(after.requests[0]?.answer).toMatchObject({ kind: 'withdrawn' })
    expect(await client.ok<PlanInboxItem[]>('GET', '/plan-requests')).toEqual([])
    expect(await client.ok<Task[]>('GET', '/tasks')).toEqual([])
    await waitUntil(
      async () => !existsSync(path.join(home, 'plans', plan.id)) || undefined,
      'the checkout to go',
    )
  })

  test('Stop while the checkout is still being made keeps the chat stopped', async () => {
    const client = await startTed()
    const plan = await start(client, `Plan sharing\n${steps({ say: 'Hi' }, { endTurn: true })}`)
    const stopped = await client.ok<Plan>('POST', `/plans/${plan.id}/stop`)
    expect(stopped.status).toBe('stopped')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const after = await detail(client, plan.id)
    expect(after.plan.status).toBe('stopped')
    const run = await client.call('GET', `/runs/${plan.id}`)
    if (run.status === 200) {
      expect((run.body as RunWithConversation).run.state).toBe('finished')
    }
    await waitUntil(
      async () => !existsSync(path.join(home, 'plans', plan.id)) || undefined,
      'the checkout to go',
    )
  })

  test('with the limit full the chat waits as queued, and a chat waiting on the human frees its slot', async () => {
    const client = await startTed()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const roundFile = await file('round.json', round)
    const first = await start(
      client,
      `First plan\n${steps(
        { waitFor: gate('go') },
        { run: ['ted', 'ask', '--round', roundFile] },
        { endTurn: true },
      )}`,
    )
    await waitForPlan(client, first.id, (d) => d.plan.status === 'working', 'the first to work')
    const second = await start(client, `Second plan\n${steps({ say: 'Hello' }, { endTurn: true })}`)
    expect(second).toMatchObject({ status: 'queued', queuePlace: 1 })
    await open('go')
    await waitForPlan(client, first.id, (d) => d.plan.status === 'waiting', 'the first to wait')
    await waitForPlan(client, second.id, (d) => d.plan.status === 'idle', 'the second to start')
  })

  test('only the human starts, renames and deletes chats, and only a Planning Run posts rounds', async () => {
    const client = await startTed()
    const plan = await start(client, `Plan it\n${steps({ say: 'Hi' }, { endTurn: true })}`)
    const renamed = await client.ok<Plan>('PATCH', `/plans/${plan.id}`, { title: '  Sharing  ' })
    expect(renamed.title).toBe('Sharing')
    expect((await client.call('POST', '/plans', { factory: 'NB', message: '  ' })).status).toBe(400)
    const asApp = await client.call('POST', '/plan-runs/requests', { round })
    expect(asApp.status).toBe(403)
    await waitForPlan(client, plan.id, (d) => d.plan.status === 'idle', 'the planner to go idle')
    expect((await client.ok<Plan>('POST', `/plans/${plan.id}/stop`)).status).toBe('stopped')
    const next = await start(client, `Plan more\n${steps({ say: 'Hi' }, { endTurn: true })}`)
    expect((await client.ok<Plan[]>('GET', '/plans')).map((p) => p.id)).toEqual([plan.id, next.id])
    await waitForPlan(
      client,
      next.id,
      (d) => d.plan.status === 'idle',
      'the next planner to go idle',
    )
    expect((await client.ok<Plan>('POST', `/plans/${next.id}/stop`)).status).toBe('stopped')
    expect((await client.ok<Plan[]>('GET', '/plans')).map((p) => p.status)).toEqual([
      'stopped',
      'stopped',
    ])
    await client.ok('DELETE', `/plans/${next.id}`)
    await client.ok('DELETE', `/plans/${plan.id}`)
    expect((await client.call('GET', `/plans/${plan.id}`)).status).toBe(404)
    expect(await client.ok<Plan[]>('GET', '/plans')).toEqual([])
  })
})
