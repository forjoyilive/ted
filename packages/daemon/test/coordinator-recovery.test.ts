import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type Coordinator,
  type CoordinatorTask,
  type Factory,
  type Plan,
  type PlanDetail,
  type RunChat,
  type RunMessage,
  type RunSlots,
  type Task,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, expect, expectTypeOf, test } from 'vitest'
import type { DaemonWrappers } from '../src/daemon.ts'
import type { MakeDirectory } from '../src/files.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import type { AgentsArea } from '../src/store/agents.ts'
import { openStore, type TedStore } from '../src/store/index.ts'
import {
  api,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  stubCodexPath,
  waitUntil,
} from './helpers.ts'

expectTypeOf<TedStore>().toExtend<AgentsArea>()

const pauses = {
  closing: undefined as (() => void) | undefined,
  runFolder: undefined as (() => Promise<void>) | undefined,
  folder: undefined as (() => Promise<void>) | undefined,
  defaults: undefined as (() => Promise<void>) | undefined,
  removal: undefined as (() => Promise<void>) | undefined,
  resume: undefined as (() => Promise<void>) | undefined,
  started: undefined as (() => Promise<void>) | undefined,
  resumed: undefined as (() => Promise<void>) | undefined,
  dispatch: undefined as (() => Promise<void>) | undefined,
  dispatched: undefined as (() => Promise<void>) | undefined,
  persisted: undefined as (() => Promise<void>) | undefined,
  dispatchPhase: undefined as string | undefined,
}

const pausingMkdir: MakeDirectory = async (dir, options) => {
  if (/\/coordinators\/[a-f0-9-]{36}$/.test(dir)) await pauses.folder?.()
  const result = await mkdir(dir, options)
  if (/\/runs\/[a-f0-9-]{36}$/.test(dir)) await pauses.runFolder?.()
  return result
}

const pausing: DaemonWrappers = {
  coordinators: (coordinators) => ({
    ...coordinators,
    close: () => {
      const result = coordinators.close()
      pauses.closing?.()
      return result
    },
  }),
  workflows: (workflows) => ({
    ...workflows,
    resolve: async (...input) => {
      const result = await workflows.resolve(...input)
      await pauses.defaults?.()
      return result
    },
  }),
  plans: (plans) => ({
    ...plans,
    removeFactory: async (...input) => {
      await plans.removeFactory(...input)
      await pauses.removal?.()
    },
  }),
  runs: (runs, store) => ({
    ...runs,
    start: async (...input) => {
      const result = await runs.start(...input)
      await pauses.started?.()
      return result
    },
    revive: async (...input) => {
      await pauses.resume?.()
      const result = await runs.revive(...input)
      await pauses.resumed?.()
      return result
    },
    dispatch: async (...input) => {
      await pauses.dispatch?.()
      pauses.dispatchPhase = store.coordinators.forRun(input[0])?.phase
      const result = await runs.dispatch(...input)
      await pauses.dispatched?.()
      return result
    },
  }),
  store: (store) => {
    const persisted = store.persisted
    store.persisted = async () => {
      await persisted()
      if (new Error().stack?.includes('/runs/steering.ts:')) await pauses.persisted?.()
    }
    return store
  },
}

let home: string, scratch: string, cleanup: () => Promise<void>, daemon: RunningDaemon | undefined
const releases: (() => void)[] = []
beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-coordinator-recovery-'))
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  pauses.closing = undefined
  pauses.runFolder = undefined
  pauses.folder = undefined
  pauses.defaults = undefined
  pauses.removal = undefined
  pauses.resume = undefined
  pauses.started = undefined
  pauses.resumed = undefined
  pauses.dispatch = undefined
  pauses.dispatched = undefined
  pauses.persisted = undefined
  pauses.dispatchPhase = undefined
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})
function pause(at: Exclude<keyof typeof pauses, 'dispatchPhase'>) {
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  pauses[at] = async () => {
    entered.resolve()
    await gate.promise
  }
  releases.push(() => gate.resolve())
  return {
    entered: entered.promise,
    release: () => {
      pauses[at] = undefined
      gate.resolve()
    },
  }
}
async function setup(runs?: { inputAckMs: number }) {
  const origin = await makeOriginRepo(scratch)
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    codexBin: stubCodexPath,
    ...(runs && { runs }),
    wrap: pausing,
    mkdir: pausingMkdir,
  })
  let client = api(daemon.port, { appKey: daemon.appToken })
  async function call<T>(method: string, route: string, body?: unknown): Promise<T> {
    const result = await client.call(method, route, body)
    if (result.status >= 300) throw new Error(`${route}: ${JSON.stringify(result)}`)
    return result.body as T
  }
  const factory = await call<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const chats = `/factories/${factory.id}/coordinator-chats`
  let chatId: string | undefined
  const chatPath = () => {
    if (chatId === undefined) throw new Error('no Coordinator chat yet')
    return `/coordinator-chats/${chatId}`
  }
  const sendRaw = async (body: Record<string, unknown>) => {
    const result = await client.call(
      'POST',
      chatId === undefined ? chats : `${chatPath()}/messages`,
      body,
    )
    const id = (result.body as { id?: unknown } | undefined)?.id
    if (result.status < 300 && typeof id === 'string') chatId = id
    return result
  }
  const send = async <T = Coordinator>(body: Record<string, unknown>): Promise<T> => {
    const result = await sendRaw(body)
    if (result.status >= 300) throw new Error(`send: ${JSON.stringify(result)}`)
    return result.body as T
  }
  return {
    factory,
    get base() {
      return chatPath()
    },
    call,
    request: (method: string, route: string, body?: unknown) => client.call(method, route, body),
    chat: () => call<Coordinator>('GET', chatPath()),
    send,
    sendRaw,
    message: (steps: unknown[]) => send({ agent: 'claude', text: JSON.stringify({ steps }) }),
    async restart() {
      await daemon?.stop()
      daemon = await startDaemon({
        home,
        version: '9.9.9',
        claudeBin: stubClaudePath,
        codexBin: stubCodexPath,
        ...(runs && { runs }),
        wrap: pausing,
        mkdir: pausingMkdir,
      })
      client = api(daemon.port, { appKey: daemon.appToken })
      return daemon
    },
  }
}

test('working Claude steering is restored at its next tool boundary after daemon restart', async () => {
  const s = await setup()
  const c = await s.message([
    { say: 'Before restart' },
    { waitFor: path.join(scratch, 'boundary') },
    { tool: 'Read' },
    { say: 'After boundary' },
    { waitFor: path.join(scratch, 'finish') },
    { endTurn: true },
  ])
  await waitUntil(async () => {
    const chat = await s.call<RunChat>('GET', `/runs/${c.runId}/chat`).catch(() => undefined)
    return chat?.items.some((i) => i.kind === 'agent' && i.text === 'Before restart')
  }, 'working response')
  await s.send({ text: 'Read fresh facts after restart' })
  const flag = path.join(home, 'runs', c.runId, 'queued')
  expect(existsSync(flag)).toBe(true)
  await s.restart()
  expect((await s.chat()).status).toBe('working')
  expect(existsSync(flag)).toBe(true)
  await writeFile(path.join(scratch, 'boundary'), '')
  await waitUntil(async () => {
    const chat = await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)
    return chat.items.some((i) => i.kind === 'agent' && i.text === 'After boundary')
  }, 'tool boundary')
  const chat = await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)
  expect(
    chat.items.some((i) => i.kind === 'agent' && i.text === 'Read: Read fresh facts after restart'),
  ).toBe(true)
})

test('shutdown drains a suspended initial launch without starting a host after closure', async () => {
  const s = await setup(),
    gate = pause('folder')
  const c = await s.message([{ say: 'Should not start before retry' }, { endTurn: true }])
  await gate.entered
  const closed = Promise.withResolvers<void>()
  pauses.closing = () => closed.resolve()
  const closing = daemon?.stop()
  await closed.promise
  gate.release()
  await closing
  daemon = undefined
  expect(
    (await readdir(path.join(home, 'runs')).catch(() => [])).some((id) => id === c.runId),
  ).toBe(false)
  const store = await openStore({ directory: path.join(home, 'store') })
  expect(store.coordinators.list().find((c) => c.factoryId === s.factory.id)?.runId).toBe(c.runId)
  expect(store.getRun(c.runId)).toBeUndefined()
  await store.close()
})

test('replacement checkpoint survives shutdown before host creation and keeps input and receipts', async () => {
  const s = await setup()
  const a = await s.call<Task>('POST', '/tasks', { factory: 'NB', title: 'A' })
  const b = await s.call<Task>('POST', '/tasks', { factory: 'NB', title: 'B' })
  const c = await s.message([
    { say: 'Earlier answer' },
    { waitFor: path.join(scratch, 'earlier-end') },
    { endTurn: true },
  ])
  await waitUntil(async () => (await s.chat()).started, 'initial Run')
  const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
  if (!daemon) throw new Error('missing daemon')
  const run = api(daemon.port, tokens.issue(c.runId))
  const read = async (id: string) => {
    const response = await run.call('GET', `/coordinator/tasks/${id}`)
    const context = (response.body as { context: string }).context
    return JSON.parse(context.split('\n').slice(1, -1).join('\n')) as CoordinatorTask
  }
  const av = await read(a.id),
    bv = await read(b.id)
  const action = {
    operation: 'durable-move',
    version: av.version,
    after: b.id,
    neighbours: { [b.id]: bv.version },
  }
  const receipt = await run.call('POST', `/coordinator/tasks/${a.id}/move`, action)
  expect(receipt.status).toBe(200)
  await writeFile(path.join(scratch, 'earlier-end'), '')
  await waitUntil(async () => (await s.chat()).status === 'ready', 'earlier response')
  await s.call('POST', `${s.base}/stop`)
  const storeBefore = (await s.chat()).receipts
  expect(storeBefore).toHaveLength(1)
  const gate = pause('folder')
  await s.message([
    { run: ['ted', 'coordinator', 'tasks'] },
    { say: 'Recovered requested answer' },
    { waitFor: path.join(scratch, 'replacement-end') },
    { endTurn: true },
  ])
  await gate.entered
  const checkpoint = await s.chat()
  expect(checkpoint.runId).not.toBe(c.runId)
  expect(checkpoint.started).toBe(false)
  const closed = Promise.withResolvers<void>()
  pauses.closing = () => closed.resolve()
  const closing = daemon?.stop()
  await closed.promise
  gate.release()
  await closing
  daemon = undefined
  const store = await openStore({ directory: path.join(home, 'store') })
  const saved = store.coordinators.list().find((c) => c.factoryId === s.factory.id)
  expect(saved?.launch?.prompt).toContain('Recovered requested answer')
  expect(saved?.launch?.messages).toHaveLength(1)
  expect(store.getRun(checkpoint.runId)).toBeUndefined()
  await store.close()
  const resumedDaemon = await s.restart()
  await waitUntil(async () => {
    const chat = await s
      .call<RunChat>('GET', `/runs/${checkpoint.runId}/chat`)
      .catch(() => undefined)
    return chat?.items.some((i) => i.kind === 'agent' && i.text === 'Recovered requested answer')
  }, 'recovered answer')
  const after = await s.chat()
  expect(after.runId).toBe(checkpoint.runId)
  expect(after.receipts).toEqual(storeBefore)
  const chat = await s.call<RunChat>('GET', `/runs/${after.runId}/chat`)
  expect(
    chat.items.some((i) => i.kind === 'agent' && i.text === 'Recovered requested answer'),
  ).toBe(true)
  const result = chat.items.find((i) => i.kind === 'agent' && i.text.includes('stdout'))
  if (result?.kind !== 'agent') throw new Error('missing scoped tool result')
  expect(JSON.parse(result.text).code).toBe(0)
  const replacement = api(resumedDaemon.port, tokens.issue(after.runId))
  expect(await replacement.call('POST', `/coordinator/tasks/${a.id}/move`, action)).toEqual(receipt)
  expect((await s.chat()).receipts).toHaveLength(1)
  await writeFile(path.join(scratch, 'replacement-end'), '')
  await waitUntil(async () => (await s.chat()).status === 'ready', 'replacement finishes')
})

test('Factory removal blocks new chats throughout cleanup and rejects an in-flight first message', async () => {
  const s = await setup(),
    defaults = pause('defaults')
  const first = s.sendRaw({ agent: 'claude', text: 'First message' })
  await defaults.entered
  const removal = pause('removal')
  const deleting = s.call('POST', `/factories/${s.factory.id}/remove`, {
    key: 'NB',
    closePullRequests: false,
  })
  await removal.entered
  expect((await s.sendRaw({ text: 'Recreate during cleanup' })).status).toBe(404)
  defaults.release()
  expect((await first).status).toBe(404)
  removal.release()
  await deleting
  await daemon?.stop()
  daemon = undefined
  const store = await openStore({ directory: path.join(home, 'store') })
  expect(store.getFactory(s.factory.id)).toBeUndefined()
  expect(store.coordinators.list()).toEqual([])
  expect(store.listRuns()).toEqual([])
  await store.close()
  expect(await readdir(path.join(home, 'coordinators')).catch(() => [])).toEqual([])
})

test('Stop preserves all unstarted human messages across restart without dispatching them later', async () => {
  const s = await setup()
  await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: false }))
  await s.call('POST', '/agents/health/check')
  const c = await s.message([{ say: 'Canceled original' }, { endTurn: true }])
  await s.send({ text: 'Another canceled instruction' })
  expect(c.started).toBe(false)
  await s.call('POST', `${s.base}/stop`)
  expect((await s.chat()).unsentMessages).toHaveLength(2)
  await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: true }))
  await s.restart()
  await s.call('POST', '/agents/health/check')
  const reopened = await s.chat()
  expect(reopened.status).toBe('ready')
  expect(reopened.unsentMessages.map((m) => m.text).join('\n')).toContain('Canceled original')
  expect(reopened.unsentMessages.map((m) => m.text).join('\n')).toContain(
    'Another canceled instruction',
  )
  await s.message([{ say: 'Fresh authorized answer' }, { endTurn: true }])
  await waitUntil(async () => (await s.chat()).status === 'ready', 'fresh response')
  const chat = await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)
  expect(chat.items.some((i) => i.kind === 'agent' && i.text === 'Fresh authorized answer')).toBe(
    true,
  )
  expect(chat.items.some((i) => i.kind === 'agent' && i.text === 'Canceled original')).toBe(false)
  expect((await s.chat()).unsentMessages).toHaveLength(2)
})

test('failed session launch keeps pending input available for a successful retry', async () => {
  const s = await setup()
  const c = await s.message([
    { say: 'Before failure' },
    { waitFor: path.join(scratch, 'fail') },
    { exit: 1 },
  ])
  await waitUntil(async () => (await s.chat()).started, 'initial Run')
  await writeFile(path.join(scratch, 'fail'), '')
  await waitUntil(async () => (await s.chat()).status === 'failed', 'failed response')
  await daemon?.stop()
  daemon = undefined
  const store = await openStore({ directory: path.join(home, 'store') })
  const current = store.coordinators.list().find((c) => c.factoryId === s.factory.id)
  if (!current) throw new Error('missing saved Coordinator')
  const input = JSON.stringify({ steps: [{ say: 'Resumed pending request' }, { endTurn: true }] })
  store.queueRunMessage({ runId: c.runId, text: input })
  store.coordinators.save({ ...current, phase: 'queued' })
  await store.persisted()
  await store.close()
  pauses.resume = async () => {
    throw new Error('session launch could not start')
  }
  await s.restart()
  await waitUntil(async () => (await s.chat()).status === 'failed', 'launch failure')
  const before = await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)
  expect(before.items.find((i) => i.kind === 'human' && i.text === input)).toMatchObject({
    queued: true,
    sent: false,
  })
  pauses.resume = undefined
  await s.call('POST', `${s.base}/retry`)
  await waitUntil(async () => (await s.chat()).status === 'ready', 'successful retry')
  expect((await s.chat()).runId).toBe(c.runId)
  const after = await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)
  expect(after.items.some((i) => i.kind === 'agent' && i.text === 'Resumed pending request')).toBe(
    true,
  )
}, 90_000)

test('failed admitted input write preserves the human request for Retry', async () => {
  const s = await setup()
  const c = await s.message([{ say: 'Initial answer' }, { endTurn: true }])
  await waitUntil(async () => (await s.chat()).status === 'ready', 'initial answer')
  pauses.dispatch = async () => {
    throw new Error('simulated input append failure')
  }
  const input = JSON.stringify({ steps: [{ say: 'Recovered human request' }, { endTurn: true }] })
  await s.send({ text: input })
  await waitUntil(async () => (await s.chat()).status === 'failed', 'delivery failure')
  const before = await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)
  expect(before.items.find((i) => i.kind === 'human' && i.text === input)).toMatchObject({
    queued: true,
    sent: false,
  })
  pauses.dispatch = undefined
  await s.restart()
  await s.call('POST', `${s.base}/retry`)
  await waitUntil(async () => (await s.chat()).status === 'ready', 'retried answer')
  const after = await s.call<RunChat>('GET', `/runs/${(await s.chat()).runId}/chat`)
  expect(
    after.items.filter((i) => i.kind === 'agent' && i.text === 'Recovered human request'),
  ).toHaveLength(1)
})

test('restart after input acceptance recovers the delivery without replaying an action', async () => {
  const s = await setup()
  const a = await s.call<Task>('POST', '/tasks', { factory: 'NB', title: 'A' })
  const b = await s.call<Task>('POST', '/tasks', { factory: 'NB', title: 'B' })
  const c = await s.message([{ waitFor: path.join(scratch, 'initial-end') }, { endTurn: true }])
  await waitUntil(async () => (await s.chat()).started, 'initial Run')
  if (!daemon) throw new Error('missing daemon')
  const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
  const run = api(daemon.port, tokens.issue(c.runId))
  const read = async (id: string) => {
    const result = await run.call('GET', `/coordinator/tasks/${id}`)
    return JSON.parse(
      (result.body as { context: string }).context.split('\n').slice(1, -1).join('\n'),
    ) as CoordinatorTask
  }
  const av = await read(a.id),
    bv = await read(b.id)
  await writeFile(path.join(scratch, 'initial-end'), '')
  await waitUntil(async () => (await s.chat()).status === 'ready', 'initial settlement')
  pauses.dispatched = async () => {
    await waitUntil(
      async () =>
        (await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)).items.some(
          (i) => i.kind === 'agent' && i.text === 'Action completed',
        ),
      'completed action',
    )
    throw new Error('simulated exit before delivery checkpoint')
  }
  const input = JSON.stringify({
    steps: [
      {
        run: [
          'ted',
          'coordinator',
          'move',
          a.id,
          '--after',
          b.id,
          '--operation',
          'once-only',
          '--version',
          av.version,
          '--neighbours',
          JSON.stringify({ [b.id]: bv.version }),
        ],
      },
      { say: 'Action completed' },
      { endTurn: true },
    ],
  })
  await s.send({ text: input })
  await waitUntil(async () => (await s.chat()).status === 'failed', 'interrupted checkpoint')
  const pending = (await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)).items.find(
    (i) => i.kind === 'human' && i.text === input,
  )
  expect(pending).toMatchObject({ queued: true })
  if (!pending) throw new Error('missing pending request')
  const receipts = (await s.chat()).receipts
  expect(receipts).toHaveLength(1)
  expect(receipts[0]?.text).toContain('Moved')
  expect(receipts[0]?.after?.rank).not.toBe(receipts[0]?.before?.rank)
  const tasks = await s.call<Task[]>('GET', '/tasks')
  pauses.dispatched = undefined
  await s.restart()
  expect((await s.request('DELETE', `/runs/${c.runId}/messages/${pending.id}`)).status).toBe(409)
  await s.call('POST', `${s.base}/retry`)
  await waitUntil(async () => (await s.chat()).status === 'ready', 'recovered checkpoint')
  const after = await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)
  expect(
    after.items.filter((i) => i.kind === 'agent' && i.text === 'Action completed'),
  ).toHaveLength(1)
  expect((await s.chat()).receipts).toEqual(receipts)
  expect((await s.call<Task[]>('GET', '/tasks')).find((t) => t.id === a.id)?.rank).toBe(
    tasks.find((t) => t.id === a.id)?.rank,
  )
  const records = (await readFile(path.join(home, 'runs', c.runId, 'input.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { deliveryIds?: string[] })
  expect(records.filter((r) => r.deliveryIds?.includes(pending.id))).toHaveLength(1)
})

test('boundary delivery survives settlement, and a Task starts while the Coordinator works', async () => {
  const s = await setup()
  await s.call('PATCH', '/settings', { maxWorkingRuns: 1 })
  const c = await s.message([{ waitFor: path.join(scratch, 'settle') }, { endTurn: true }])
  await waitUntil(async () => (await s.chat()).started, 'initial Run')
  const input = JSON.stringify({
    steps: [
      { say: 'Admitted follow-up' },
      { waitFor: path.join(scratch, 'followup-end') },
      { endTurn: true },
    ],
  })
  await s.send({ text: input })
  const gate = pause('persisted')
  if (!daemon) throw new Error('missing daemon')
  const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
  const boundary = api(daemon.port, tokens.issue(c.runId)).call('POST', `/runs/${c.runId}/boundary`)
  await gate.entered
  await writeFile(path.join(scratch, 'settle'), '')
  await waitUntil(
    async () => (await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)).run.state === 'idle',
    'original settlement',
  )
  const other = await s.call<Task>('POST', '/tasks', {
    factory: 'NB',
    title: JSON.stringify({
      steps: [{ waitFor: path.join(scratch, 'other-end') }, { endTurn: true }],
    }),
  })
  await s.call('POST', `/tasks/${other.id}/start`)
  expect((await s.chat()).status).toBe('working')
  await waitUntil(
    async () =>
      (await s.call<Task[]>('GET', '/tasks')).find((t) => t.id === other.id)?.leadRunId !==
      undefined,
    'Task started beside the Coordinator',
  )
  expect((await s.call<RunSlots>('GET', '/slots')).working).toBe(1)
  gate.release()
  await boundary
  expect(pauses.dispatchPhase).toBe('working')
  await writeFile(path.join(scratch, 'followup-end'), '')
  await waitUntil(async () => (await s.chat()).status === 'ready', 'follow-up settlement')
  await writeFile(path.join(scratch, 'other-end'), '')
})

test.each(['initial', 'revival'] as const)(
  'health pause during %s launch preserves continuation',
  async (kind) => {
    const s = await setup()
    let c: Coordinator
    let gate: ReturnType<typeof pause>
    if (kind === 'initial') {
      gate = pause('started')
      c = await s.message([{ waitFor: path.join(scratch, 'original-response') }, { endTurn: true }])
    } else {
      c = await s.message([{ waitFor: path.join(scratch, 'fail-response') }, { exit: 1 }])
      await waitUntil(async () => (await s.chat()).started, 'initial Run')
      await writeFile(path.join(scratch, 'fail-response'), '')
      await waitUntil(async () => (await s.chat()).status === 'failed', 'failed Run')
      gate = pause('resumed')
      await s.call('POST', `${s.base}/retry`)
    }
    await gate.entered
    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: false }))
    await s.call('POST', '/agents/health/check')
    expect((await s.chat()).status).toBe('paused')
    gate.release()
    await waitUntil(
      async () => (await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)).run.state === 'finished',
      'paused Run stopped',
    )
    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: true }))
    await s.call('POST', '/agents/health/check')
    await waitUntil(async () => (await s.chat()).runId !== c.runId, 'replacement response')
    await waitUntil(async () => (await s.chat()).started, 'continued response launched')
    const after = await s.chat()
    expect(after.status).toBe('working')
    const run = (await s.call<RunChat>('GET', `/runs/${after.runId}/chat`)).run
    expect(run.state).toBe('working')
    const history = await s.call<RunChat>('GET', `/runs/${after.runId}/chat`)
    expect(JSON.stringify(history.items)).toContain(
      'Continue the interrupted response using fresh facts',
    )
    await s.call('POST', `${s.base}/stop`)
  },
)

test.each(['claude', 'codex'] as const)(
  '%s acknowledges identical queued requests separately',
  async (agent) => {
    const s = await setup()
    const c = await s.send<Coordinator>({
      agent,
      text: JSON.stringify({ steps: [{ say: 'Initial answer' }, { endTurn: true }] }),
    })
    await waitUntil(async () => (await s.chat()).status === 'ready', 'initial answer')
    const health = path.join(home, `stub-${agent}.json`)
    await writeFile(health, JSON.stringify({ signedIn: false }))
    await s.call('POST', '/agents/health/check')
    const text = JSON.stringify({
      steps: [{ say: 'Repeated request answered' }, { endTurn: true }],
    })
    await Promise.all([s.send({ text }), s.send({ text })])
    expect((await s.chat()).status).toBe('paused')
    await writeFile(health, JSON.stringify({ signedIn: true }))
    await s.call('POST', '/agents/health/check')
    await waitUntil(async () => (await s.chat()).status === 'ready', 'both requests answered')
    const chat = await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)
    expect(
      chat.items.filter((i) => i.kind === 'agent' && i.text === 'Repeated request answered'),
    ).toHaveLength(2)
    expect(
      chat.items.filter((i) => i.kind === 'human' && i.text === text && i.sent === true),
    ).toHaveLength(2)
    expect((await s.call<RunSlots>('GET', '/slots')).working).toBe(0)
  },
)

test('cancel refuses a queued-looking message whose input has already dispatched', async () => {
  const s = await setup()
  const c = await s.message([{ say: 'Initial answer' }, { endTurn: true }])
  await waitUntil(async () => (await s.chat()).status === 'ready', 'initial answer')
  const gate = pause('dispatched')
  const text = JSON.stringify({ steps: [{ say: 'Dispatched action ran' }, { endTurn: true }] })
  await s.send({ text })
  await gate.entered
  const chat = await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)
  const message = chat.items.find((i) => i.kind === 'human' && i.text === text)
  if (!message) throw Error('missing message')
  const result = await s.request('DELETE', `/runs/${c.runId}/messages/${message.id}`)
  expect(result.status).toBe(409)
  gate.release()
})

test('Coordinator refuses reversed current neighbours rather than claiming an impossible move', async () => {
  const s = await setup()
  const a = await s.call<Task>('POST', '/tasks', { factory: 'NB', title: 'A' })
  const b = await s.call<Task>('POST', '/tasks', { factory: 'NB', title: 'B' })
  const target = await s.call<Task>('POST', '/tasks', { factory: 'NB', title: 'Target' })
  const c = await s.message([{ waitFor: path.join(scratch, 'coordinator-end') }, { endTurn: true }])
  await waitUntil(async () => (await s.chat()).started, 'Coordinator Run')
  if (!daemon) throw Error('missing daemon')
  const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
  const run = api(daemon.port, tokens.issue(c.runId))
  const read = async (id: string) => {
    const r = await run.call('GET', `/coordinator/tasks/${id}`)
    return JSON.parse(
      (r.body as { context: string }).context.split('\n').slice(1, -1).join('\n'),
    ) as CoordinatorTask
  }
  const av = await read(a.id),
    bv = await read(b.id),
    tv = await read(target.id)
  const [low, high] = [av, bv].sort((x, y) => x.task.rank - y.task.rank)
  if (!low || !high) throw Error('missing neighbours')
  const result = await run.call('POST', `/coordinator/tasks/${target.id}/move`, {
    operation: 'reversed-neighbours',
    version: tv.version,
    after: high.task.id,
    before: low.task.id,
    neighbours: { [high.task.id]: high.version, [low.task.id]: low.version },
  })
  expect(result.status).toBe(409)
})

test('initial prompt checkpoint does not replay an accepted request after interrupted cleanup', async () => {
  const s = await setup()
  pauses.started = async () => {
    const c = await s.chat()
    await waitUntil(
      async () =>
        (await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)).items.some(
          (i) => i.kind === 'agent' && i.text === 'One requested answer',
        ),
      'original answer',
    )
    throw new Error('simulated interruption after RunStarted before queue removal')
  }
  const c = await s.message([{ say: 'One requested answer' }, { endTurn: true }])
  await waitUntil(async () => (await s.chat()).status === 'failed', 'interrupted launch cleanup')
  const before = await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)
  expect(before.items.some((i) => i.kind === 'human' && i.queued === true)).toBe(true)
  pauses.started = undefined
  await s.restart()
  await s.call('POST', `${s.base}/retry`)
  await waitUntil(async () => (await s.chat()).status === 'ready', 'recovered response')
  const after = await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)
  expect(
    after.items.filter((i) => i.kind === 'agent' && i.text === 'One requested answer'),
  ).toHaveLength(1)
  const humans = after.items.filter(
    (i) => i.kind === 'human' && i.text.includes('One requested answer'),
  )
  expect(humans).toHaveLength(1)
  expect(humans.every((i) => i.kind === 'human' && i.sent === true)).toBe(true)
})

test('revival prompt checkpoint does not replay accepted input after interrupted cleanup', async () => {
  const s = await setup()
  const c = await s.message([{ waitFor: path.join(scratch, 'fail') }, { exit: 1 }])
  await waitUntil(async () => (await s.chat()).started, 'initial Run')
  await writeFile(path.join(scratch, 'fail'), '')
  await waitUntil(async () => (await s.chat()).status === 'failed', 'initial failure')
  await daemon?.stop()
  daemon = undefined
  const store = await openStore({ directory: path.join(home, 'store') })
  const saved = store.coordinators.list().find((c) => c.factoryId === s.factory.id)
  if (!saved) throw Error('missing chat')
  store.queueRunMessage({
    runId: c.runId,
    text: JSON.stringify({ steps: [{ say: 'One revived answer' }, { endTurn: true }] }),
  })
  store.coordinators.save({ ...saved, phase: 'queued' })
  await store.persisted()
  await store.close()
  pauses.resumed = async () => {
    await waitUntil(
      async () =>
        (await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)).items.some(
          (i) => i.kind === 'agent' && i.text === 'One revived answer',
        ),
      'revived answer',
    )
    throw Error('simulated interruption after RunRevived before delivery checkpoint')
  }
  await s.restart()
  await waitUntil(async () => (await s.chat()).status === 'failed', 'interrupted revival')
  pauses.resumed = undefined
  await s.restart()
  await s.call('POST', `${s.base}/retry`)
  await waitUntil(async () => (await s.chat()).status === 'ready', 'recovered revival')
  const after = await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)
  expect(
    after.items.filter((i) => i.kind === 'agent' && i.text === 'One revived answer'),
  ).toHaveLength(1)
})

test('cancellation before input write prevents dispatch of a previously selected message', async () => {
  const s = await setup()
  const c = await s.message([{ waitFor: path.join(scratch, 'original-end') }, { endTurn: true }])
  await waitUntil(async () => (await s.chat()).started, 'initial Run')
  await s.send({ text: 'Canceled before write' })
  const chat = await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)
  const message = chat.items.find((i) => i.kind === 'human' && i.text === 'Canceled before write')
  if (!message || !daemon) throw Error('missing message or daemon')
  const gate = pause('dispatch')
  const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
  const boundary = api(daemon.port, tokens.issue(c.runId)).call('POST', `/runs/${c.runId}/boundary`)
  await gate.entered
  expect((await s.request('DELETE', `/runs/${c.runId}/messages/${message.id}`)).status).toBe(200)
  gate.release()
  expect((await boundary).body).toEqual({ delivered: 0 })
  const input = await readFile(path.join(home, 'runs', c.runId, 'input.jsonl'), 'utf8').catch(
    () => '',
  )
  expect(input).not.toContain('Canceled before write')
  await writeFile(path.join(scratch, 'original-end'), '')
  await waitUntil(async () => (await s.chat()).status === 'ready', 'original response finished')
})

test('Retry recovers a prepared Run directory without a RunStarted row', async () => {
  const s = await setup()
  pauses.runFolder = async () => {
    throw Error('simulated interruption after Run directory creation')
  }
  const c = await s.message([{ say: 'Preserved request' }, { endTurn: true }])
  await waitUntil(async () => (await s.chat()).status === 'failed', 'interrupted initial launch')
  expect((await s.chat()).started).toBe(false)
  await s.call('POST', `${s.base}/retry`)
  await waitUntil(
    async () => (await s.chat()).status === 'failed',
    'second interrupted preparation',
  )
  expect((await s.chat()).error).not.toContain('EEXIST')
  pauses.runFolder = undefined
  await s.restart()
  pauses.started = async () => {
    const current = await s.chat()
    await waitUntil(
      async () =>
        (await s.call<RunChat>('GET', `/runs/${current.runId}/chat`)).items.some(
          (i) => i.kind === 'agent' && i.text === 'Preserved request',
        ),
      'replacement answer',
    )
    await waitUntil(async () => (await s.chat()).status === 'ready', 'replacement settlement')
    throw new Error('interrupted replacement checkpoint')
  }
  await s.call('POST', `${s.base}/retry`)
  await waitUntil(async () => (await s.chat()).status === 'failed', 'replacement checkpoint')
  pauses.started = undefined
  await s.restart()
  await s.call('POST', `${s.base}/retry`)
  await waitUntil(async () => (await s.chat()).status === 'ready', 'recovered request')
  const after = await s.chat()
  expect(after.runId).not.toBe(c.runId)
  expect(after.started).toBe(true)
  const chat = await s.call<RunChat>('GET', `/runs/${after.runId}/chat`)
  expect(
    chat.items.filter((i) => i.kind === 'agent' && i.text === 'Preserved request'),
  ).toHaveLength(1)
  expect(
    chat.items.filter((i) => i.kind === 'human' && i.text.includes('Preserved request')),
  ).toHaveLength(1)
})

test('Queued Work and Intake Tasks share the same Coordinator waiting group', async () => {
  const s = await setup()
  const a = await s.call<Task>('POST', '/tasks', { factory: 'NB', title: 'Queued Work' })
  const b = await s.call<Task>('POST', '/tasks', { factory: 'NB', title: 'Queued Intake' })
  await daemon?.stop()
  daemon = undefined
  const store = await openStore({ directory: path.join(home, 'store') })
  store.queueTask(a.id, 'work')
  store.queueTask(b.id, 'intake')
  store.pauseAgent('claude', 'paused for queued reorder fixture')
  await store.persisted()
  await store.close()
  await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: false }))
  const restarted = await s.restart()
  const c = await s.send<Coordinator>({
    agent: 'codex',
    text: JSON.stringify({
      steps: [{ waitFor: path.join(scratch, 'coordinator-end') }, { endTurn: true }],
    }),
  })
  await waitUntil(async () => (await s.chat()).started, 'Coordinator Run')
  const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
  const run = api(restarted.port, tokens.issue(c.runId))
  const read = async (id: string) => {
    const result = await run.call('GET', `/coordinator/tasks/${id}`)
    return JSON.parse(
      (result.body as { context: string }).context.split('\n').slice(1, -1).join('\n'),
    ) as CoordinatorTask
  }
  const av = await read(a.id),
    bv = await read(b.id)
  expect(av.task.stage).toBe('work')
  expect(bv.task.stage).toBe('intake')
  const result = await run.call('POST', `/coordinator/tasks/${a.id}/move`, {
    operation: 'queued-cross-stage',
    version: av.version,
    after: b.id,
    neighbours: { [b.id]: bv.version },
  })
  expect(result.status).toBe(200)
})

test('admitted Codex follow-ups wait without failing a slow healthy response', async () => {
  const s = await setup({ inputAckMs: 3_000 })
  const c = await s.send<Coordinator>({
    agent: 'codex',
    text: JSON.stringify({ steps: [{ endTurn: true }] }),
  })
  await waitUntil(async () => (await s.chat()).status === 'ready', 'initial idle Coordinator')
  const first = JSON.stringify({
    steps: [
      { say: 'First admitted follow-up' },
      { waitFor: path.join(scratch, 'first-response-end') },
      { endTurn: true },
    ],
  })
  const second = JSON.stringify({
    steps: [{ say: 'Second admitted follow-up' }, { endTurn: true }],
  })
  await s.send({ text: first })
  await s.send({ text: second })
  await waitUntil(
    async () =>
      (await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)).items.some(
        (i) => i.kind === 'agent' && i.text === 'First admitted follow-up',
      ),
    'first follow-up running',
  )
  await new Promise((resolve) => setTimeout(resolve, 4_000))
  expect((await s.chat()).status).toBe('working')
  const during = await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)
  expect(
    during.items.some((i) => i.kind === 'human' && i.text === second && i.queued === true),
  ).toBe(true)
  const canceled = await s.call<RunMessage>('POST', `/runs/${c.runId}/messages`, {
    text: 'Canceled later follow-up',
  })
  await s.call('DELETE', `/runs/${c.runId}/messages/${canceled.id}`)
  const input = await readFile(path.join(home, 'runs', c.runId, 'input.jsonl'), 'utf8')
  expect(input).not.toContain('Second admitted follow-up')
  expect(input).not.toContain('Canceled later follow-up')
  const slots = await s.call<RunSlots>('GET', '/slots')
  expect(slots.working).toBe(0)
  expect(slots.holders.some((h) => h.kind === 'coordinator' && h.runId === c.runId)).toBe(true)
  await writeFile(path.join(scratch, 'first-response-end'), '')
  await waitUntil(async () => (await s.chat()).status === 'ready', 'both follow-ups settled')
  const after = await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)
  for (const [text, answer] of [
    [first, 'First admitted follow-up'],
    [second, 'Second admitted follow-up'],
  ]) {
    const messages = after.items.filter((i) => i.kind === 'human' && i.text === text)
    expect(messages).toHaveLength(1)
    expect(messages.every((i) => i.kind === 'human' && i.sent === true && i.queued !== true)).toBe(
      true,
    )
    expect(after.items.filter((i) => i.kind === 'agent' && i.text === answer)).toHaveLength(1)
  }
  expect(await readFile(path.join(home, 'runs', c.runId, 'input.jsonl'), 'utf8')).not.toContain(
    'Canceled later follow-up',
  )
  expect((await s.call<RunSlots>('GET', '/slots')).working).toBe(0)
})

test('a message steered at a tool boundary is read after the hook without failing the chat', async () => {
  const s = await setup({ inputAckMs: 1_000 })
  const c = await s.message([
    { say: 'Before tool' },
    { waitFor: path.join(scratch, 'tool') },
    { tool: 'Read' },
    { say: 'After tool' },
    { waitFor: path.join(scratch, 'finish') },
    { endTurn: true },
  ])
  await waitUntil(async () => {
    const chat = await s.call<RunChat>('GET', `/runs/${c.runId}/chat`).catch(() => undefined)
    return chat?.items.some((i) => i.kind === 'agent' && i.text === 'Before tool')
  }, 'working response')
  const text = 'Steered while the hook runs'
  await s.send({ text })
  await writeFile(path.join(scratch, 'tool'), '')
  await waitUntil(async () => {
    const chat = await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)
    return chat.items.some((i) => i.kind === 'agent' && i.text === 'After tool')
  }, 'tool boundary')
  await new Promise((resolve) => setTimeout(resolve, 2_000))
  expect((await s.chat()).status).toBe('working')
  await writeFile(path.join(scratch, 'finish'), '')
  await waitUntil(async () => (await s.chat()).status === 'ready', 'turn end')
  const chat = await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)
  const agents = chat.items.filter((i) => i.kind === 'agent').map((i) => i.text)
  expect(agents.filter((t) => t === `Read: ${text}`)).toHaveLength(1)
  expect(agents.indexOf(`Read: ${text}`)).toBeLessThan(agents.indexOf('After tool'))
  expect(
    chat.items.find((i) => i.kind === 'human' && i.text === text && i.queued !== true),
  ).toBeDefined()
})

test('a chat whose Run ends as a follow-up arrives resumes and reads it', async () => {
  const s = await setup()
  await s.message([{ exitOnInput: true }, { endTurn: true }])
  await waitUntil(async () => (await s.chat()).status === 'ready', 'first turn')
  const follow = JSON.stringify({ steps: [{ say: 'Resumed and read' }, { endTurn: true }] })
  await s.send({ text: follow })
  await waitUntil(async () => {
    const current = await s.chat()
    if (current.status === 'failed') throw new Error(`chat failed: ${current.error}`)
    const chat = await s.call<RunChat>('GET', `/runs/${current.runId}/chat`)
    return chat.items.some((i) => i.kind === 'agent' && i.text === 'Resumed and read')
  }, 'resumed follow-up')
  await waitUntil(async () => (await s.chat()).status === 'ready', 'follow-up settled')
})

async function startPlan(s: Awaited<ReturnType<typeof setup>>, steps: unknown[]) {
  const plan = await s.call<Plan>('POST', '/plans', {
    factory: 'NB',
    message: JSON.stringify({ steps }),
  })
  const status = async () => (await s.call<PlanDetail>('GET', `/plans/${plan.id}`)).plan
  const said = (text: string) =>
    waitUntil(async () => {
      const current = await status()
      if (current.status === 'failed') throw new Error(`plan failed: ${current.error}`)
      const chat = await s.call<RunChat>('GET', `/runs/${plan.id}/chat`).catch(() => undefined)
      return chat?.items.some((i) => i.kind === 'agent' && i.text === text)
    }, text)
  return { plan, status, said }
}

test('a planning chat whose Run ends with a queued message resumes and reads it, each time it happens', async () => {
  const s = await setup()
  await writeFile(
    path.join(home, 'stub-claude.json'),
    JSON.stringify({ resumeSteps: [{ endTurn: true }] }),
  )
  const gate = (n: number) => path.join(scratch, `exit-${n}`)
  const { plan, status, said } = await startPlan(s, [
    { say: 'Read 0' },
    { waitFor: gate(0) },
    { exit: 1 },
  ])
  for (const n of [1, 2, 3]) {
    await said(`Read ${n - 1}`)
    const steps =
      n < 3
        ? [{ say: `Read ${n}` }, { waitFor: gate(n) }, { exit: 1 }]
        : [{ say: `Read ${n}` }, { endTurn: true }]
    await s.call('POST', `/runs/${plan.id}/messages`, { text: JSON.stringify({ steps }) })
    await writeFile(gate(n - 1), '')
  }
  await said('Read 3')
  await waitUntil(async () => (await status()).status === 'idle', 'last message settled')
})

test('a planning chat resumes at most 3 times in a row for a queued message it never reads', async () => {
  const s = await setup()
  await writeFile(
    path.join(home, 'stub-claude.json'),
    JSON.stringify({ resumeSteps: [{ say: 'Back' }, { exit: 1 }] }),
  )
  const end = path.join(scratch, 'end')
  const { plan, status, said } = await startPlan(s, [
    { say: 'Working' },
    { waitFor: end },
    { exit: 1 },
  ])
  await said('Working')
  let revivals = 0
  pauses.resumed = async () => {
    revivals += 1
  }
  await s.call('POST', `/runs/${plan.id}/messages`, { text: 'Never read' })
  await writeFile(end, '')
  await waitUntil(async () => (await status()).status === 'failed', 'the chat to fail')
  expect(revivals).toBe(3)
  const chat = await s.call<RunChat>('GET', `/runs/${plan.id}/chat`)
  expect(chat.items.find((i) => i.kind === 'human' && i.text === 'Never read')).toMatchObject({
    queued: true,
  })
})

test('two boundary calls that overlap both return once the host has the message', async () => {
  const s = await setup()
  const c = await s.message([
    { say: 'Working' },
    { waitFor: path.join(scratch, 'end') },
    { endTurn: true },
  ])
  await waitUntil(async () => {
    const chat = await s.call<RunChat>('GET', `/runs/${c.runId}/chat`).catch(() => undefined)
    return chat?.items.some((i) => i.kind === 'agent' && i.text === 'Working')
  }, 'working response')
  await s.send({
    text: JSON.stringify({ steps: [{ say: 'Read the steered message' }, { endTurn: true }] }),
  })
  if (!daemon) throw new Error('missing daemon')
  const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
  const run = api(daemon.port, tokens.issue(c.runId))
  const started = Date.now()
  const results = await Promise.all([
    run.call('POST', `/runs/${c.runId}/boundary`),
    run.call('POST', `/runs/${c.runId}/boundary`),
  ])
  expect(Date.now() - started).toBeLessThan(5_000)
  expect(results.map((result) => result.status)).toEqual([200, 200])
  expect((await s.chat()).status).toBe('working')
  await writeFile(path.join(scratch, 'end'), '')
  await waitUntil(async () => {
    const chat = await s.call<RunChat>('GET', `/runs/${c.runId}/chat`)
    return chat.items.some((i) => i.kind === 'agent' && i.text === 'Read the steered message')
  }, 'steered message read after the turn')
  await waitUntil(async () => (await s.chat()).status === 'ready', 'turn end')
})
