import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Factory, Run, Task } from '@ted/protocol'
import type { JsonObject } from '@ted/protocol/parse'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { tryLock } from '../src/lock.ts'
import { maySleep, type SleepFacts } from '../src/runs/idle-sleep.ts'
import {
  api,
  assistantTexts,
  hostRecords,
  isAlive,
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
let ahead = 0
let free = 500e9

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'ted-idle-sleep-')))
  origin = await makeOriginRepo(scratch)
  ahead = 0
  free = 500e9
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function start(runs?: { stopGraceMs: number }) {
  daemon = await startDaemon({
    ...(runs && { runs }),
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    codexBin: path.join(scratch, 'no-codex-here'),
    nudgeAfterMs: 600_000,
    idleSleep: { now: () => Date.now() + ahead, checkEveryMs: 50 },
    disk: {
      freeBytes: async () => free,
      checkEveryMs: 20,
      volumeName: async () => 'Macintosh HD',
      excludeFromBackups: async () => undefined,
    },
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: JsonObject): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  return { ...client, ok }
}

const agentStarts = async () =>
  (
    await readFile(
      path.join(home, 'worktrees', 'NB-1', 'widgets', 'stub-starts.jsonl'),
      'utf8',
    ).catch(() => '')
  )
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { argv: string[] })

const agentEnv = async () =>
  (
    JSON.parse(
      await readFile(path.join(home, 'worktrees', 'NB-1', 'widgets', 'stub-record.json'), 'utf8'),
    ) as { env: Record<string, string | undefined> }
  ).env

const hostStarts = async (runId: string) =>
  (await hostRecords(home, runId)).filter((record) => record.t === 'start')

test('an idle Task Lead’s agent is ended after the idle time and starts again in the same session for a Comment or a chat message', async () => {
  let client = await start()
  await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const task = await client.ok<Task>('POST', '/tasks', {
    title: JSON.stringify({ steps: [{ say: 'ready' }, { endTurn: true }] }),
    factory: 'NB',
    start: true,
  })
  const taskNow = async () =>
    (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id) as Task
  const run = await waitUntil(async () => {
    const leadRunId = (await taskNow()).leadRunId
    if (!leadRunId) return undefined
    const found = (await client.getRun(leadRunId)).run
    return found.state === 'idle' ? found : undefined
  }, 'an idle Task Lead Run')
  const asleep = (what: string) =>
    waitUntil(async () => {
      const found = (await client.getRun(run.id)).run
      return found.asleep ? found : undefined
    }, what)
  const [first] = await hostStarts(run.id)
  expect((await client.getRun(run.id)).run.asleep).toBeUndefined()

  await writeFile(
    path.join(home, 'stub-claude.json'),
    JSON.stringify({ resumeSteps: [{ say: 'awake' }, { endTurn: true }] }),
  )
  ahead = 31 * 60_000
  const slept: Run = await asleep('the idle Run to be put to sleep')
  expect(slept).toMatchObject({ id: run.id, state: 'idle', sessionId: run.sessionId })
  expect(slept.ended).toBeUndefined()
  await waitUntil(
    () => (!isAlive(Number(first?.hostPid)) && !isAlive(Number(first?.agentPid))) || undefined,
    'the host and the agent to exit',
  )

  const answered = async () =>
    assistantTexts((await client.getRun(run.id)).conversation).filter((t) => t === 'awake').length

  free = 1.4e9
  await waitUntil(
    async () =>
      (await client.ok<{ problem: string }[]>('GET', '/banners')).some(
        (banner) => banner.problem === 'disk-full',
      ) || undefined,
    'the disk to count as full',
  )
  const held = await client.call('POST', `/runs/${run.id}/messages`, { text: 'While full' })
  expect(held.status).toBeLessThan(300)

  await daemon?.stop()
  const envFile = path.join(home, 'runs', run.id, 'env.json')
  await writeFile(
    envFile,
    JSON.stringify({
      ...JSON.parse(await readFile(envFile, 'utf8')),
      NODE_OPTIONS: '--title=forged',
      CLAUDE_CONFIG_DIR: '/forged',
      FORGED: 'yes',
    }),
  )
  client = await start()
  expect(await asleep('the Run to stay asleep under a new daemon')).toMatchObject({
    state: 'idle',
  })
  expect(await hostStarts(run.id)).toHaveLength(1)

  free = 500e9
  await waitUntil(
    async () => ((await answered()) === 1 ? true : undefined),
    'the message accepted while the disk was full to be answered after the restart',
  )
  const second = await agentStarts()
  expect(second).toHaveLength(2)
  const wokenEnv = await agentEnv()
  expect(wokenEnv.TED_TASK).toBe('NB-1')
  expect(wokenEnv.NODE_OPTIONS).not.toBe('--title=forged')
  expect(wokenEnv.CLAUDE_CONFIG_DIR).not.toBe('/forged')
  expect(wokenEnv.FORGED).toBeUndefined()
  expect(second[1]?.argv[(second[1]?.argv.indexOf('--resume') ?? -1) + 1]).toBe(run.sessionId)

  await waitUntil(async () => {
    const found = (await client.getRun(run.id)).run
    return (found.asleep && (await hostStarts(run.id)).length === 2) || undefined
  }, 'the Run to sleep again')
  await writeFile(
    envFile,
    JSON.stringify({ ...JSON.parse(await readFile(envFile, 'utf8')), FORGED: 'yes' }),
  )
  await client.ok('POST', `/tasks/${task.id}/comments`, { body: 'Are you there?' })
  await waitUntil(
    async () => ((await answered()) === 2 ? true : undefined),
    'the woken agent to answer the Comment',
  )
  expect(await agentStarts()).toHaveLength(3)
  expect((await agentEnv()).FORGED).toBeUndefined()

  await waitUntil(async () => {
    const found = (await client.getRun(run.id)).run
    return (found.asleep && (await hostStarts(run.id)).length === 3) || undefined
  }, 'the Run to sleep a third time')
  const sent = await client.call('POST', `/runs/${run.id}/messages`, { text: 'And now?' })
  expect(sent.status).toBeLessThan(300)
  const woken = await waitUntil(async () => {
    const found = await client.getRun(run.id)
    return assistantTexts(found.conversation).filter((t) => t === 'awake').length === 3
      ? found
      : undefined
  }, 'the woken agent to answer the chat message')
  expect(woken.run.state).not.toBe('finished')
  expect(woken.run.ended).toBeUndefined()
  expect(await agentStarts()).toHaveLength(4)

  const after = await taskNow()
  expect(after.leadRunId).toBe(run.id)
  expect(after.status?.kind).not.toBe('failed')

  await waitUntil(async () => {
    const found = (await client.getRun(run.id)).run
    return (found.asleep && (await hostStarts(run.id)).length === 4) || undefined
  }, 'the Run to sleep a fourth time')
  await client.ok('POST', `/tasks/${task.id}/stop`)
  const stopped = await waitUntil(async () => {
    const found = (await client.getRun(run.id)).run
    return found.state === 'finished' ? found : undefined
  }, 'the sleeping Run to end when its Task is stopped')
  expect(stopped.ended?.how).toBe('stopped')
  expect(stopped.asleep).toBeUndefined()
  expect(await agentStarts()).toHaveLength(4)
  await expect(readFile(path.join(home, 'runs', run.id, 'asleep.json'), 'utf8')).rejects.toThrow()
}, 120_000)

// Its own daemon: a wake fails only after the stop grace, so this one needs a short grace.
test('a wake that keeps failing shows a banner until the agent starts', async () => {
  const client = await start({ stopGraceMs: 3_000 })
  await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const task = await client.ok<Task>('POST', '/tasks', {
    title: JSON.stringify({ steps: [{ say: 'ready' }, { endTurn: true }] }),
    factory: 'NB',
    start: true,
  })
  const run = await waitUntil(async () => {
    const leadRunId = (await client.ok<Task[]>('GET', '/tasks')).find(
      (t) => t.id === task.id,
    )?.leadRunId
    if (!leadRunId) return undefined
    const found = (await client.getRun(leadRunId)).run
    return found.state === 'idle' ? found : undefined
  }, 'an idle Task Lead Run')
  await writeFile(
    path.join(home, 'stub-claude.json'),
    JSON.stringify({ resumeSteps: [{ say: 'awake' }, { endTurn: true }] }),
  )
  ahead = 31 * 60_000
  await waitUntil(
    async () => (await client.getRun(run.id)).run.asleep || undefined,
    'the idle Run to be put to sleep',
  )
  const lockPath = path.join(home, 'runs', run.id, 'host.lock')
  const lock = await waitUntil(() => tryLock(lockPath), 'the old host to let go of its lock')
  const wakeBanners = async () =>
    (await client.ok<{ problem: string; text: string }[]>('GET', '/banners')).filter(
      (banner) => banner.problem === 'run-wake-failed',
    )

  await client.call('POST', `/runs/${run.id}/messages`, { text: 'Are you there?' })
  const [banner] = await waitUntil(
    async () => {
      const found = await wakeBanners()
      return found.length > 0 ? found : undefined
    },
    'a banner about the agent that can’t start',
    60_000,
  )
  expect(banner?.text).toContain('NB-1’s Task Lead couldn’t be started again')
  expect((await client.getRun(run.id)).run).toMatchObject({ asleep: true, state: 'idle' })

  lock.release()
  await waitUntil(
    async () =>
      assistantTexts((await client.getRun(run.id)).conversation).includes('awake') || undefined,
    'the agent to start and answer once the host can start',
    60_000,
  )
  await waitUntil(
    async () => ((await wakeBanners()).length === 0 ? true : undefined),
    'the banner to go',
  )
}, 150_000)

test('only a quiet, idle Task Lead with nothing queued may sleep', () => {
  const now = Date.parse('2026-11-16T12:00:00Z')
  const run: Run = {
    id: 'lead',
    agent: 'claude',
    sessionId: 'session',
    permissions: 'auto',
    cwd: '/tmp',
    taskId: 'task',
    state: 'idle',
    startedAt: new Date(now - 3 * 60 * 60_000).toISOString(),
  }
  const facts: SleepFacts = {
    run,
    task: {
      leadRunId: 'lead',
      stopped: false,
      stage: 'work',
      pendingLeadMessages: [],
    },
    lastOutputAt: new Date(now - 30 * 60_000).toISOString(),
    liveSubAgents: 0,
    queuedMessages: 0,
    midWork: false,
    afterMs: 30 * 60_000,
    now,
  }
  expect(maySleep(facts)).toBe(true)
  const refused: Partial<SleepFacts>[] = [
    { lastOutputAt: new Date(now - 29 * 60_000).toISOString() },
    { run: { ...run, state: 'working' } },
    { run: { ...run, state: 'waiting' } },
    { run: { ...run, asleep: true } },
    { run: { ...run, problem: 'model-unavailable' } },
    { run: { ...run, agent: 'antigravity' } },
    { run: { ...run, parentRunId: 'parent' } },
    { run: { ...run, revivedAt: new Date(now - 60_000).toISOString() } },
    {
      run: {
        id: run.id,
        agent: 'claude',
        permissions: 'auto',
        cwd: '/tmp',
        state: 'idle',
        startedAt: run.startedAt,
      },
    },
    { task: { ...facts.task, leadRunId: 'newer' } },
    { task: { ...facts.task, stopped: true } },
    { task: { ...facts.task, pendingLeadMessages: [{}] } },
    { liveSubAgents: 1 },
    { queuedMessages: 1 },
    { midWork: true },
  ]
  for (const change of refused)
    expect(maySleep({ ...facts, ...change }), JSON.stringify(change)).toBe(false)
})
