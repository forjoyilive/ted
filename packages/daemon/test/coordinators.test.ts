import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type Coordinator,
  type CoordinatorTask,
  type Factory,
  type RunChat,
  type RunSlots,
  readDaemonInfo,
  type Task,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import {
  api,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
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
async function setup(disk?: { freeBytes: () => Promise<number>; checkEveryMs: number }) {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    ...(disk && { disk }),
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
  return { port, client, ok, factory, base, chat, tokens, start, task }
}
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
