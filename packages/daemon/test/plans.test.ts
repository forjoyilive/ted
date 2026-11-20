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
  RunSlots,
  RunWithConversation,
  Task,
} from '@ted/protocol'
import { readDaemonInfo } from '@ted/protocol'
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
    {
      title: 'Notebook owners',
      scope: 'Give every notebook an owner.',
      files: ['src/row-1.ts'],
      priority: 'high',
    },
    {
      title: 'Share dialog',
      scope: 'Let the owner share.',
      files: ['src/row-2.ts'],
      blockedBy: [1],
    },
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
  test('the first message starts a Planning Run in a detached checkout, and Create Tasks finishes and archives it', async () => {
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
    expect(plan.title).toBe(
      'Plan notebook sharing for web and iPhone, with comments on notes and everything',
    )
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
    expect(run.run.prompt).toContain('## Write clearly for the user')
    expect(run.run.prompt).toContain('Rewrite dense source wording in plain language')
    for (const guidance of [
      'Put every question you can ask now in one round, up to 12',
      'goal, scope and exclusions, user behavior (including edge cases), constraints, risks and acceptance criteria',
      'ask the user to confirm your understanding and whether to split it into Tasks',
      'Keep the layers needed for that result together',
    ]) {
      expect(run.run.prompt).toContain(guidance)
    }
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
    await waitUntil(async () => {
      const sent = await client.ok<RunWithConversation>('GET', `/runs/${plan.id}`)
      return (
        JSON.stringify(sent.conversation).includes(
          'Follow newly exposed decisions into another focused round',
        ) || undefined
      )
    }, 'discovery guidance to reach the planner after a round')
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
      [1, 'NB-2', 'backlog', []],
      [2, 'NB-3', 'backlog', ['NB-2']],
    ])
    expect(done.requests.at(-1)).toMatchObject({
      kind: 'note',
      author: 'ted',
      body: 'Created 2 Tasks under NB-1: NB-2, NB-3. NB-1 waits for them to merge.',
    })
    expect(done.plan.createdTasks).toBe(2)
    expect(done.plan.archivedAt).toBeDefined()
    const answeredAt = done.requests.flatMap((r) => (r.answer ? [r.answer.at] : [])).sort()
    expect(done.plan.lastAt >= (answeredAt.at(-1) ?? '')).toBe(true)
    expect(done.plan.lastAt > done.plan.createdAt).toBe(true)
    const tasks = await client.ok<Task[]>('GET', '/tasks')
    expect(
      tasks.map((t) => [t.displayId, t.title, t.createdBy, t.parentId, t.fromPlan?.title]),
    ).toEqual([
      ['NB-1', plan.title, 'planning', undefined, undefined],
      ['NB-2', 'Notebook owners', 'planning', tasks[0]?.id, plan.title],
      ['NB-3', 'Share dialog', 'planning', tasks[0]?.id, plan.title],
    ])
    expect(tasks[0]).toMatchObject({ stage: 'backlog', priority: 'high' })
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
      const conversation = JSON.stringify(sent.conversation)
      return (
        (conversation.includes('Split the dialog in two') &&
          conversation.includes('return to discovery rounds and confirm the changed plan')) ||
        undefined
      )
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

  test('Stop keeps the open round; answering it resumes the same chat; an archived chat can’t resume until it is unarchived', async () => {
    const client = await startTed()
    await writeFile(
      path.join(home, 'stub-claude.json'),
      JSON.stringify({ resumeSteps: [{ endTurn: true }] }),
    )
    const roundFile = await file('round.json', round)
    const plan = await start(
      client,
      `Plan sharing\n${steps({ run: ['ted', 'ask', '--round', roundFile] }, { endTurn: true })}`,
    )
    const asked = await waitForPlan(client, plan.id, (d) => d.plan.status === 'waiting', 'round')
    const roundId = asked.requests.find((r) => r.kind === 'round')?.id as string
    const stopped = await client.ok<Plan>('POST', `/plans/${plan.id}/stop`)
    expect(stopped).toMatchObject({ status: 'stopped', canResume: true, openRequest: true })
    expect((await detail(client, plan.id)).requests[0]?.answer).toBeUndefined()
    expect(
      (await client.ok<PlanInboxItem[]>('GET', '/plan-requests')).map((i) => i.request.id),
    ).toEqual([roundId])
    expect(await client.ok<Task[]>('GET', '/tasks')).toEqual([])
    await waitUntil(
      async () => !existsSync(path.join(home, 'plans', plan.id)) || undefined,
      'the checkout to go',
    )

    await client.ok('POST', `/plan-requests/${roundId}/answer`, { action: 'accept-recommended' })
    await waitUntil(async () => {
      const sent = await client.ok<RunWithConversation>('GET', `/runs/${plan.id}`)
      return JSON.stringify(sent.conversation).includes('The owner only (recommended)') || undefined
    }, 'the answer to reach the resumed planner')
    const resumed = await detail(client, plan.id)
    expect(resumed.plan.status).not.toBe('stopped')
    const run = await client.ok<RunWithConversation>('GET', `/runs/${plan.id}`)
    expect(existsSync(run.run.cwd)).toBe(true)

    await waitForPlan(client, plan.id, (d) => d.plan.status === 'idle', 'the planner to go idle')
    const stopping = client.ok('POST', `/plans/${plan.id}/stop`)
    await waitForPlan(client, plan.id, (d) => d.plan.status === 'stopped', 'the chat to stop')
    const resumedByMessage = await client.ok<Plan>('POST', `/plans/${plan.id}/resume`, {
      message: 'Also think about teams',
    })
    await stopping
    expect(resumedByMessage.status).not.toBe('stopped')
    await waitUntil(async () => {
      const sent = await client.ok<RunWithConversation>('GET', `/runs/${plan.id}`)
      return JSON.stringify(sent.conversation).includes('Also think about teams') || undefined
    }, 'the message to reach the resumed planner')
    const revived = await client.ok<RunWithConversation>('GET', `/runs/${plan.id}`)
    expect(existsSync(revived.run.cwd)).toBe(true)

    await waitForPlan(client, plan.id, (d) => d.plan.status === 'idle', 'the planner to go idle')
    expect((await client.call('POST', `/plans/${plan.id}/finish`, {})).status).toBe(404)
    await client.ok('POST', `/plans/${plan.id}/stop`)
    const archived = await client.ok<Plan>('POST', `/plans/${plan.id}/archive`)
    expect(archived).toMatchObject({ status: 'stopped' })
    expect(archived.archivedAt).toBeDefined()
    expect(archived.canResume).toBeUndefined()
    const refused = await client.call('POST', `/plans/${plan.id}/resume`, {})
    expect(refused).toMatchObject({
      status: 409,
      body: { error: expect.stringContaining('archived') },
    })
    const unarchived = await client.ok<Plan>('POST', `/plans/${plan.id}/unarchive`)
    expect(unarchived.archivedAt).toBeUndefined()
    expect(unarchived).toMatchObject({ status: 'stopped', canResume: true })
  })

  test('Stop while the checkout is still being made keeps the chat stopped; after archive and unarchive, writing to it starts the planner with the message', async () => {
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
    expect(after.plan.canResume).toBe(true)
    await waitUntil(
      async () => !existsSync(path.join(home, 'plans', plan.id)) || undefined,
      'the checkout to go',
    )
    await client.ok('POST', `/plans/${plan.id}/archive`)
    const unarchived = await client.ok<Plan>('POST', `/plans/${plan.id}/unarchive`)
    expect(unarchived).toMatchObject({ status: 'stopped', canResume: true })
    const resumed = await client.ok<Plan>('POST', `/plans/${plan.id}/resume`, {
      message: 'Also think about teams',
    })
    expect(resumed.status).not.toBe('stopped')
    await waitUntil(async () => {
      const sent = await client.call('GET', `/runs/${plan.id}`)
      if (sent.status !== 200) return undefined
      return JSON.stringify(sent.body.conversation).includes('Also think about teams') || undefined
    }, 'the message to reach the planner')
    await client.ok('POST', `/plans/${plan.id}/stop`)
  })

  test('with the limit full a chat starts at once and takes no slot', async () => {
    const client = await startTed()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const task = await client
      .ok<Task>('POST', '/tasks', {
        title: steps({ waitFor: gate('done') }, { endTurn: true }),
        factory: 'NB',
      })
      .then((t) => client.ok<Task>('POST', `/tasks/${t.id}/start`))
    await waitUntil(async () => {
      const slots = await client.ok<RunSlots>('GET', '/slots')
      return slots.holders.some((h) => h.kind === 'task' && h.taskId === task.id) || undefined
    }, 'the Task Lead to hold the slot')
    const plan = await start(
      client,
      `Plan it\n${steps({ waitFor: gate('go') }, { endTurn: true })}`,
    )
    await waitForPlan(client, plan.id, (d) => d.plan.status === 'working', 'the chat to work')
    expect(await client.ok<RunSlots>('GET', '/slots')).toMatchObject({
      limit: 1,
      working: 1,
      queued: 0,
      holders: expect.arrayContaining([
        expect.objectContaining({ kind: 'planning', runId: plan.id }),
      ]),
    })
    const archived = await client.ok<Plan>('POST', `/plans/${plan.id}/archive`)
    expect(archived).toMatchObject({ status: 'stopped' })
    expect(archived.archivedAt).toBeDefined()
    const run = await client.ok<RunWithConversation>('GET', `/runs/${plan.id}`)
    expect(run.run.state).toBe('finished')
    await open('go')
    await open('done')
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
    expect((await client.call('GET', `/runs/${next.id}/chat`)).status).toBe(404)
    expect(existsSync(path.join(home, 'runs', next.id))).toBe(true)
    await client.ok('DELETE', `/plans/${plan.id}`)
    expect((await client.call('GET', `/plans/${plan.id}`)).status).toBe(404)
    expect(await client.ok<Plan[]>('GET', '/plans')).toEqual([])
  })
})

describe('Plans list', () => {
  test('a chat waiting on the human says what it waits on; archiving it withdraws the round and only the app archives', async () => {
    const client = await startTed()
    const roundFile = await file('round.json', round)
    const plan = await start(
      client,
      `Plan sharing\n${steps({ run: ['ted', 'ask', '--round', roundFile] }, { endTurn: true })}`,
    )
    const waiting = await waitForPlan(client, plan.id, (d) => d.plan.status === 'waiting', 'round')
    expect(waiting.plan.waitingOn).toBe('Round 1')
    const [listed] = await client.ok<Plan[]>('GET', '/plans?factory=NB')
    expect(listed).toMatchObject({ status: 'waiting', waitingOn: 'Round 1' })
    const roundId = waiting.requests.find((r) => r.kind === 'round')?.id as string
    expect((await client.ok<{ id: string }[]>('GET', '/inbox/waiting')).map((w) => w.id)).toContain(
      roundId,
    )
    const info = await readDaemonInfo(home)
    if (!info || !daemon) throw new Error('missing daemon connection')
    const withFileToken = api(daemon.port, info.token)
    expect((await withFileToken.call('POST', `/plans/${plan.id}/archive`, {})).status).toBe(403)
    expect((await withFileToken.call('POST', `/plans/${plan.id}/unarchive`, {})).status).toBe(403)

    await client.ok<Plan>('POST', `/plans/${plan.id}/archive`)
    const archived = await detail(client, plan.id)
    expect(archived.plan.archivedAt).toBeDefined()
    expect(archived.requests.find((r) => r.id === roundId)?.answer).toMatchObject({
      kind: 'withdrawn',
    })
    expect(await client.ok<PlanInboxItem[]>('GET', '/plan-requests')).toEqual([])
    expect(
      (await client.ok<{ id: string }[]>('GET', '/inbox/waiting')).map((w) => w.id),
    ).not.toContain(roundId)
    const answer = await client.call('POST', `/plan-requests/${roundId}/answer`, {
      action: 'accept-recommended',
    })
    expect(answer.status).toBe(409)
    await waitUntil(
      async () => !existsSync(path.join(home, 'plans', plan.id)) || undefined,
      'the checkout to go',
    )
    expect(existsSync(path.join(home, 'runs', plan.id))).toBe(true)
  })

  test('Resume carries on a failed chat in a fresh checkout', async () => {
    const client = await startTed()
    const stubState = path.join(home, 'stub-claude.json')
    await writeFile(stubState, JSON.stringify({ resumeFails: true }))
    const plan = await start(client, `Plan sharing\n${steps({ say: 'Reading' }, { exit: 1 })}`)
    const failed = await waitForPlan(client, plan.id, (d) => d.plan.status === 'failed', 'failure')
    expect(failed.plan.error).toBeDefined()
    const folder = path.join(home, 'plans', plan.id)
    await waitUntil(async () => !existsSync(folder) || undefined, 'the checkout to go')
    await writeFile(stubState, '{}')
    const fromFailed = await client.ok<Plan>('POST', '/plans', {
      factory: 'NB',
      message: 'Plan more',
      from: plan.id,
    })
    expect(fromFailed.fromPlan?.id).toBe(plan.id)
    await client.ok('POST', `/plans/${fromFailed.id}/stop`)
    const retried = await client.ok<Plan>('POST', `/plans/${plan.id}/resume`, {})
    expect(retried.status).not.toBe('failed')
    const now = await waitForPlan(
      client,
      plan.id,
      (d) => d.plan.status === 'working',
      'the planner to resume',
    )
    expect(now.plan.error).toBeUndefined()
    const run = await client.ok<RunWithConversation>('GET', `/runs/${plan.id}`)
    expect(existsSync(run.run.cwd)).toBe(true)
    const again = await client.call('POST', `/plans/${plan.id}/resume`, {})
    expect(again.status).toBe(409)
    await client.ok('POST', `/plans/${plan.id}/stop`)
  })

  test('Plan more from here carries the old chat’s rounds, answers, proposal and Tasks', async () => {
    const client = await startTed()
    const roundFile = await file('round.json', round)
    const proposalFile = await file('proposal.json', proposal)
    const plan = await start(
      client,
      `Plan notebook sharing\n${steps(
        { run: ['ted', 'ask', '--round', roundFile] },
        { endTurn: true },
        { waitFor: gate('answered') },
        { run: ['ted', 'task', 'propose', '--file', proposalFile] },
        { endTurn: true },
      )}`,
    )
    const asked = await waitForPlan(client, plan.id, (d) => d.plan.status === 'waiting', 'round')
    const roundId = asked.requests.find((r) => r.kind === 'round')?.id
    const early = await client.call('POST', '/plans', {
      factory: 'NB',
      message: 'More',
      from: plan.id,
    })
    expect(early.status).toBe(409)
    await client.ok('POST', `/plan-requests/${roundId}/answer`, { action: 'accept-recommended' })
    await open('answered')
    const proposed = await waitForPlan(
      client,
      plan.id,
      (d) => d.requests.some((r) => r.kind === 'proposal'),
      'the proposal',
    )
    const proposalId = proposed.requests.find((r) => r.kind === 'proposal')?.id
    await client.ok('POST', `/plan-requests/${proposalId}/answer`, {
      action: 'approve',
      proposal: { skip: [], startUnblocked: false },
    })
    await waitForPlan(client, plan.id, (d) => d.plan.status === 'finished', 'the plan to finish')

    const next = await start(
      client,
      `Now plan comments\n${steps({ say: 'Carrying on' }, { endTurn: true })}`,
      { from: plan.id },
    )
    expect(next.fromPlan).toEqual({ id: plan.id, title: plan.title })
    expect(next.title).toBe('Now plan comments')
    await waitForPlan(client, next.id, (d) => d.plan.runId !== undefined, 'the next planner')
    const chat = JSON.stringify(await client.ok<RunChat>('GET', `/runs/${next.id}/chat`))
    for (const part of [
      'Plan notebook sharing',
      'Who can share a notebook?',
      'The owner only',
      'Sharing, in two Tasks',
      'Share dialog',
      'NB-2',
      'NB-3',
      'Reuse answers already supplied in this or an earlier planning chat',
      'ask the user to confirm your understanding and whether to split it into Tasks',
    ]) {
      expect(chat).toContain(part)
    }

    await client.ok('DELETE', `/plans/${plan.id}`)
    const tasks = await client.ok<Task[]>('GET', '/tasks')
    expect(tasks.map((t) => [t.displayId, t.fromPlan])).toEqual([
      ['NB-1', undefined],
      ['NB-2', { id: plan.id, title: '', deleted: true }],
      ['NB-3', { id: plan.id, title: '', deleted: true }],
    ])
    const after = await detail(client, next.id)
    expect(after.plan.fromPlan).toEqual({ id: plan.id, title: plan.title, deleted: true })
    await client.ok('POST', `/plans/${next.id}/stop`)
  })
})
