import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type Comment,
  type Coordinator,
  type CoordinatorReceipt,
  type CoordinatorRequest,
  type CoordinatorTask,
  type Factory,
  type FailureCase,
  type LineComment,
  type RunChat,
  type RunMessage,
  type RunSlots,
  type RunWithConversation,
  readDaemonInfo,
  sizeChoices,
  type Task,
  tedPaths,
  type WaitingRequest,
} from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { coordinatorLine } from '../src/coordinators/coordinators.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import {
  api,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  stubCodexPath,
  waitUntil,
} from './helpers.ts'

let home: string,
  scratch: string,
  origin: string,
  cleanup: () => Promise<void>,
  daemon: RunningDaemon | undefined
beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-coordinator-'))
  origin = await makeOriginRepo(scratch)
})
afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})
async function setup(
  disk?: { freeBytes: () => Promise<number>; checkEveryMs: number },
  workflow?: string,
  nudgeAfterMs?: number,
) {
  if (workflow) await commitToOrigin(scratch, { '.ted/workflow.yaml': workflow })
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    codexBin: stubCodexPath,
    ...(disk && { disk }),
    ...(nudgeAfterMs !== undefined && { nudgeAfterMs }),
  })
  const port = daemon.port
  const client = api(port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  const factory = await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const base = `/factories/${factory.id}/coordinator`
  const chat = () => ok<Coordinator>('GET', base)
  const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
  async function start(steps: unknown[] = [{ waitFor: path.join(scratch, 'finish') }]) {
    const c = await ok<Coordinator>('POST', `${base}/messages`, {
      text: JSON.stringify({ steps }),
      agent: 'claude',
    })
    await waitUntil(async () => {
      const current = await chat()
      return current.started && current.status === 'working' ? current : undefined
    }, 'Coordinator to start')
    return { c, run: api(port, tokens.issue(c.runId)) }
  }
  const task = (title = 'A Task', factoryKey = 'NB') =>
    ok<Task>('POST', '/tasks', { factory: factoryKey, title })
  async function led(...steps: unknown[]) {
    const made = await task(JSON.stringify({ steps }))
    await ok('POST', `/tasks/${made.id}/start`)
    const leadRunId = await waitUntil(
      async () => (await ok<Task[]>('GET', '/tasks')).find((t) => t.id === made.id)?.leadRunId,
      'a Task Lead Run',
    )
    return { task: made, leadRunId, lead: api(port, tokens.issue(leadRunId)) }
  }
  const comments = (id: string) => ok<Comment[]>('GET', `/tasks/${id}/comments`)
  const waitingIds = async () =>
    (await ok<WaitingRequest[]>('GET', '/inbox/waiting')).map((w) => w.id)
  return { port, client, ok, factory, base, chat, tokens, start, task, led, comments, waitingIds }
}
type Api = ReturnType<typeof api>
const version = async (run: Api, id: string) =>
  unpack<CoordinatorTask>((await run.call('GET', `/coordinator/tasks/${id}`)).body).version
const hold = () => ({ waitFor: path.join(scratch, 'lead-finish') })
function unpack<T>(body: unknown): T {
  const text = (body as { context: string }).context
  return JSON.parse(text.split('\n').slice(1, -1).join('\n')) as T
}

test('one conversation per Factory; scoped reads include fresh briefs and Comments', async () => {
  const s = await setup(),
    task = await s.task()
  const otherDir = path.join(scratch, 'other-origin')
  await mkdir(otherDir, { recursive: true })
  const otherOrigin = await makeOriginRepo(otherDir)
  const renamed = path.join(otherDir, 'acme', 'gadgets.git')
  await rename(otherOrigin, renamed)
  await s.ok('POST', '/dev/factories', { repo: renamed, key: 'OTHER' })
  const other = await s.task('Other Task', 'OTHER')
  const { c, run } = await s.start()
  const conversation = await s.ok<RunWithConversation>('GET', `/runs/${c.runId}`)
  expect(conversation.run.prompt).toContain('## Write clearly for the user')
  const list = unpack<{ tasks: Task[] }>((await run.call('GET', '/coordinator/tasks')).body)
  expect(list.tasks.map((t) => t.id)).toEqual([task.id])
  expect((await run.call('GET', `/coordinator/tasks/${other.id}`)).status).toBe(404)
  await s.ok('POST', `/tasks/${task.id}/comments`, { body: 'Fresh context from the human' })
  const read = unpack<CoordinatorTask>(
    (await run.call('GET', `/coordinator/tasks/${task.id}`)).body,
  )
  expect(read.comments.some((c) => c.body === 'Fresh context from the human')).toBe(true)
  const again = await s.ok<Coordinator>('POST', `${s.base}/messages`, {
    text: 'Compare these Tasks',
  })
  expect(again.runId).toBe(c.runId)
  expect((await s.chat()).tasks.map((t) => t.id)).toEqual([task.id])
})

test('Coordinator tokens cannot use generic reads, mutations, or human-only actions', async () => {
  const s = await setup(),
    task = await s.task(),
    { run } = await s.start()
  for (const [method, route] of [
    ['GET', '/tasks'],
    ['GET', '/settings'],
    ['GET', '/backups'],
    ['GET', '/events'],
    ['POST', `/tasks/${task.id}/start`],
    ['POST', `/tasks/${task.id}/outcome`],
    ['POST', `${s.base}/messages`],
  ] as const) {
    expect(
      (await run.call(method, route, method === 'GET' ? undefined : { text: 'bypass' })).status,
      route,
    ).toBe(403)
  }
  const ordinary = await s.client.startRun(
    [{ waitFor: path.join(scratch, 'other-finish') }],
    scratch,
  )
  expect(
    (await api(s.port, s.tokens.issue(ordinary.id)).call('GET', '/coordinator/tasks')).status,
  ).toBe(403)
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('missing daemon connection')
  const file = api(s.port, info.token)
  expect((await file.call('POST', `${s.base}/messages`, { text: 'bypass' })).status).toBe(403)
  expect((await file.call('POST', `/coordinator/tasks/${task.id}/start`, {})).status).toBe(403)
})

test('actions reject stale state and cross-Factory neighbours; operation IDs deduplicate moves', async () => {
  const s = await setup(),
    a = await s.task('A'),
    b = await s.task('B'),
    { run } = await s.start()
  const read = async (id: string) =>
    unpack<CoordinatorTask>((await run.call('GET', `/coordinator/tasks/${id}`)).body)
  await s.ok('PUT', `/tasks/${b.id}/priority`, { priority: 'high' })
  const av = await read(a.id),
    bv = await read(b.id)
  const input = {
    operation: 'move-1',
    version: av.version,
    after: b.id,
    neighbours: { [b.id]: bv.version },
  }
  const move = await run.call('POST', `/coordinator/tasks/${a.id}/move`, input)
  expect(move.status).toBe(200)
  expect((move.body as { text: string }).text).toContain('Priority changed to high')
  const receipt = (await s.chat()).receipts[0]
  expect(receipt?.before?.priority).toBe('none')
  expect(receipt?.after?.priority).toBe('high')
  expect((await run.call('POST', `/coordinator/tasks/${a.id}/move`, input)).body).toEqual(move.body)
  expect(
    (await run.call('POST', `/coordinator/tasks/${a.id}/move`, { ...input, operation: 'stale' }))
      .status,
  ).toBe(409)
  expect(
    (await run.call('POST', `/coordinator/tasks/${a.id}/move`, { ...input, before: a.id })).status,
  ).toBe(409)
  const otherDir = path.join(scratch, 'other-origin')
  await mkdir(otherDir, { recursive: true })
  const otherOrigin = await makeOriginRepo(otherDir)
  const renamed = path.join(otherDir, 'acme', 'gadgets.git')
  await rename(otherOrigin, renamed)
  await s.ok('POST', '/dev/factories', { repo: renamed, key: 'OTHER' })
  const foreign = await s.task('foreign', 'OTHER')
  expect(
    (
      await run.call('POST', `/coordinator/tasks/${b.id}/move`, {
        operation: 'foreign',
        version: bv.version,
        before: foreign.id,
      })
    ).status,
  ).toBe(404)
})

test('start queues a Task through existing slot limits and writes one receipt', async () => {
  const s = await setup()
  await s.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
  const task = await s.task(),
    { run } = await s.start()
  const detail = unpack<CoordinatorTask>(
    (await run.call('GET', `/coordinator/tasks/${task.id}`)).body,
  )
  const input = { operation: 'start-1', version: detail.version }
  const first = await run.call('POST', `/coordinator/tasks/${task.id}/start`, input)
  expect(first.status).toBe(200)
  expect((await run.call('POST', `/coordinator/tasks/${task.id}/start`, input)).body).toEqual(
    first.body,
  )
  const tasks = await s.ok<Task[]>('GET', '/tasks')
  expect(tasks.find((t) => t.id === task.id)?.stage).toBe('intake')
  expect((await s.chat()).receipts).toHaveLength(1)
  const slots = await s.ok<RunSlots>('GET', '/slots')
  expect(slots.working).toBe(1)
  expect(slots.queue.some((q) => q.kind === 'task' && q.taskId === task.id)).toBe(true)
})

test('idle follow-up turns wait for a slot, including generic chat message paths', async () => {
  const s = await setup()
  await s.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
  const { c } = await s.start([{ say: 'First response' }, { endTurn: true }])
  await waitUntil(async () => (await s.chat()).status === 'ready', 'Coordinator to become ready')
  const task = await s.task(
    JSON.stringify({ steps: [{ waitFor: path.join(scratch, 'task-finish') }, { endTurn: true }] }),
  )
  await s.ok('POST', `/tasks/${task.id}/start`)
  await waitUntil(
    async () => (await s.ok<RunSlots>('GET', '/slots')).working === 1,
    'Task to hold slot',
  )
  await s.ok('POST', `/runs/${c.runId}/messages`, {
    text: JSON.stringify({ steps: [{ say: 'Second response' }, { endTurn: true }] }),
  })
  await waitUntil(async () => (await s.chat()).status === 'queued', 'follow-up to queue')
  const before = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
  expect(before.items.some((i) => i.kind === 'agent' && i.text === 'Second response')).toBe(false)
  await writeFile(path.join(scratch, 'task-finish'), '')
  await waitUntil(async () => {
    const chat = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
    return chat.items.some((i) => i.kind === 'agent' && i.text === 'Second response')
  }, 'queued response after slot frees')
})

test('Stop cancels an unstarted conversation turn; later messages do not execute it', async () => {
  const s = await setup()
  await s.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
  const task = await s.task(
    JSON.stringify({ steps: [{ waitFor: path.join(scratch, 'task-finish') }, { endTurn: true }] }),
  )
  await s.ok('POST', `/tasks/${task.id}/start`)
  const c = await s.ok<Coordinator>('POST', `${s.base}/messages`, {
    agent: 'claude',
    text: JSON.stringify({ steps: [{ say: 'Cancelled response' }, { endTurn: true }] }),
  })
  expect(c.status).toBe('queued')
  await s.ok('POST', `${s.base}/stop`)
  await s.ok('POST', `${s.base}/messages`, {
    text: JSON.stringify({ steps: [{ say: 'Replacement response' }, { endTurn: true }] }),
  })
  await writeFile(path.join(scratch, 'task-finish'), '')
  await waitUntil(async () => {
    const chat = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`).catch(() => undefined)
    return chat?.items.some((i) => i.kind === 'agent' && i.text === 'Replacement response')
  }, 'replacement response')
  const chat = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
  expect(chat.items.some((i) => i.kind === 'agent' && i.text === 'Cancelled response')).toBe(false)
})

test('concurrent first messages share one Coordinator and survive daemon restart', async () => {
  const s = await setup()
  await s.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
  const task = await s.task(
    JSON.stringify({ steps: [{ waitFor: path.join(scratch, 'release') }, { endTurn: true }] }),
  )
  await s.ok('POST', `/tasks/${task.id}/start`)
  await waitUntil(async () => (await s.ok<RunSlots>('GET', '/slots')).working === 1, 'Task slot')
  const inputs = ['First queued message', 'Second queued message']
  const chats = await Promise.all(
    inputs.map((text) =>
      s.ok<Coordinator>('POST', `${s.base}/messages`, { text, agent: 'claude' }),
    ),
  )
  expect(chats[0]?.runId).toBe(chats[1]?.runId)
  await daemon?.stop()
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const reopened = (await client.call('GET', s.base)).body as Coordinator
  expect(reopened.runId).toBe(chats[0]?.runId)
  expect(reopened.status).toBe('queued')
  await writeFile(path.join(scratch, 'release'), '')
  await waitUntil(
    async () => ((await client.call('GET', s.base)).body as Coordinator).started,
    'recovered Coordinator',
  )
  const chat = (await client.call('GET', `/runs/${reopened.runId}/chat`)).body as RunChat
  for (const text of inputs)
    expect(chat.items.some((i) => i.kind === 'human' && i.text.includes(text))).toBe(true)
})

test('failed session resumption can retry in a replacement Run with history and stale tokens refused', async () => {
  const s = await setup()
  const { c, run } = await s.start([
    { say: 'Saved advice' },
    { waitFor: path.join(scratch, 'fail') },
    { exit: 1 },
  ])
  await writeFile(path.join(scratch, 'fail'), '')
  await waitUntil(async () => (await s.chat()).status === 'failed', 'initial failure')
  await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ resumeFails: true }))
  await s.ok('POST', `${s.base}/retry`)
  await waitUntil(async () => (await s.chat()).status === 'failed', 'failed resume')
  await s.ok('POST', `${s.base}/retry`)
  const replaced = await waitUntil(async () => {
    const chat = await s.chat()
    return chat.runId !== c.runId && chat.started ? chat : undefined
  }, 'replacement Run')
  expect(replaced.runIds).toContain(c.runId)
  expect(replaced.status).toBe('working')
  const replacement = api(s.port, s.tokens.issue(replaced.runId))
  expect((await replacement.call('GET', '/coordinator/tasks')).status).toBe(200)
  await s.ok('POST', `${s.base}/messages`, {
    text: JSON.stringify({ steps: [{ run: ['ted', 'coordinator', 'tasks'] }, { endTurn: true }] }),
  })
  await waitUntil(
    async () =>
      (await s.ok<RunChat>('GET', `/runs/${replaced.runId}/chat`)).run.state === 'working',
    'replacement agent turn',
  )
  await replacement.call('POST', `/runs/${replaced.runId}/boundary`)
  await waitUntil(async () => (await s.chat()).status === 'ready', 'replacement settlement')
  expect((await s.ok<RunSlots>('GET', '/slots')).working).toBe(0)
  const replacementChat = await s.ok<RunChat>('GET', `/runs/${replaced.runId}/chat`)
  const reply = replacementChat.items.find((i) => i.kind === 'agent' && i.text.includes('stdout'))
  if (reply?.kind !== 'agent') throw new Error('missing replacement tool response')
  expect(JSON.parse(reply.text).code).toBe(0)

  expect((await run.call('GET', '/coordinator/tasks')).status).toBe(403)
  const history = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
  expect(history.items.some((i) => i.kind === 'agent' && i.text === 'Saved advice')).toBe(true)
})

test('Factory removal deletes Coordinator history, pending work and managed files', async () => {
  const s = await setup()
  const { c, run } = await s.start()
  await s.ok('POST', `/factories/${s.factory.id}/remove`, { key: 'NB', closePullRequests: false })
  expect((await s.client.call('GET', s.base)).status).toBe(404)
  expect((await s.client.call('GET', `/runs/${c.runId}/chat`)).status).toBe(404)
  expect((await run.call('GET', '/coordinator/tasks')).status).toBe(403)
  await expect(
    import('node:fs/promises').then((fs) => fs.stat(path.join(home, 'coordinators', c.runId))),
  ).rejects.toMatchObject({ code: 'ENOENT' })
})

test('reset deletes the conversation and the next message starts a new one', async () => {
  const s = await setup()
  const { c, run } = await s.start()
  await s.ok('POST', `${s.base}/reset`)
  expect(await s.chat()).toBeNull()
  expect((await s.client.call('GET', `/runs/${c.runId}/chat`)).status).toBe(404)
  expect((await run.call('GET', '/coordinator/tasks')).status).toBe(403)
  expect(existsSync(path.join(home, 'coordinators', c.runId))).toBe(false)
  expect((await api(s.port, s.tokens.issue(c.runId)).call('POST', `${s.base}/reset`)).status).toBe(
    403,
  )

  const next = await s.start([{ say: 'A fresh start' }, { endTurn: true }])
  expect(next.c.runId).not.toBe(c.runId)
  expect(next.c.runIds).toEqual([next.c.runId])
  expect(next.c.receipts).toEqual([])
  await s.ok('POST', `${s.base}/reset`)
  await s.ok('POST', `${s.base}/reset`)
  expect(await s.chat()).toBeNull()
})

test('agent health pauses queued responses and sending advice leaves Tasks unchanged', async () => {
  const s = await setup()
  const task = await s.task()
  await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: false }))
  await s.ok('POST', '/agents/health/check')
  const c = await s.ok<Coordinator>('POST', `${s.base}/messages`, {
    agent: 'claude',
    text: JSON.stringify({
      steps: [{ say: 'I recommend discussing priorities first.' }, { endTurn: true }],
    }),
  })
  expect(c.status).toBe('paused')
  expect(c.started).toBe(false)
  await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: true }))
  await s.ok('POST', '/agents/health/check')
  await waitUntil(async () => (await s.chat()).status === 'ready', 'healthy response')
  expect((await s.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)?.stage).toBe('backlog')
  expect((await s.chat()).receipts).toEqual([])
})

test('a pause while working records TED’s continuation as TED’s and keeps the conversation', async () => {
  const s = await setup()
  const { c } = await s.start([{ say: 'Saved advice' }, { waitFor: path.join(scratch, 'finish') }])
  const conversation = () => s.ok<RunChat>('GET', `${s.base}/chat`)
  const continuation = 'Continue the interrupted response using fresh facts'
  await waitUntil(
    async () => (await conversation()).items.some((i) => i.kind === 'agent'),
    'the first reply',
  )
  await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: false }))
  await s.ok('POST', '/agents/health/check')
  await waitUntil(async () => {
    const run = (await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)).run
    return (await s.chat()).status === 'paused' && run.state === 'finished'
  }, 'the paused Coordinator')
  for (const chat of [await conversation(), await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)]) {
    expect(chat.items.filter((i) => i.kind === 'human' && i.text.includes(continuation))).toEqual(
      [],
    )
    expect(chat.items.some((i) => i.kind === 'agent' && i.text === 'Saved advice')).toBe(true)
  }
  expect((await s.chat()).unsentMessages).toEqual([])

  await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: true }))
  await s.ok('POST', '/agents/health/check')
  const replaced = await waitUntil(async () => {
    const chat = await s.chat()
    return chat.runId !== c.runId && chat.started ? chat : undefined
  }, 'the replacement Run')
  const after = await conversation()
  expect(after.run.id).toBe(replaced.runId)
  expect(after.items.filter((i) => i.kind === 'human').map((i) => i.text)).toEqual([
    expect.stringContaining('Saved advice'),
  ])
  expect(after.items.some((i) => i.kind === 'agent' && i.text === 'Saved advice')).toBe(true)
  expect(after.items.filter((i) => i.kind === 'ted' && i.text.includes(continuation))).toHaveLength(
    1,
  )
  expect(after.items.filter((i) => i.kind === 'instructions')).toHaveLength(1)
  const own = await s.ok<RunChat>('GET', `/runs/${replaced.runId}/chat`)
  expect(own.items.filter((i) => i.kind === 'human')).toEqual([])
  expect(await s.ok('GET', '/coordinators')).toEqual([
    { factoryId: s.factory.id, status: (await s.chat()).status },
  ])
})

test('Retry’s continuation shows as TED’s in the resumed Run, never as the human’s', async () => {
  const s = await setup()
  const { c } = await s.start([
    { say: 'Saved advice' },
    { waitFor: path.join(scratch, 'fail') },
    { exit: 1 },
  ])
  await writeFile(path.join(scratch, 'fail'), '')
  await waitUntil(async () => (await s.chat()).status === 'failed', 'the failure')
  await s.ok('POST', `${s.base}/retry`)
  const continuation = 'Please continue the interrupted response'
  const chat = await waitUntil(async () => {
    const chat = await s.ok<RunChat>('GET', `${s.base}/chat`)
    return chat.items.some((i) => i.kind === 'ted' && i.text.includes(continuation))
      ? chat
      : undefined
  }, 'TED’s continuation in the chat')
  expect((await s.chat()).runId).toBe(c.runId)
  expect(chat.items.filter((i) => i.kind === 'human' && i.text.includes(continuation))).toEqual([])
})

test('a message after Stop starts a new Run and the conversation keeps both Runs in order', async () => {
  const s = await setup()
  const { c } = await s.start([{ say: 'First reply' }, { waitFor: path.join(scratch, 'finish') }])
  const conversation = () => s.ok<RunChat>('GET', `${s.base}/chat`)
  await waitUntil(
    async () => (await conversation()).items.some((i) => i.kind === 'agent'),
    'the first reply',
  )
  await s.ok('POST', `${s.base}/stop`)
  await s.ok('POST', `${s.base}/messages`, {
    text: JSON.stringify({ steps: [{ say: 'Second reply' }, { endTurn: true }] }),
  })
  const chat = await waitUntil(async () => {
    const chat = await conversation()
    return chat.items.some((i) => i.kind === 'agent' && i.text === 'Second reply')
      ? chat
      : undefined
  }, 'the second reply')
  expect((await s.chat()).runId).not.toBe(c.runId)
  expect(chat.run.id).toBe((await s.chat()).runId)
  const shown = chat.items.flatMap((i) =>
    i.kind === 'agent'
      ? [i.text]
      : i.kind === 'human'
        ? ['human']
        : i.kind === 'ted'
          ? [i.title]
          : [],
  )
  expect(shown).toEqual(['human', 'First reply', 'New Run', 'human', 'Second reply'])
  expect(new Set(chat.items.map((i) => `${i.kind}:${i.id}`)).size).toBe(chat.items.length)
})

const signIn = async (s: Awaited<ReturnType<typeof setup>>, signedIn: boolean) => {
  await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn }))
  await s.ok('POST', '/agents/health/check')
}
const bubbles = (chat: RunChat) =>
  chat.items.flatMap<Record<string, unknown>>((i) =>
    i.kind === 'human'
      ? [{ human: i.text, sent: i.sent, queued: i.queued, unsent: i.unsent }]
      : i.kind === 'ted'
        ? [{ ted: i.text }]
        : [],
  )

test('a human message queued after Retry is delivered with TED’s continuation and each keeps its author', async () => {
  const s = await setup()
  const { c } = await s.start([
    { say: 'Saved advice' },
    { waitFor: path.join(scratch, 'fail') },
    { exit: 1 },
  ])
  await writeFile(path.join(scratch, 'fail'), '')
  await waitUntil(async () => (await s.chat()).status === 'failed', 'the failure')
  await signIn(s, false)
  await s.ok('POST', `${s.base}/retry`)
  const typed = JSON.stringify({ steps: [{ say: 'Resumed reply' }, { endTurn: true }] })
  await s.ok('POST', `${s.base}/messages`, { text: typed })
  expect((await s.chat()).started).toBe(true)
  await signIn(s, true)
  const conversation = () => s.ok<RunChat>('GET', `${s.base}/chat`)
  const chat = await waitUntil(async () => {
    const chat = await conversation()
    return chat.items.some((i) => i.kind === 'agent' && i.text === 'Resumed reply')
      ? chat
      : undefined
  }, 'the resumed reply')
  expect((await s.chat()).runId).toBe(c.runId)
  expect(bubbles(chat).slice(1)).toEqual([
    { ted: expect.stringContaining('Please continue the interrupted response') },
    { human: typed, sent: true },
  ])
  expect((await s.chat()).unsentMessages).toEqual([])
})

test('two human messages delivered as one resumed turn show as two sent bubbles', async () => {
  const s = await setup()
  const { c } = await s.start([
    { say: 'Saved advice' },
    { waitFor: path.join(scratch, 'fail') },
    { exit: 1 },
  ])
  const first = 'Look at the release Tasks first.'
  const second = JSON.stringify({ steps: [{ say: 'Resumed reply' }, { endTurn: true }] })
  await s.ok('POST', `${s.base}/messages`, { text: first })
  await s.ok('POST', `${s.base}/messages`, { text: second })
  await writeFile(path.join(scratch, 'fail'), '')
  await waitUntil(async () => (await s.chat()).status === 'failed', 'the failure')
  await s.ok('POST', `${s.base}/retry`)
  const chat = await waitUntil(async () => {
    const chat = await s.ok<RunChat>('GET', `${s.base}/chat`)
    return chat.items.some((i) => i.kind === 'agent' && i.text === 'Resumed reply')
      ? chat
      : undefined
  }, 'the resumed reply')
  expect((await s.chat()).runId).toBe(c.runId)
  expect(bubbles(chat).slice(1)).toEqual([
    { human: first, sent: true },
    { human: second, sent: true },
  ])
})

test('an opening prompt that carries two pending messages shows each as its own sent bubble', async () => {
  const s = await setup()
  await signIn(s, false)
  const first = 'Compare the release Tasks.'
  const second = JSON.stringify({ steps: [{ say: 'Both read' }, { endTurn: true }] })
  await s.ok('POST', `${s.base}/messages`, { text: first, agent: 'claude' })
  await s.ok('POST', `${s.base}/messages`, { text: second })
  const conversation = () => s.ok<RunChat>('GET', `${s.base}/chat`)
  expect(bubbles(await conversation())).toEqual([
    { human: first, sent: false, queued: true },
    { human: second, sent: false, queued: true },
  ])
  await signIn(s, true)
  const chat = await waitUntil(async () => {
    const chat = await conversation()
    return chat.items.some((i) => i.kind === 'agent' && i.text === 'Both read') ? chat : undefined
  }, 'the reply')
  expect(bubbles(chat)).toEqual([
    { human: first, sent: true },
    { human: second, sent: true },
  ])
  const own = await s.ok<RunChat>('GET', `/runs/${chat.run.id}/chat`)
  expect(bubbles(own)).toEqual(bubbles(chat))
  expect(own.items.filter((i) => i.kind === 'instructions')).toHaveLength(1)
})

test('disk holds keep Coordinator turns queued until space recovers', async () => {
  let free = 30e9
  const s = await setup({ freeBytes: async () => free, checkEveryMs: 20 })
  free = 1.4e9
  await waitUntil(async () => {
    const banners = await s.ok<{ problem: string }[]>('GET', '/banners')
    return banners.some((b) => b.problem === 'disk-full')
  }, 'disk hold')
  const c = await s.ok<Coordinator>('POST', `${s.base}/messages`, {
    agent: 'claude',
    text: JSON.stringify({ steps: [{ say: 'Space recovered' }, { endTurn: true }] }),
  })
  expect(c.status).toBe('queued')
  expect(c.started).toBe(false)
  free = 30e9
  await waitUntil(async () => (await s.chat()).status === 'ready', 'response after disk recovers')
})

test('the Coordinator CLI reads scoped facts from an actual Run', async () => {
  const s = await setup()
  const task = await s.task('CLI context')
  const { c } = await s.start([{ run: ['ted', 'coordinator', 'tasks'] }, { endTurn: true }])
  await waitUntil(async () => (await s.chat()).status === 'ready', 'CLI response')
  const chat = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
  const reply = chat.items.find((i) => i.kind === 'agent' && i.text.includes('stdout'))
  if (reply?.kind !== 'agent') throw new Error('missing CLI reply')
  const result = JSON.parse(reply.text) as { code: number; stdout: string }
  expect(result.code).toBe(0)
  expect(result.stdout).toContain(task.displayId)
  expect(result.stdout).toContain('TASK CONTEXT')
})

test('deleting the last queued follow-up returns Ready without taking a slot', async () => {
  const s = await setup()
  await s.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
  const { c } = await s.start([{ say: 'First answer' }, { endTurn: true }])
  await waitUntil(async () => (await s.chat()).status === 'ready', 'first answer')
  const task = await s.task(
    JSON.stringify({ steps: [{ waitFor: path.join(scratch, 'release-slot') }, { endTurn: true }] }),
  )
  await s.ok('POST', `/tasks/${task.id}/start`)
  await waitUntil(
    async () => (await s.ok<RunSlots>('GET', '/slots')).working === 1,
    'occupied slot',
  )
  const message = await s.ok<RunMessage>('POST', `/runs/${c.runId}/messages`, {
    text: JSON.stringify({ steps: [{ say: 'Deleted answer' }, { endTurn: true }] }),
  })
  expect((await s.chat()).status).toBe('queued')
  await s.ok('DELETE', `/runs/${c.runId}/messages/${message.id}`)
  expect((await s.chat()).status).toBe('ready')
  expect((await s.ok<RunSlots>('GET', '/slots')).queue.some((q) => q.kind === 'coordinator')).toBe(
    false,
  )
  await writeFile(path.join(scratch, 'release-slot'), '')
  await waitUntil(
    async () => (await s.ok<RunSlots>('GET', '/slots')).working === 0,
    'slot released',
  )
  expect((await s.chat()).status).toBe('ready')
  const chat = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
  expect(chat.items.some((i) => i.kind === 'agent' && i.text === 'Deleted answer')).toBe(false)
  await s.ok('POST', `${s.base}/messages`, {
    text: JSON.stringify({ steps: [{ say: 'Later answer' }, { endTurn: true }] }),
  })
  await waitUntil(async () => {
    const chat = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
    return chat.items.some((i) => i.kind === 'agent' && i.text === 'Later answer')
  }, 'later message still works')
  await waitUntil(async () => (await s.chat()).status === 'ready', 'later answer settlement')
})

test('Stop followed by a message replaces the Run, uses scoped tools and releases its slot', async () => {
  const s = await setup()
  const { c } = await s.start()
  await s.ok('POST', `${s.base}/stop`)
  await s.ok('POST', `${s.base}/messages`, {
    text: JSON.stringify({ steps: [{ run: ['ted', 'coordinator', 'tasks'] }, { endTurn: true }] }),
  })
  const replacement = await waitUntil(async () => {
    const chat = await s.chat()
    return chat.runId !== c.runId && chat.started && chat.status === 'ready' ? chat : undefined
  }, 'new response completes')
  const chat = await s.ok<RunChat>('GET', `/runs/${replacement.runId}/chat`)
  const reply = chat.items.find((i) => i.kind === 'agent' && i.text.includes('stdout'))
  if (reply?.kind !== 'agent') throw new Error('missing scoped tool reply')
  expect(JSON.parse(reply.text).code).toBe(0)
  expect((await s.ok<RunSlots>('GET', '/slots')).working).toBe(0)
})

test('working Coordinator messages share steering’s boundary gate and serialized delivery', async () => {
  const s = await setup()
  await s.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
  const { c } = await s.start([
    { say: 'Before boundary' },
    { waitFor: path.join(scratch, 'boundary') },
    { tool: 'Read' },
    { say: 'After boundary' },
    { waitFor: path.join(scratch, 'finish-turn') },
    { endTurn: true },
  ])
  await waitUntil(async () => {
    const chat = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
    return chat.items.some((i) => i.kind === 'agent' && i.text === 'Before boundary')
  }, 'before boundary')
  const messages = await Promise.all(
    ['First steering message', 'Second steering message'].map((text) =>
      s.ok<RunMessage>('POST', `/runs/${c.runId}/messages`, { text }),
    ),
  )
  const queued = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
  for (const message of messages)
    expect(queued.items.find((i) => i.id === message.id)).toMatchObject({
      kind: 'human',
      queued: true,
      sent: false,
    })
  expect(existsSync(path.join(home, 'runs', c.runId, 'queued'))).toBe(true)
  expect(queued.items.some((i) => i.kind === 'agent' && i.text.startsWith('Read:'))).toBe(false)
  await writeFile(path.join(scratch, 'boundary'), '')
  await waitUntil(async () => {
    const chat = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
    return chat.items.some((i) => i.kind === 'agent' && i.text === 'After boundary')
  }, 'boundary completed')
  const delivered = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
  const agents = delivered.items.filter((i) => i.kind === 'agent').map((i) => i.text)
  for (const message of messages) {
    expect(agents.filter((text) => text === `Read: ${message.text}`)).toHaveLength(1)
    expect(agents.indexOf(`Read: ${message.text}`)).toBeLessThan(agents.indexOf('After boundary'))
    expect(delivered.items.find((i) => i.id === message.id)).toMatchObject({
      kind: 'human',
      sent: true,
    })
  }
  expect(existsSync(path.join(home, 'runs', c.runId, 'queued'))).toBe(false)
  expect((await s.ok<RunSlots>('GET', '/slots')).working).toBe(1)
  await writeFile(path.join(scratch, 'finish-turn'), '')
  await waitUntil(async () => (await s.chat()).status === 'ready', 'response finishes')
  expect((await s.ok<RunSlots>('GET', '/slots')).working).toBe(0)
})

test('tell posts a Comment marked as sent through the Coordinator and delivers it to the Task Lead', async () => {
  const s = await setup(),
    boundary = path.join(scratch, 'lead-boundary'),
    { task, leadRunId, lead } = await s.led({ waitFor: boundary }, { tool: 'Read' }, hold()),
    { run } = await s.start()
  const input = {
    operation: 'tell-1',
    version: await version(run, task.id),
    message: 'Wait for the queued reviewer; do not start another one.',
  }
  const told = await run.call('POST', `/coordinator/tasks/${task.id}/tell`, input)
  expect(told.status).toBe(200)
  expect(told.body).toMatchObject({
    operation: 'tell',
    taskId: task.id,
    text: `Told ${task.displayId}’s Task Lead`,
  })
  const posted = (await s.comments(task.id)).filter((c) => c.body.startsWith(coordinatorLine))
  expect(posted).toHaveLength(1)
  expect(posted[0]).toMatchObject({
    kind: 'note',
    author: { kind: 'human' },
    body: `${coordinatorLine}\n\n${input.message}`,
  })
  await writeFile(boundary, '')
  await waitUntil(
    async () =>
      (await s.comments(task.id)).find((c) => c.id === posted[0]?.id)?.delivered?.runId ===
      leadRunId,
    'the Comment to reach the Task Lead',
  )
  await waitUntil(async () => {
    const heard = JSON.stringify(await s.ok<RunChat>('GET', `/runs/${leadRunId}/chat`))
    return heard.includes(coordinatorLine) && heard.includes(input.message)
  }, 'the Task Lead to read the message')

  expect((await run.call('POST', `/coordinator/tasks/${task.id}/tell`, input)).body).toEqual(
    told.body,
  )
  const reused = await run.call('POST', `/coordinator/tasks/${task.id}/tell`, {
    ...input,
    message: 'Something else',
  })
  expect(reused.status).toBe(409)
  expect((await s.comments(task.id)).filter((c) => c.author.kind === 'human')).toHaveLength(1)
  expect((await s.chat()).receipts.map((r) => r.id)).toEqual(['tell-1'])

  expect(
    (
      await run.call('POST', `/coordinator/tasks/${task.id}/tell`, {
        ...input,
        operation: 'empty',
        message: ' ',
      })
    ).status,
  ).toBe(400)
  for (const kind of ['tell', 'answer', 'resume'])
    expect(
      (await lead.call('POST', `/coordinator/tasks/${task.id}/${kind}`, { ...input, request: 'x' }))
        .status,
      kind,
    ).toBe(403)

  const backlog = await s.task('Unstarted')
  const quiet = await run.call('POST', `/coordinator/tasks/${backlog.id}/tell`, {
    operation: 'tell-backlog',
    version: await version(run, backlog.id),
    message: 'Read this when you start.',
  })
  expect((quiet.body as CoordinatorReceipt).text).toContain(
    `Left a Comment on ${backlog.displayId}`,
  )

  await s.ok('POST', `/tasks/${backlog.id}/archive`)
  const archived = await run.call('POST', `/coordinator/tasks/${backlog.id}/tell`, {
    operation: 'tell-archived',
    version: await version(run, backlog.id),
    message: 'Too late.',
  })
  expect(archived.status).toBe(409)
  expect((archived.body as { error: string }).error).toContain('not archived and not Done')
})

test('answer closes a Task Lead’s open question, which leaves the Inbox', async () => {
  const s = await setup(),
    { task, lead } = await s.led(hold()),
    other = await s.led(hold()),
    { run } = await s.start()
  const ask = async (who: Api, id: string, body: string) =>
    (await who.call('POST', `/tasks/${id}/comments`, { body, choices: ['Wait', 'Start another'] }))
      .body as Comment
  const question = await ask(lead, task.id, 'My reviewer is queued. What should I do?')
  const foreign = await ask(other.lead, other.task.id, 'Same question on another Task')
  const note = (await lead.call('POST', `/tasks/${task.id}/comments`, { body: 'A note' }))
    .body as Comment
  expect(await s.waitingIds()).toContain(question.id)
  const answer = async (body: Record<string, unknown>) =>
    run.call('POST', `/coordinator/tasks/${task.id}/answer`, {
      version: await version(run, task.id),
      ...body,
    })

  const wrongChoice = await answer({ operation: 'bad', request: question.id, choice: 'Skip it' })
  expect(wrongChoice.status).toBe(409)
  expect((await answer({ operation: 'other', request: foreign.id, choice: 'Wait' })).status).toBe(
    409,
  )
  expect(
    (await answer({ operation: 'gone', request: 'no-such-comment', choice: 'Wait' })).status,
  ).toBe(409)
  expect((await answer({ operation: 'note', request: note.id, message: 'Noted' })).status).toBe(403)
  expect((await answer({ operation: 'nothing', request: question.id })).status).toBe(400)
  expect(await s.waitingIds()).toContain(question.id)

  const input = {
    operation: 'answer-1',
    version: await version(run, task.id),
    request: question.id,
    choice: 'Wait',
    message: 'The reviewer starts when a slot frees.',
  }
  const answered = await run.call('POST', `/coordinator/tasks/${task.id}/answer`, input)
  expect(answered.status).toBe(200)
  expect(answered.body).toMatchObject({
    operation: 'answer',
    text: expect.stringContaining(`Answered ${task.displayId}’s question with “Wait” · was intake`),
  })
  expect((await s.comments(task.id)).find((c) => c.id === question.id)?.answer).toMatchObject({
    kind: 'answered',
    choice: 'Wait',
    text: `${coordinatorLine}\n\n${input.message}`,
  })
  const waiting = await s.waitingIds()
  expect(waiting).not.toContain(question.id)
  expect(waiting).toContain(foreign.id)

  expect((await run.call('POST', `/coordinator/tasks/${task.id}/answer`, input)).body).toEqual(
    answered.body,
  )
  expect(
    (
      await run.call('POST', `/coordinator/tasks/${task.id}/answer`, {
        ...input,
        choice: 'Start another',
      })
    ).status,
  ).toBe(409)
  const again = await answer({ operation: 'again', request: question.id, choice: 'Wait' })
  expect(again.status).toBe(409)
  expect((again.body as { error: string }).error).toContain('already closed')
})

test('answer approves a Gate request or asks for changes, and refuses permission prompts', async () => {
  await commitToOrigin(scratch, { 'app.txt': 'one\ntwo\nthree\n' })
  const s = await setup(undefined, 'version: 1\norder: [intake, design, work, merge]\n')
  const briefFile = path.join(scratch, 'brief.md')
  await writeFile(
    briefFile,
    '## Goal\n\nEdit notes offline.\n\n## Decisions so far\n\n- Keep both copies.\n\n## Current state\n\nNothing built yet.\n\n## Open questions\n\nNone.\n\n## Next step\n\nDesign the merge view.\n',
  )
  const advance = { run: ['ted', 'outcome', 'advance'] }
  const gated = await s.led(
    {
      everyMessage: [
        { run: ['ted', 'brief', 'write', '--file', briefFile] },
        advance,
        { endTurn: true },
      ],
    },
    advance,
    { endTurn: true },
  )
  const prompted = await s.led(
    {
      permission: {
        tool: 'Bash',
        input: { command: 'npm install', description: 'Install' },
        description: 'Install',
      },
    },
    { endTurn: true },
  )
  const request = (id: string, wanted: (c: Comment) => boolean, what: string) =>
    waitUntil(async () => (await s.comments(id)).find(wanted), what)
  const openGate = (c: Comment) => c.gate !== undefined && c.answer === undefined
  const gate = await request(gated.task.id, openGate, 'a Gate request')
  const permission = await request(
    prompted.task.id,
    (c) => c.kind === 'permission',
    'a permission request',
  )
  const worktree = await waitUntil(
    async () =>
      (await s.ok<Task[]>('GET', '/tasks')).find((t) => t.id === gated.task.id)?.repos[0]?.worktree,
    'the worktree',
  )
  await writeFile(path.join(worktree, 'app.txt'), 'one\nTWO\nthree\n')
  await s.ok('POST', `/tasks/${gated.task.id}/line-comments`, {
    repo: 'widgets',
    path: 'app.txt',
    from: { new: 2 },
    body: 'An unfinished review note',
  })
  const unsent = async () =>
    (await s.ok<LineComment[]>('GET', `/tasks/${gated.task.id}/line-comments`)).filter(
      (c) => c.sent === undefined,
    )
  const { run } = await s.start()
  const answer = async (task: Task, body: Record<string, unknown>) =>
    run.call('POST', `/coordinator/tasks/${task.id}/answer`, {
      version: await version(run, task.id),
      ...body,
    })
  const read = unpack<CoordinatorTask>(
    (await run.call('GET', `/coordinator/tasks/${gated.task.id}`)).body,
  )
  expect(read.openRequests.find((r) => r.id === gate.id)?.coordinatorMayAnswer).toBe(
    'approve or request changes',
  )

  const refused = await answer(prompted.task, {
    operation: 'refused-permission',
    request: permission.id,
    decision: 'approve',
  })
  expect(refused.status).toBe(403)
  expect(
    (await s.comments(prompted.task.id)).find((c) => c.id === permission.id)?.answer,
  ).toBeUndefined()

  const words = await answer(gated.task, {
    operation: 'words',
    request: gate.id,
    message: 'Looks fine',
  })
  expect(words.status).toBe(400)
  expect(
    (await answer(gated.task, { operation: 'bare', request: gate.id, decision: 'request-changes' }))
      .status,
  ).toBe(400)
  expect(await s.waitingIds()).toContain(gate.id)

  const changes = await answer(gated.task, {
    operation: 'changes',
    request: gate.id,
    decision: 'request-changes',
    message: 'Show both copies side by side.',
  })
  expect(changes.status).toBe(200)
  expect((changes.body as CoordinatorReceipt).text).toContain(
    `Requested changes on ${gated.task.displayId}’s Gate request`,
  )
  const asked = (await s.comments(gated.task.id)).find((c) => c.id === gate.id)
  expect(asked?.answer).toEqual({
    kind: 'changes-requested',
    at: expect.any(String),
    text: `${coordinatorLine}\n\nShow both copies side by side.`,
  })
  expect(asked?.lineComments ?? []).toEqual([])
  expect(await unsent()).toHaveLength(1)

  const second = await request(
    gated.task.id,
    (c) => openGate(c) && c.id !== gate.id,
    'a second Gate request',
  )
  const approved = await answer(gated.task, {
    operation: 'approve',
    request: second.id,
    decision: 'approve',
  })
  expect(approved.status).toBe(200)
  const receipt = approved.body as CoordinatorReceipt
  expect(receipt.text).toContain(`Approved ${gated.task.displayId}’s Gate request`)
  expect(receipt.before?.stage).toBe('design')
  expect(receipt.after?.stage).not.toBe('design')
  expect((await s.comments(gated.task.id)).find((c) => c.id === second.id)?.answer).toMatchObject({
    kind: 'approved',
    text: coordinatorLine,
  })
  expect(await s.waitingIds()).not.toContain(second.id)
  expect(await unsent()).toHaveLength(1)
})

test('answer answers a Clarify round and a size check', async () => {
  const s = await setup(undefined, 'version: 1\norder: [intake, clarify, work]\n')
  const roundFile = path.join(scratch, 'round.json')
  await writeFile(
    roundFile,
    JSON.stringify({
      title: 'Sync · 1 question',
      questions: [{ question: 'How long offline before a warning?', recommended: '7 days' }],
    }),
  )
  const advance = { run: ['ted', 'outcome', 'advance'] }
  const asking = await s.led(
    advance,
    { run: ['ted', 'clarify', 'depth', 'few', 'one question settles it'] },
    { run: ['ted', 'ask', '--round', roundFile] },
    { endTurn: true },
  )
  const sizing = await s.led(
    advance,
    {
      run: [
        'ted',
        'clarify',
        'too-big',
        '--settle',
        'Which piece ships first',
        'It touches storage and sync.',
      ],
    },
    { endTurn: true },
  )
  const request = (id: string, wanted: (c: Comment) => boolean, what: string) =>
    waitUntil(async () => (await s.comments(id)).find(wanted), what)
  const round = await request(asking.task.id, (c) => c.kind === 'round', 'a round')
  const sizeCheck = await request(sizing.task.id, (c) => c.sizeCheck !== undefined, 'a size check')
  const { run } = await s.start()
  const answer = async (task: Task, body: Record<string, unknown>) =>
    run.call('POST', `/coordinator/tasks/${task.id}/answer`, {
      version: await version(run, task.id),
      ...body,
    })
  const read = unpack<CoordinatorTask>(
    (await run.call('GET', `/coordinator/tasks/${asking.task.id}`)).body,
  )
  expect(read.openRequests.find((r) => r.id === round.id)).toMatchObject({
    coordinatorMayAnswer: 'round answers',
    questions: [{ question: 'How long offline before a warning?', recommended: '7 days' }],
  })

  expect(
    (await answer(asking.task, { operation: 'words', request: round.id, message: '14 days' }))
      .status,
  ).toBe(400)
  expect(
    (
      await answer(asking.task, {
        operation: 'short',
        request: round.id,
        answers: [{ answer: '14 days' }, { answer: 'Extra' }],
      })
    ).status,
  ).toBe(400)
  const answered = await answer(asking.task, {
    operation: 'round',
    request: round.id,
    answers: [{ answer: '14 days', note: 'People travel.' }],
  })
  expect(answered.status).toBe(200)
  expect((answered.body as CoordinatorReceipt).text).toContain(
    `Answered ${asking.task.displayId}’s Clarify round “Sync · 1 question”`,
  )
  expect((await s.comments(asking.task.id)).find((c) => c.id === round.id)?.answer).toMatchObject({
    kind: 'answered',
    answers: [{ answer: '14 days', note: 'People travel.', changed: true }],
    text: coordinatorLine,
  })

  expect(
    (await answer(sizing.task, { operation: 'size-words', request: sizeCheck.id, message: 'Go' }))
      .status,
  ).toBe(400)
  const sized = await answer(sizing.task, {
    operation: 'size',
    request: sizeCheck.id,
    choice: sizeChoices.grill,
  })
  expect(sized.status).toBe(200)
  expect(
    (await s.comments(sizing.task.id)).find((c) => c.id === sizeCheck.id)?.answer,
  ).toMatchObject({ kind: 'answered', choice: sizeChoices.grill, text: coordinatorLine })
  const waiting = await s.waitingIds()
  expect(waiting).not.toContain(round.id)
  expect(waiting).not.toContain(sizeCheck.id)
})

test('resume queues a stopped Task again and refuses one that isn’t stopped', async () => {
  const s = await setup(),
    { task, leadRunId } = await s.led(hold()),
    { run } = await s.start()
  const resume = async (operation: string, at?: string) =>
    run.call('POST', `/coordinator/tasks/${task.id}/resume`, {
      operation,
      version: at ?? (await version(run, task.id)),
    })
  const current = async () => (await s.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)

  const running = await resume('too-early')
  expect(running.status).toBe(409)
  expect((running.body as { error: string }).error).toContain('isn’t stopped')

  await s.ok('POST', `/tasks/${task.id}/stop`)
  expect((await current())?.status?.kind).toBe('stopped')
  const stoppedAt = await version(run, task.id)
  const resumed = await resume('resume-1', stoppedAt)
  expect(resumed.status).toBe(200)
  expect(resumed.body).toMatchObject({
    operation: 'resume',
    taskId: task.id,
    text: expect.stringContaining(`Resumed ${task.displayId}`),
  })
  expect((await current())?.status?.kind).not.toBe('stopped')
  await waitUntil(async () => {
    const lead = (await current())?.leadRunId
    return lead !== undefined && lead !== leadRunId
  }, 'a new Task Lead Run')
  expect((await s.comments(task.id)).filter((c) => c.author.kind === 'human')).toEqual([])
  expect((await resume('resume-1', stoppedAt)).body).toEqual(resumed.body)
})

test('the Coordinator CLI tells and answers with a message argument and never reads a file', async () => {
  const s = await setup(),
    quiet = await s.task('Unstarted'),
    { task, lead } = await s.led(hold())
  const question = (
    await lead.call('POST', `/tasks/${task.id}/comments`, {
      body: 'My reviewer is queued. What should I do?',
      choices: ['Wait', 'Start another'],
    })
  ).body as Comment
  const release = path.join(scratch, 'first-turn')
  const { c, run } = await s.start([{ waitFor: release }, { endTurn: true }])
  const versions = { quiet: await version(run, quiet.id), task: await version(run, task.id) }
  await writeFile(release, '')
  await waitUntil(async () => (await s.chat()).status === 'ready', 'first turn to end')
  const common = ['--message', 'Wait for the queued reviewer.', '--operation']
  await s.ok('POST', `${s.base}/messages`, {
    text: JSON.stringify({
      steps: [
        {
          run: [
            'ted',
            'coordinator',
            'tell',
            quiet.id,
            ...common,
            'cli-tell',
            '--version',
            versions.quiet,
          ],
        },
        {
          run: [
            'ted',
            'coordinator',
            'answer',
            task.id,
            '--request',
            question.id,
            '--choice',
            'Wait',
            ...common,
            'cli-answer',
            '--version',
            versions.task,
          ],
        },
        { endTurn: true },
      ],
    }),
  })
  await waitUntil(async () => {
    const chat = await s.chat()
    return chat.receipts.length === 2 && chat.status === 'ready'
  }, 'both CLI actions')
  const chat = await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)
  const results = chat.items.flatMap((i) =>
    i.kind === 'agent' && i.text.includes('stdout')
      ? [JSON.parse(i.text) as { code: number; stderr: string }]
      : [],
  )
  expect(results.map((r) => r.code)).toEqual([0, 0])
  expect((await s.comments(quiet.id)).map((c) => c.body)).toEqual([
    `${coordinatorLine}\n\nWait for the queued reviewer.`,
  ])
  expect((await s.comments(task.id)).find((c) => c.id === question.id)?.answer).toMatchObject({
    kind: 'answered',
    choice: 'Wait',
    text: `${coordinatorLine}\n\nWait for the queued reviewer.`,
  })

  const secret = path.join(scratch, 'secret.txt')
  await writeFile(secret, 'private key')
  await s.ok('POST', `${s.base}/messages`, {
    text: JSON.stringify({
      steps: [
        {
          run: [
            'ted',
            'coordinator',
            'tell',
            quiet.id,
            '--message-file',
            secret,
            '--operation',
            'cli-file',
            '--version',
            versions.quiet,
          ],
        },
        { endTurn: true },
      ],
    }),
  })
  const refused = await waitUntil(async () => {
    const items = (await s.ok<RunChat>('GET', `/runs/${c.runId}/chat`)).items
    const ran = items.filter((i) => i.kind === 'agent' && i.text.includes('stdout'))
    const last = ran[2]
    return last?.kind === 'agent' ? (JSON.parse(last.text) as { code: number }) : undefined
  }, 'the file option to be refused')
  expect(refused.code).not.toBe(0)
  await waitUntil(async () => (await s.chat()).status === 'ready', 'refusal turn to end')
  expect((await s.chat()).receipts).toHaveLength(2)
  expect(JSON.stringify(await s.comments(quiet.id))).not.toContain('private key')
})

test('tell and answer cap the message, remove secrets and leave line comment drafts unsent', async () => {
  await commitToOrigin(scratch, { 'app.txt': 'one\ntwo\nthree\n' })
  const s = await setup(),
    { task, lead } = await s.led(hold())
  const worktree = await waitUntil(
    async () =>
      (await s.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)?.repos[0]?.worktree,
    'the worktree',
  )
  await writeFile(path.join(worktree, 'app.txt'), 'one\nTWO\nthree\n')
  await s.ok('POST', `/tasks/${task.id}/line-comments`, {
    repo: 'widgets',
    path: 'app.txt',
    from: { new: 2 },
    body: 'An unfinished review note',
  })
  const unsent = async () =>
    (await s.ok<LineComment[]>('GET', `/tasks/${task.id}/line-comments`)).filter(
      (c) => c.sent === undefined,
    )
  expect(await unsent()).toHaveLength(1)
  const question = (
    await lead.call('POST', `/tasks/${task.id}/comments`, {
      body: 'My reviewer is queued. What should I do?',
      choices: ['Wait', 'Start another'],
    })
  ).body as Comment
  const { run } = await s.start()

  const long = await run.call('POST', `/coordinator/tasks/${task.id}/tell`, {
    operation: 'long',
    version: await version(run, task.id),
    message: 'x'.repeat(8001),
  })
  expect(long.status).toBe(400)
  expect((long.body as { error: string }).error).toContain('8000 characters')

  const told = await run.call('POST', `/coordinator/tasks/${task.id}/tell`, {
    operation: 'tell-secret',
    version: await version(run, task.id),
    message: 'Use ghp_abcdefghijklmnopqrstuvwxyz0123 to push.',
  })
  expect(told.status).toBe(200)
  const answered = await run.call('POST', `/coordinator/tasks/${task.id}/answer`, {
    operation: 'answer-secret',
    version: await version(run, task.id),
    request: question.id,
    choice: 'Wait',
    message: 'The key is sk-abcdefghijklmnopqrstuvwxyz0123.',
  })
  expect(answered.status).toBe(200)

  const comments = await s.comments(task.id)
  const posted = comments.find((c) => c.author.kind === 'human')
  expect(posted?.body).toBe(`${coordinatorLine}\n\nUse [redacted] to push.`)
  expect(posted?.lineComments ?? []).toEqual([])
  const answer = comments.find((c) => c.id === question.id)?.answer
  expect(answer).toMatchObject({ text: `${coordinatorLine}\n\nThe key is [redacted].` })
  expect(JSON.stringify(comments)).not.toContain('An unfinished review note')
  expect(JSON.stringify(await s.chat())).not.toContain('ghp_abcdefghij')
  expect(await unsent()).toHaveLength(1)
})

test.each(['general', 'Validate'])(
  'answer resolves a %s failure decision and leaves line comment drafts unsent',
  async (stage) => {
    await commitToOrigin(scratch, { 'app.txt': 'one\ntwo\nthree\n' })
    const workflow =
      stage === 'Validate' ? 'version: 1\norder: [intake, work, validate, review]\n' : undefined
    const s = await setup(undefined, workflow),
      { task, leadRunId, lead } = await s.led(hold())
    const { run } = await s.start()
    const worktree = await waitUntil(
      async () =>
        (await s.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)?.repos[0]?.worktree,
      'the worktree',
    )
    await writeFile(path.join(worktree, 'app.txt'), 'one\nTWO\nthree\n')
    const post = async <T>(route: string, body: unknown = {}) => {
      const res = await lead.call('POST', `/tasks/${task.id}${route}`, body)
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300)
      return res.body as T
    }
    if (stage === 'Validate') {
      await post('/outcome', { outcome: 'advance' })
      await post('/outcome', { outcome: 'advance' })
    }
    const context =
      stage === 'Validate' ? await post<{ id: string }>('/failure-contexts') : undefined
    const failure = await post<{ id: string }>('/failures', {
      source: { kind: 'finding', runId: leadRunId, finding: 'A flaky test' },
      evidence: 'Fails on main too',
      ...(context && { contextId: context.id }),
    })
    await post(`/failures/${failure.id}/assessments`, {
      assessment: 'unrelated',
      recommendation:
        stage === 'Validate' ? 'Accept for this context' : 'No longer applicable to this Task',
    })
    const asked = await post<{ decisions: { commentId: string }[] }>(
      `/failures/${failure.id}/decision`,
    )
    const requestId = asked.decisions.at(-1)?.commentId ?? ''
    await s.ok('POST', `/tasks/${task.id}/line-comments`, {
      repo: 'widgets',
      path: 'app.txt',
      from: { new: 2 },
      body: 'An unfinished review note',
    })
    const unsent = async () =>
      (await s.ok<LineComment[]>('GET', `/tasks/${task.id}/line-comments`)).filter(
        (c) => c.sent === undefined,
      )
    const read = unpack<CoordinatorTask>(
      (await run.call('GET', `/coordinator/tasks/${task.id}`)).body,
    )
    expect(read.openRequests.find((r) => r.id === requestId)?.coordinatorMayAnswer).toBe(
      'with a choice',
    )
    const choice = stage === 'Validate' ? 'Accept this failure' : 'No longer applicable'
    const answered = await run.call('POST', `/coordinator/tasks/${task.id}/answer`, {
      operation: 'resolve-failure',
      version: read.version,
      request: requestId,
      choice,
    })
    expect(answered.status, JSON.stringify(answered.body)).toBe(200)
    const comment = (await s.comments(task.id)).find((c) => c.id === requestId)
    expect(comment?.answer).toMatchObject({ kind: 'answered', choice })
    expect(comment?.lineComments ?? []).toEqual([])
    expect(await unsent()).toHaveLength(1)
  },
)

test('answer gives a choice on TED’s idle question, and refuses free text alone', async () => {
  const s = await setup(undefined, undefined, 100)
  const { task } = await s.led(
    { say: 'Templates are wired in.' },
    { endTurn: true },
    { everyMessage: [{ say: 'I’ll check the empty template next.' }, { endTurn: true }] },
  )
  const idle = await waitUntil(
    async () => (await s.comments(task.id)).find((c) => c.kind === 'question'),
    'TED to ask about the idle Task Lead',
  )
  expect(idle).toMatchObject({ author: { kind: 'ted' }, choices: ['Nudge again'] })
  const { run } = await s.start()

  const list = unpack<{
    now: string
    tasks: { id: string; openRequests?: CoordinatorRequest[] }[]
  }>((await run.call('GET', '/coordinator/tasks')).body)
  expect(Date.parse(list.now)).toBeGreaterThanOrEqual(Date.parse(idle.createdAt))
  expect(list.tasks.find((t) => t.id === task.id)?.openRequests).toEqual([
    {
      id: idle.id,
      kind: 'question',
      askedBy: 'ted',
      stage: idle.stage,
      title: 'The Task Lead stopped without saying why',
      text: idle.body,
      choices: ['Nudge again'],
      createdAt: idle.createdAt,
      coordinatorMayAnswer: 'with a choice',
    },
  ])
  const read = unpack<CoordinatorTask>(
    (await run.call('GET', `/coordinator/tasks/${task.id}`)).body,
  )
  expect(read.openRequests.map((r) => r.id)).toEqual([idle.id])

  const answer = async (body: Record<string, unknown>) =>
    run.call('POST', `/coordinator/tasks/${task.id}/answer`, {
      version: await version(run, task.id),
      request: idle.id,
      ...body,
    })
  const words = await answer({ operation: 'words', message: 'Carry on with the template.' })
  expect(words.status).toBe(400)
  expect((words.body as { error: string }).error).toContain('one of its choices')
  expect((await answer({ operation: 'other', choice: 'Stop it' })).status).toBe(409)
  expect((await s.comments(task.id)).find((c) => c.id === idle.id)?.answer).toBeUndefined()

  const nudged = await answer({ operation: 'nudge', choice: 'Nudge again' })
  expect(nudged.status).toBe(200)
  const receipt = nudged.body as CoordinatorReceipt
  expect(receipt.text).toContain(
    `Answered ${task.displayId}’s question “The Task Lead stopped without saying why” with “Nudge again” · was `,
  )
  expect(receipt.text).toContain(' · now ')
  expect((await s.comments(task.id)).find((c) => c.id === idle.id)?.answer).toMatchObject({
    kind: 'answered',
    choice: 'Nudge again',
    text: coordinatorLine,
  })
  expect(await s.waitingIds()).not.toContain(idle.id)
})

test('answer gives Try again on Validate’s send-back limit; the receipt shows the Stage change', async () => {
  await commitToOrigin(scratch, { '.gitignore': 'stub-*\n' })
  const s = await setup(
    undefined,
    [
      'version: 1',
      'order: [intake, work, validate]',
      'stages:',
      '  validate:',
      '    max_back: 1',
      '    checks:',
      '      - { name: Tests, run: "echo nope; exit 1" }',
      '',
    ].join('\n'),
  )
  const { task, lead } = await s.led({ endTurn: true })
  const ready = await waitUntil(async () => {
    const current = (await s.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)
    return current?.runs[0]?.state === 'idle' && current.repos[0] ? current : undefined
  }, 'Task Lead ready')
  const repo = ready.repos[0]
  if (!repo) throw new Error('missing worktree')
  await writeFile(path.join(repo.worktree, 'a.txt'), 'implemented\n')
  const outcome = async (body: unknown) => {
    const response = await lead.call('POST', `/tasks/${task.id}/outcome`, body)
    expect(response.status, JSON.stringify(response.body)).toBe(200)
  }
  await outcome({ outcome: 'advance' })
  for (let round = 1; round <= 2; round++) {
    await outcome({ outcome: 'advance' })
    const failure = await waitUntil(async () => {
      const cases = await s.ok<FailureCase[]>('GET', `/tasks/${task.id}/failures`)
      return cases.length === round
        ? cases.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)
        : undefined
    }, 'failed Check recorded for diagnosis')
    const assessed = await lead.call(
      'POST',
      `/tasks/${task.id}/failures/${failure.id}/assessments`,
      {
        assessment: 'regression',
        recommendation: 'The failed fixture Check is caused by this Task; repair it in Work.',
      },
    )
    expect(assessed.status, JSON.stringify(assessed.body)).toBe(200)
    await outcome({ outcome: 'back', to: 'work', findings: 'Repair the failed fixture Check.' })
  }
  const limit = await waitUntil(
    async () => (await s.comments(task.id)).find((c) => c.kind === 'question'),
    'TED to ask about the send-back limit',
    40_000,
  )
  expect(limit).toMatchObject({
    author: { kind: 'ted' },
    title: 'Validate has sent this Task back 1 time, its limit',
    choices: ['Try again', 'Move to Done anyway'],
  })
  const stage = async () =>
    (await s.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)?.stage
  expect(await stage()).toBe('validate')
  const { run } = await s.start()
  const again = await run.call('POST', `/coordinator/tasks/${task.id}/answer`, {
    operation: 'try-again',
    version: await version(run, task.id),
    request: limit.id,
    choice: 'Try again',
  })
  expect(again.status).toBe(200)
  const receipt = again.body as CoordinatorReceipt
  expect(receipt.text).toContain('with “Try again” · was validate')
  expect(receipt.text).toContain(' · now work')
  expect(receipt.before?.stage).toBe('validate')
  expect(receipt.after?.stage).toBe('work')
  expect((await s.comments(task.id)).find((c) => c.id === limit.id)?.answer).toMatchObject({
    kind: 'answered',
    choice: 'Try again',
    text: coordinatorLine,
  })
})
