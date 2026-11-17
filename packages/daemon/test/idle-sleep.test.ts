import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Coordinator, Factory, Run, RunSummary, Task } from '@ted/protocol'
import type { JsonObject } from '@ted/protocol/parse'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { tryLock } from '../src/lock.ts'
import {
  maySleep,
  type Sleeper,
  type SleepFacts,
  sleepAfterMs,
  sleepKind,
} from '../src/runs/idle-sleep.ts'
import type { StoredCoordinator } from '../src/store/coordinators.ts'
import type { StoredPlan } from '../src/store/plans.ts'
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

// Its own setup: the Lead starts a sub-agent, which the first test has no part of.
test('an idle sub-agent and then its Lead sleep, stay asleep across a daemon restart, and the sub-agent wakes for ted run send', async () => {
  let client = await start()
  await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const prompt = path.join(scratch, 'explore.md')
  await writeFile(
    prompt,
    `# Explore\n\n${JSON.stringify({ steps: [{ say: 'First answer' }, { endTurn: true }] })}\n`,
  )
  const task = await client.ok<Task>('POST', '/tasks', {
    title: JSON.stringify({
      steps: [{ run: ['sh', '-c', `ted run start --prompt-file ${prompt}`] }, { endTurn: true }],
    }),
    factory: 'NB',
    start: true,
  })
  const taskRuns = () => client.ok<RunSummary[]>('GET', `/tasks/${task.id}/runs`)
  const [lead, sub] = await waitUntil(async () => {
    const runs = await taskRuns()
    const found = [runs.find((r) => r.role === 'lead'), runs.find((r) => r.role === 'sub-agent')]
    return found.every((r) => r?.state === 'idle') ? found : undefined
  }, 'an idle Task Lead and an idle sub-agent')
  if (!lead || !sub) throw new Error('no Lead or sub-agent')
  const bothAsleep = (what: string) =>
    waitUntil(async () => {
      const runs = await Promise.all(
        [lead.id, sub.id].map(async (id) => (await client.getRun(id)).run),
      )
      return runs.every((run) => run.asleep) ? runs : undefined
    }, what)
  const [subStart] = await hostStarts(sub.id)

  ahead = 31 * 60_000
  await bothAsleep('the sub-agent and then its Lead to be put to sleep')
  await waitUntil(
    () =>
      (!isAlive(Number(subStart?.hostPid)) && !isAlive(Number(subStart?.agentPid))) || undefined,
    'the sub-agent’s host and agent to exit',
  )

  await daemon?.stop()
  client = await start()
  await bothAsleep('both Runs to stay asleep under a new daemon')
  expect(await hostStarts(sub.id)).toHaveLength(1)

  const followUp = path.join(scratch, 'follow-up.txt')
  await writeFile(
    followUp,
    JSON.stringify({ steps: [{ say: 'Second answer' }, { endTurn: true }] }),
  )
  const short = sub.id.slice(0, 6)
  await client.ok('POST', `/tasks/${task.id}/comments`, {
    body: JSON.stringify({
      steps: [
        {
          run: [
            'sh',
            '-c',
            `ted run send ${short} "$(cat ${followUp})" >/dev/null && ted run wait ${short}`,
          ],
        },
        { endTurn: true },
      ],
    }),
  })
  const waited = await waitUntil(async () => {
    const said = assistantTexts((await client.getRun(lead.id)).conversation)
    return said.find((text) => text.includes('Second answer'))
  }, 'ted run wait to return the woken sub-agent’s answer')
  expect(JSON.parse(waited)).toMatchObject({ code: 0 })
  const resumed = (await agentStarts()).at(-1)?.argv ?? []
  expect(resumed[resumed.indexOf('--resume') + 1]).toBe((await client.getRun(sub.id)).run.sessionId)
  expect((await agentEnv()).TED_TASK).toBe('NB-1')

  await bothAsleep('both Runs to sleep again')
  const starts = (await agentStarts()).length
  await client.ok('POST', `/tasks/${task.id}/stop`)
  await waitUntil(
    async () => ((await client.getRun(sub.id)).run.state === 'finished' ? true : undefined),
    'the sleeping sub-agent to end when its Task is stopped',
  )
  expect(await agentStarts()).toHaveLength(starts)
}, 120_000)

// Its own setup: a Coordinator chat, with no Task.
test('an idle Coordinator chat sleeps, stays asleep across a daemon restart and wakes for the next message', async () => {
  let client = await start()
  const factory = await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const chat = await client.ok<Coordinator>('POST', `/factories/${factory.id}/coordinator-chats`, {
    text: JSON.stringify({ steps: [{ say: 'Hello' }, { endTurn: true }] }),
    agent: 'claude',
  })
  const run = await waitUntil(async () => {
    const found = (await client.getRun(chat.runId)).run
    return found.state === 'idle' && found.sessionId !== undefined ? found : undefined
  }, 'an idle Coordinator Run')
  const asleep = (what: string) =>
    waitUntil(async () => (await client.getRun(run.id)).run.asleep || undefined, what)
  const [first] = await hostStarts(run.id)

  ahead = 31 * 60_000
  await asleep('the idle Coordinator Run to be put to sleep')
  await waitUntil(
    () => (!isAlive(Number(first?.hostPid)) && !isAlive(Number(first?.agentPid))) || undefined,
    'the host and the agent to exit',
  )
  await daemon?.stop()
  client = await start()
  await asleep('the Coordinator Run to stay asleep under a new daemon')

  await client.ok('POST', `/coordinator-chats/${chat.id}/messages`, {
    text: JSON.stringify({ steps: [{ say: 'Back' }, { endTurn: true }] }),
  })
  await waitUntil(
    async () =>
      assistantTexts((await client.getRun(run.id)).conversation).includes('Back') || undefined,
    'the woken Coordinator to answer',
  )
  expect((await client.ok<Coordinator>('GET', `/coordinator-chats/${chat.id}`)).runId).toBe(run.id)
  expect(await hostStarts(run.id)).toHaveLength(2)
  const record = JSON.parse(await readFile(path.join(run.cwd, 'stub-record.json'), 'utf8')) as {
    argv: string[]
    env: Record<string, string | undefined>
  }
  expect(record.env.TED_CHAT).toBe(chat.id)
  expect(record.argv[record.argv.indexOf('--resume') + 1]).toBe(run.sessionId)
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

test('only a quiet, idle Run of a kind that can wake again, with nothing queued, may sleep', () => {
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
  const task = {
    leadRunId: 'lead',
    stopped: false,
    stage: 'work' as const,
    pendingLeadMessages: [],
  }
  const lead: Sleeper = { kind: 'lead', task, workingSubAgents: 0, midWork: false }
  const facts: SleepFacts = {
    run,
    sleeper: lead,
    lastOutputAt: new Date(now - 30 * 60_000).toISOString(),
    queuedMessages: 0,
    afterMs: 30 * 60_000,
    now,
  }
  expect(maySleep(facts)).toBe(true)
  const refused: Partial<SleepFacts>[] = [
    { sleeper: undefined },
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
    { sleeper: { ...lead, task: { ...task, leadRunId: 'newer' } } },
    { sleeper: { ...lead, task: { ...task, stopped: true } } },
    { sleeper: { ...lead, task: { ...task, stage: 'done' } } },
    { sleeper: { ...lead, task: { ...task, pendingLeadMessages: [{}] } } },
    { sleeper: { ...lead, workingSubAgents: 1 } },
    { sleeper: { ...lead, midWork: true } },
    { queuedMessages: 1 },
  ]
  for (const change of refused)
    expect(maySleep({ ...facts, ...change }), JSON.stringify(change)).toBe(false)

  const sub: SleepFacts = {
    ...facts,
    run: { ...run, id: 'sub', parentRunId: 'lead' },
    sleeper: { kind: 'sub-agent', task, parentLive: true },
  }
  expect(maySleep(sub)).toBe(true)
  for (const sleeper of [
    { kind: 'sub-agent', task, parentLive: false },
    { kind: 'sub-agent', task: undefined, parentLive: true },
    { kind: 'sub-agent', task: { ...task, stage: 'backlog' }, parentLive: true },
  ] satisfies Sleeper[])
    expect(maySleep({ ...sub, sleeper }), JSON.stringify(sleeper)).toBe(false)
  expect(maySleep({ ...sub, run })).toBe(false)

  const { taskId: _, ...chatRun } = run
  const chat: SleepFacts = {
    ...facts,
    run: { ...chatRun, id: 'chat' },
    sleeper: { kind: 'chat', rests: true },
  }
  expect(maySleep(chat)).toBe(true)
  expect(maySleep({ ...chat, sleeper: { kind: 'chat', rests: false } })).toBe(false)
  expect(maySleep({ ...chat, run: { ...chat.run, taskId: 'task' } })).toBe(false)
  expect(maySleep({ ...chat, queuedMessages: 1 })).toBe(false)
})

test('a Run’s kind decides whether it can sleep at all', () => {
  const run: Run = {
    id: 'r',
    agent: 'claude',
    permissions: 'auto',
    cwd: '/tmp',
    state: 'idle',
    startedAt: '2026-11-16T12:00:00Z',
  }
  const none = { coordinators: { forRun: () => undefined }, plans: { get: () => undefined } }
  expect(sleepKind({ ...run, taskId: 't' }, none)).toBe('lead')
  expect(sleepKind({ ...run, taskId: 't', parentRunId: 'p' }, none)).toBe('sub-agent')
  expect(sleepKind(run, none)).toBeUndefined()
  expect(sleepKind({ ...run, parentRunId: 'p' }, none)).toBeUndefined()
  const coordinator = { id: 'c', runId: 'r' } as StoredCoordinator
  expect(sleepKind(run, { ...none, coordinators: { forRun: () => coordinator } })).toBe('chat')
  expect(
    sleepKind(run, {
      ...none,
      coordinators: { forRun: () => ({ ...coordinator, runId: 'older' }) },
    }),
  ).toBeUndefined()
  expect(sleepKind(run, { ...none, plans: { get: () => ({ id: 'r' }) as StoredPlan } })).toBe(
    'chat',
  )
})

test('while the computer is busy, idle Runs sleep after 2 minutes, or sooner if the setting says so', () => {
  expect(sleepAfterMs(10, false)).toBe(10 * 60_000)
  expect(sleepAfterMs(10, true)).toBe(2 * 60_000)
  expect(sleepAfterMs(1, true)).toBe(60_000)
})
