import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type Coordinator,
  type CoordinatorTask,
  type Factory,
  type RunChat,
  type Task,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { openStore } from '../src/store/index.ts'
import {
  api,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

const pauses = vi.hoisted(() => ({
  folder: undefined as (() => Promise<void>) | undefined,
  defaults: undefined as (() => Promise<void>) | undefined,
  removal: undefined as (() => Promise<void>) | undefined,
  resume: undefined as (() => Promise<void>) | undefined,
}))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
      if (/\/coordinators\/[a-f0-9-]{36}$/.test(String(args[0]))) await pauses.folder?.()
      return fs.mkdir(...args)
    },
  }
})
vi.mock('../src/workflow/workflows.ts', async (original) => {
  const module = await original<typeof import('../src/workflow/workflows.ts')>()
  return {
    ...module,
    createWorkflows: (...args: Parameters<typeof module.createWorkflows>) => {
      const workflows = module.createWorkflows(...args)
      return {
        ...workflows,
        resolve: async (...input: Parameters<typeof workflows.resolve>) => {
          const result = await workflows.resolve(...input)
          await pauses.defaults?.()
          return result
        },
      }
    },
  }
})
vi.mock('../src/plans/plans.ts', async (original) => {
  const module = await original<typeof import('../src/plans/plans.ts')>()
  return {
    ...module,
    createPlans: (...args: Parameters<typeof module.createPlans>) => {
      const plans = module.createPlans(...args)
      return {
        ...plans,
        removeFactory: async (...input: Parameters<typeof plans.removeFactory>) => {
          await plans.removeFactory(...input)
          await pauses.removal?.()
        },
      }
    },
  }
})

vi.mock('../src/runs/run-manager.ts', async (original) => {
  const module = await original<typeof import('../src/runs/run-manager.ts')>()
  return {
    ...module,
    startRunManager: async (...args: Parameters<typeof module.startRunManager>) => {
      const runs = await module.startRunManager(...args)
      return {
        ...runs,
        revive: async (...input: Parameters<typeof runs.revive>) => {
          await pauses.resume?.()
          return runs.revive(...input)
        },
      }
    },
  }
})

let home: string, scratch: string, cleanup: () => Promise<void>, daemon: RunningDaemon | undefined
const releases: (() => void)[] = []
beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-coordinator-recovery-'))
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  pauses.folder = undefined
  pauses.defaults = undefined
  pauses.removal = undefined
  pauses.resume = undefined
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})
function pause(at: keyof typeof pauses) {
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
async function setup() {
  const origin = await makeOriginRepo(scratch)
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  let client = api(daemon.port, { appKey: daemon.appToken })
  async function call<T>(method: string, route: string, body?: unknown): Promise<T> {
    const result = await client.call(method, route, body)
    if (result.status >= 300) throw new Error(`${route}: ${JSON.stringify(result)}`)
    return result.body as T
  }
  const factory = await call<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const base = `/factories/${factory.id}/coordinator`
  return {
    factory,
    base,
    call,
    request: (method: string, route: string, body?: unknown) => client.call(method, route, body),
    chat: () => call<Coordinator>('GET', base),
    message: (steps: unknown[]) =>
      call<Coordinator>('POST', `${base}/messages`, {
        agent: 'claude',
        text: JSON.stringify({ steps }),
      }),
    async restart() {
      await daemon?.stop()
      daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
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
  await s.call('POST', `${s.base}/messages`, { text: 'Read fresh facts after restart' })
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
  const closing = daemon?.stop()
  gate.release()
  await closing
  daemon = undefined
  expect(
    (await readdir(path.join(home, 'runs')).catch(() => [])).some((id) => id === c.runId),
  ).toBe(false)
  const store = await openStore({ directory: path.join(home, 'store') })
  expect(store.coordinators.get(s.factory.id)?.runId).toBe(c.runId)
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
  const closing = daemon?.stop()
  gate.release()
  await closing
  daemon = undefined
  const store = await openStore({ directory: path.join(home, 'store') })
  const saved = store.coordinators.get(s.factory.id)
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
  const first = s.request('POST', `${s.base}/messages`, { agent: 'claude', text: 'First message' })
  await defaults.entered
  const removal = pause('removal')
  const deleting = s.call('POST', `/factories/${s.factory.id}/remove`, {
    key: 'NB',
    closePullRequests: false,
  })
  await removal.entered
  expect(
    (await s.request('POST', `${s.base}/messages`, { text: 'Recreate during cleanup' })).status,
  ).toBe(404)
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
  await s.call('PATCH', '/settings', { maxWorkingRuns: 1 })
  const task = await s.call<Task>('POST', '/tasks', {
    factory: 'NB',
    title: JSON.stringify({
      steps: [{ waitFor: path.join(scratch, 'task-end') }, { endTurn: true }],
    }),
  })
  await s.call('POST', `/tasks/${task.id}/start`)
  await waitUntil(async () => {
    const tasks = await s.call<Task[]>('GET', '/tasks')
    return tasks.find((t) => t.id === task.id)?.leadRunId !== undefined
  }, 'Task to hold slot')
  const c = await s.message([{ say: 'Canceled original' }, { endTurn: true }])
  await s.call('POST', `${s.base}/messages`, { text: 'Another canceled instruction' })
  expect(c.started).toBe(false)
  await s.call('POST', `${s.base}/stop`)
  expect((await s.chat()).unsentMessages).toHaveLength(2)
  await s.restart()
  const reopened = await s.chat()
  expect(reopened.status).toBe('ready')
  expect(reopened.unsentMessages.map((m) => m.text).join('\n')).toContain('Canceled original')
  expect(reopened.unsentMessages.map((m) => m.text).join('\n')).toContain(
    'Another canceled instruction',
  )
  await s.message([{ say: 'Fresh authorized answer' }, { endTurn: true }])
  await writeFile(path.join(scratch, 'task-end'), '')
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
  const current = store.coordinators.get(s.factory.id)
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
})
