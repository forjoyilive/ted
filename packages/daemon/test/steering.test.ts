import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type ChatItem,
  type Comment,
  type Factory,
  type RunChat,
  type RunMessage,
  type RunSlots,
  type Task,
  type ThreadEvent,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import {
  api,
  assistantTexts,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  rawRequest,
  stubClaudePath,
  stubCodexPath,
  waitUntil,
} from './helpers.ts'
import { eventWait } from './support/event-wait.ts'
import { ManualClock } from './support/manual-clock.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-steer-'))
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function startTed(
  online?: Parameters<typeof startDaemon>[0]['online'],
  timing: { clock?: ManualClock; nudgeAfterMs?: number } = {},
) {
  daemon = await startDaemon({
    home,
    ...timing,
    ...(online && { online }),
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
  return { ...client, ok }
}

type Client = Awaited<ReturnType<typeof startTed>>

const file = (name: string) => path.join(scratch, name)
const chatOf = (client: Client, runId: string) => client.ok<RunChat>('GET', `/runs/${runId}/chat`)
const humans = (chat: RunChat) =>
  chat.items.filter((i): i is Extract<ChatItem, { kind: 'human' }> => i.kind === 'human')

async function working(client: Client, steps: unknown[], agent = 'claude') {
  const run = await client.startRun([{ say: 'started' }, ...steps], scratch, agent)
  await said(client, run.id, 'started')
  return run.id
}

async function said(client: Client, runId: string, text: string) {
  return eventWait(
    client.subscribe,
    async () => {
      const texts = assistantTexts((await client.getRun(runId)).conversation)
      return texts.includes(text) ? texts : undefined
    },
    `the agent to say “${text}”`,
  )
}

const send = (client: Client, runId: string, text: string, interrupt?: boolean) =>
  client.ok<RunMessage>('POST', `/runs/${runId}/messages`, {
    text,
    ...(interrupt !== undefined && { interrupt }),
  })

const waitForState = (client: Client, runId: string, state: string) =>
  eventWait(
    client.subscribe,
    async () => ((await chatOf(client, runId)).run.state === state ? true : undefined),
    `the Run to be ${state}`,
  )

describe('Steering a working Run', () => {
  test('Claude Code: ↵ queues the message, and the agent reads it at its next tool call', async () => {
    const client = await startTed()
    const runId = await working(client, [
      { waitFor: file('a') },
      { tool: 'Bash' },
      { say: 'after the tool' },
      { waitFor: file('b') },
      { endTurn: true },
    ])

    const queued = await send(client, runId, 'Leave archived notes alone.')
    expect(queued).toMatchObject({ text: 'Leave archived notes alone.', queued: true })
    expect(humans(await chatOf(client, runId))).toEqual([
      expect.objectContaining({ id: queued.id, queued: true, sent: false }),
    ])
    expect(existsSync(path.join(home, 'runs', runId, 'queued'))).toBe(true)
    expect(JSON.stringify((await client.getRun(runId)).conversation)).not.toContain(
      'archived notes',
    )

    await writeFile(file('a'), '')
    const texts = await said(client, runId, 'Read: Leave archived notes alone.')
    expect(texts.indexOf('Read: Leave archived notes alone.')).toBeLessThan(
      texts.indexOf('after the tool'),
    )
    const chat = await chatOf(client, runId)
    expect(chat.run.state).toBe('working')
    expect(humans(chat)).toEqual([expect.objectContaining({ id: queued.id, sent: true })])
    expect(humans(chat)[0]).not.toHaveProperty('queued')
    expect(existsSync(path.join(home, 'runs', runId, 'queued'))).toBe(false)
    expect((await client.call('DELETE', `/runs/${runId}/messages/${queued.id}`)).body).toEqual({
      error: 'The agent has already read this message',
    })
    await writeFile(file('b'), '')
  })

  test('Claude Code: a failed tool call is a boundary too', async () => {
    const client = await startTed()
    const runId = await working(client, [
      { waitFor: file('a') },
      { tool: 'Bash', failed: true },
      { say: 'after the tool' },
      { waitFor: file('b') },
      { endTurn: true },
    ])
    await send(client, runId, 'Try the other approach.')
    await writeFile(file('a'), '')
    const texts = await said(client, runId, 'Read: Try the other approach.')
    expect(texts.indexOf('Read: Try the other approach.')).toBeLessThan(
      texts.indexOf('after the tool'),
    )
    await writeFile(file('b'), '')
  })

  test('a queued message can be deleted until the agent reads it', async () => {
    const client = await startTed()
    const runId = await working(client, [
      { waitFor: file('a') },
      { tool: 'Bash' },
      { say: 'done' },
      { endTurn: true },
    ])
    const queued = await send(client, runId, 'Never mind.')

    expect(await client.ok('DELETE', `/runs/${runId}/messages/${queued.id}`)).toMatchObject({
      id: queued.id,
    })
    expect(humans(await chatOf(client, runId))).toEqual([])
    await writeFile(file('a'), '')
    await said(client, runId, 'done')
    await waitForState(client, runId, 'idle')
    expect(JSON.stringify((await client.getRun(runId)).conversation)).not.toContain('Never mind')
  })

  test('with no tool call before the turn ends, the message goes after the turn', async () => {
    const client = await startTed()
    const runId = await working(client, [
      { everyMessage: [{ say: 'next turn' }, { endTurn: true }] },
      { waitFor: file('a') },
      { endTurn: true },
    ])
    const queued = await send(client, runId, 'One more thing.')
    await writeFile(file('a'), '')
    await said(client, runId, 'next turn')
    expect(humans(await chatOf(client, runId))).toEqual([
      expect.objectContaining({ id: queued.id, sent: true }),
    ])
  })

  test('⌘↵ interrupts the turn and delivers the message; the Run stays open', async () => {
    const client = await startTed()
    const runId = await working(client, [
      { everyMessage: [{ say: 'redirected' }, { endTurn: true }] },
      { tool: 'Bash' },
      { waitFor: file('never') },
      { endTurn: true },
    ])
    const sent = await send(client, runId, 'Stop and fix the swipe handler.', true)

    await said(client, runId, 'redirected')
    const chat = await chatOf(client, runId)
    expect(chat.run.state).not.toBe('finished')
    const kinds = chat.items.map((i) => i.kind)
    expect(kinds.indexOf('interrupted')).toBeGreaterThan(-1)
    expect(kinds.indexOf('interrupted')).toBeLessThan(kinds.indexOf('human'))
    expect(humans(chat)).toEqual([expect.objectContaining({ id: sent.id, sent: true })])
  })

  test('■ stops the turn without sending, and holds messages queued before it', async () => {
    const client = await startTed()
    const runId = await working(client, [
      { everyMessage: [{ say: 'took it' }, { endTurn: true }] },
      { waitFor: file('never') },
      { endTurn: true },
    ])
    const queued = await send(client, runId, 'Also check the iPad layout.')

    await client.ok('POST', `/runs/${runId}/interrupt`)
    await waitForState(client, runId, 'idle')
    const chat = await chatOf(client, runId)
    expect(chat.items.some((i) => i.kind === 'interrupted')).toBe(true)
    expect(humans(chat)).toEqual([expect.objectContaining({ id: queued.id, queued: true })])
    expect(assistantTexts((await client.getRun(runId)).conversation)).not.toContain('took it')
    expect(await client.call('POST', `/runs/${runId}/interrupt`)).toEqual({
      status: 409,
      body: { error: 'The Run isn’t working, so there’s no turn to stop' },
    })

    await client.ok('POST', `/runs/${runId}/messages/${queued.id}/send-now`)
    await said(client, runId, 'took it')
  })

  test('Send now interrupts the turn and delivers a queued message', async () => {
    const client = await startTed()
    const runId = await working(client, [
      { everyMessage: [{ say: 'sent now' }, { endTurn: true }] },
      { waitFor: file('never') },
      { endTurn: true },
    ])
    const queued = await send(client, runId, 'Use the new sort order.')
    const now = await client.ok<RunMessage>('POST', `/runs/${runId}/messages/${queued.id}/send-now`)
    expect(now).toMatchObject({ id: queued.id })
    await said(client, runId, 'sent now')
    const chat = await chatOf(client, runId)
    expect(humans(chat)).toEqual([expect.objectContaining({ id: queued.id, sent: true })])
    const kinds = chat.items.map((i) => i.kind)
    expect(kinds.indexOf('interrupted')).toBeGreaterThan(-1)
    expect(kinds.indexOf('interrupted')).toBeLessThan(kinds.indexOf('human'))
  })

  test('Codex: ↵ queues and goes in with turn/steer at the next tool item', async () => {
    const client = await startTed()
    const runId = await working(
      client,
      [{ waitFor: file('a') }, { tool: true }, { waitFor: file('b') }, { endTurn: true }],
      'codex',
    )
    const queued = await send(client, runId, 'Keep the API unchanged.')
    const requests = path.join(scratch, 'stub-requests.jsonl')
    expect(await readFile(requests, 'utf8')).not.toContain('turn/steer')

    await writeFile(file('a'), '')
    await said(client, runId, 'Read: Keep the API unchanged.')
    const steer = (await readFile(requests, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
      .find((m) => m.method === 'turn/steer')
    expect(steer?.params).toMatchObject({ expectedTurnId: 'turn-1' })
    expect(humans(await chatOf(client, runId))).toEqual([
      expect.objectContaining({ id: queued.id, sent: true }),
    ])
    await writeFile(file('b'), '')
  })

  test('Codex: ⌘↵ sends turn/interrupt, then starts a turn with the message', async () => {
    const client = await startTed()
    const runId = await working(client, [{ waitFor: file('never') }, { endTurn: true }], 'codex')
    await send(
      client,
      runId,
      JSON.stringify({ steps: [{ say: 'new turn' }, { endTurn: true }] }),
      true,
    )
    await said(client, runId, 'new turn')
    const methods = (await readFile(path.join(scratch, 'stub-requests.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { method?: string }).method)
    expect(methods.filter((m) => m?.startsWith('turn/'))).toEqual([
      'turn/start',
      'turn/interrupt',
      'turn/start',
    ])
    expect((await chatOf(client, runId)).run.state).not.toBe('finished')
  })

  test('a queued message to the Task Lead leaves its thread line once delivered', async () => {
    const client = await startTed()
    const origin = await makeOriginRepo(scratch)
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
    await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
    const task = await client.ok<Task>('POST', '/tasks', {
      title: JSON.stringify({
        steps: [
          { waitFor: file('a') },
          { tool: 'Bash' },
          { waitFor: file('b') },
          { endTurn: true },
        ],
      }),
      factory: 'NB',
      start: true,
    })
    const runId = await waitUntil(async () => {
      const current = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)
      return current?.runs[0]?.state === 'working' ? current.leadRunId : undefined
    }, 'the Task Lead to work')
    const steered = async () =>
      (await client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)).filter(
        (l) => l.text === 'You steered the Task Lead in its Conversation',
      )

    await send(client, runId, 'Do the API first.')
    expect(await steered()).toEqual([])
    await writeFile(file('a'), '')
    await waitUntil(async () => ((await steered()).length === 1 ? true : undefined), 'the line')
    await writeFile(file('b'), '')
  })

  test('the steering routes are closed to Runs, and a Run reports only its own tool calls', async () => {
    const client = await startTed()
    const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
    for (const [method, route] of [
      ['POST', '/runs/run-1/interrupt'],
      ['POST', '/runs/run-1/messages/m-1/send-now'],
      ['DELETE', '/runs/run-1/messages/m-1'],
    ] as const) {
      const res = await rawRequest(daemon?.port ?? 0, {
        method,
        path: route,
        headers: { authorization: `Bearer ${tokens.issue('run-1')}` },
      })
      expect(res.status, `${method} ${route}`).toBe(403)
    }
    const other = await rawRequest(daemon?.port ?? 0, {
      method: 'POST',
      path: '/runs/run-1/boundary',
      headers: { authorization: `Bearer ${tokens.issue('run-2')}` },
    })
    expect(other.status).toBe(403)
    expect((await client.call('POST', '/runs/run-1/boundary')).status).toBe(403)
    expect((await client.call('POST', '/runs/nope/interrupt')).status).toBe(404)
  })
})

async function questionDuringWork(
  client: Client,
  beforeReply?: (task: Task, runId: string) => Promise<void>,
  continuation: unknown[] = [],
) {
  const origin = await makeOriginRepo(scratch)
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
  })
  await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const task = await client.ok<Task>('POST', '/tasks', {
    title: JSON.stringify({
      steps: [
        { everyMessage: continuation },
        { say: 'ready for a question' },
        { waitFor: file('answer-boundary') },
        { tool: 'Bash' },
        { waitFor: file('finish-answer') },
        { endTurn: true },
      ],
    }),
    factory: 'NB',
    start: true,
  })
  const runId = await waitUntil(async () => {
    const current = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)
    return current?.leadRunId
  }, 'the Task Lead')
  await said(client, runId, 'ready for a question')
  const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
  const lead = api(daemon?.port ?? 0, tokens.issue(runId))
  const posted = await lead.call('POST', `/tasks/${task.id}/comments`, {
    body: 'Should tools be disabled?',
    choices: ['Yes', 'No'],
  })
  expect(posted.status).toBe(201)
  const question = posted.body as Comment
  await beforeReply?.(task, runId)
  const reply = 'Tell me more about why it is helpful for tools to be disabled'
  const saved = await client.ok<Comment>('POST', `/comments/${question.id}/answer`, {
    action: 'answer',
    text: reply,
  })
  const current = async () =>
    (await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)).find(
      (c) => c.id === question.id,
    )
  return { task, runId, lead, saved, current, reply }
}

test('question replies wait for a safe boundary and survive a failed transport before retry', async () => {
  const client = await startTed()
  const { runId, lead, saved, current, reply } = await questionDuringWork(client)
  expect(saved.answerDelivery).toEqual({ queuedAt: saved.answer?.at })
  const input = path.join(home, 'runs', runId, 'input.jsonl')
  await writeFile(input, '', { flag: 'a', mode: 0o600 })
  const original = await readFile(input)
  const mode = (await stat(input)).mode & 0o777
  const revivedAt = (await client.getRun(runId)).run.revivedAt
  await chmod(input, 0o400)
  try {
    const failure = await lead.call('POST', `/runs/${runId}/boundary`)
    expect(failure.status).toBe(500)
    expect((await current())?.answerDelivery?.sent).toBeUndefined()
    expect(await readFile(input)).toEqual(original)
  } finally {
    await chmod(input, mode)
  }
  await writeFile(file('answer-boundary'), '')
  const receipt = await waitUntil(async () => (await current())?.answerDelivery?.sent, 'reply sent')
  expect(receipt.runId).toBe(runId)
  await waitUntil(async () => {
    const texts = assistantTexts((await client.getRun(runId)).conversation)
    return texts.some((text) => text.includes(`Read: The user replied`) && text.includes(reply))
      ? true
      : undefined
  }, 'the reply at the boundary')
  await writeFile(file('finish-answer'), '')
  await waitForState(client, runId, 'idle')
  const finished = await client.getRun(runId)
  expect(finished.run.revivedAt).toBe(revivedAt)
  expect(
    assistantTexts(finished.conversation).filter(
      (text) => text.includes('Read: The user replied') && text.includes(reply),
    ),
  ).toHaveLength(1)
})

test('an unsent question reply reaches a replacement Task Lead in its starting prompt', async () => {
  const client = await startTed()
  const { task, runId, current, reply } = await questionDuringWork(client)
  await client.ok('POST', `/tasks/${task.id}/stop`)
  expect((await current())?.answerDelivery?.sent).toBeUndefined()
  await client.ok('POST', `/tasks/${task.id}/resume`, {})
  const sent = await waitUntil(
    async () => (await current())?.answerDelivery?.sent,
    'replacement delivery',
  )
  expect(sent.runId).not.toBe(runId)
  const replacement = await client.getRun(sent.runId)
  expect(replacement.run.prompt).toContain(reply)
  expect(replacement.run.prompt).toContain('ask it again')
  expect(replacement.run.prompt).toContain('A request for explanation gives no consent')
  await said(client, sent.runId, 'ready for a question')
  await writeFile(file('answer-boundary'), '')
  await writeFile(file('finish-answer'), '')
})

test('a reply saved while its idle Task Lead is offline is sent when health recovers', async () => {
  let online = true
  const client = await startTed({
    isOnline: async () => online,
    onlineEveryMs: 20,
    offlineEveryMs: 20,
  })
  const { runId, saved, current } = await questionDuringWork(client, async (task, runId) => {
    await writeFile(file('answer-boundary'), '')
    await writeFile(file('finish-answer'), '')
    await waitForState(client, runId, 'idle')
    online = false
    await waitUntil(async () => {
      const current = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)
      return current?.runs.find((r) => r.id === runId)?.paused ? true : undefined
    }, 'the idle Task Lead to be paused')
  })
  expect(saved.answerDelivery?.sent).toBeUndefined()
  expect((await current())?.answerDelivery?.sent).toBeUndefined()
  online = true
  const sent = await waitUntil(
    async () => (await current())?.answerDelivery?.sent,
    'reply after recovery',
  )
  expect(sent.runId).toBe(runId)
})

test('an idle question reply stays queued past the nudge deadline until a working slot admits it', async () => {
  const clock = new ManualClock()
  const client = await startTed(undefined, { clock, nudgeAfterMs: 1000 })
  await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
  let blocker: Task | undefined
  let blockerRunId: string | undefined
  const { task, runId, saved, current, reply } = await questionDuringWork(
    client,
    async (_task, runId) => {
      await writeFile(file('answer-boundary'), '')
      await writeFile(file('finish-answer'), '')
      await waitForState(client, runId, 'idle')
      blocker = await client.ok<Task>('POST', '/tasks', {
        factory: 'NB',
        start: true,
        title: JSON.stringify({
          steps: [
            { say: 'slot occupied' },
            { waitFor: file('after-nudge-deadline') },
            { tool: 'Bash' },
            { say: 'still occupying the slot' },
            { waitFor: file('keep-slot') },
            { endTurn: true },
          ],
        }),
      })
      const blockerRun = await waitUntil(async () => {
        const task = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === blocker?.id)
        return task?.leadRunId
      }, 'the blocking Task Lead')
      blockerRunId = blockerRun
      await said(client, blockerRun, 'slot occupied')
    },
    [{ say: 'admitted reply received' }, { endTurn: true }],
  )
  expect(saved.answerDelivery?.sent).toBeUndefined()
  await waitUntil(async () => {
    const current = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)
    return current?.status?.kind === 'queued' ? true : undefined
  }, 'the reply to wait for a slot')
  expect((await current())?.answerDelivery?.sent).toBeUndefined()
  if (!blocker || !blockerRunId) throw new Error('the blocking Task was not created')
  clock.advance(1001)
  await writeFile(file('after-nudge-deadline'), '')
  await said(client, blockerRunId, 'still occupying the slot')
  expect((await client.getRun(runId)).run.state).toBe('idle')
  expect((await current())?.answerDelivery?.sent).toBeUndefined()
  expect(await client.ok<RunSlots>('GET', '/slots')).toMatchObject({ working: 1, queued: 1 })
  expect(
    (await client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)).filter((event) =>
      event.text.startsWith('TED nudged the Task Lead'),
    ),
  ).toEqual([])
  await client.ok('POST', `/tasks/${blocker.id}/stop`)
  const sent = await waitUntil(
    async () => (await current())?.answerDelivery?.sent,
    'admitted reply',
  )
  expect(sent.runId).toBe(runId)
  await said(client, runId, 'admitted reply received')
  await waitForState(client, runId, 'idle')
  expect(
    (await client.getRun(runId)).conversation.filter(({ line }) => {
      const entry = JSON.parse(line) as { type?: string; message?: { content?: unknown } }
      return (
        entry.type === 'user' &&
        typeof entry.message?.content === 'string' &&
        entry.message.content.includes(reply)
      )
    }),
  ).toHaveLength(1)
})
