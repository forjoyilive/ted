import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  type ChatItem,
  type Factory,
  type RunChat,
  type RunMessage,
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
  return waitUntil(async () => {
    const texts = assistantTexts((await client.getRun(runId)).conversation)
    return texts.includes(text) ? texts : undefined
  }, `the agent to say “${text}”`)
}

const send = (client: Client, runId: string, text: string, interrupt?: boolean) =>
  client.ok<RunMessage>('POST', `/runs/${runId}/messages`, {
    text,
    ...(interrupt !== undefined && { interrupt }),
  })

const waitForState = (client: Client, runId: string, state: string) =>
  waitUntil(
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
    await sleep(400)
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
    await sleep(300)
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
    await sleep(400)
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
    expect(humans(await chatOf(client, runId))).toEqual([
      expect.objectContaining({ id: queued.id, sent: true }),
    ])
  })

  test('Codex: ↵ queues and goes in with turn/steer at the next tool item', async () => {
    const client = await startTed()
    const runId = await working(
      client,
      [{ waitFor: file('a') }, { tool: true }, { waitFor: file('b') }, { endTurn: true }],
      'codex',
    )
    const queued = await send(client, runId, 'Keep the API unchanged.')
    await sleep(300)
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
    expect((await client.call('POST', '/runs/nope/interrupt')).status).toBe(404)
  })
})
