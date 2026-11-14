import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Factory, Task } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { pruneRunOutput, runOutputEnd } from '../src/retention.ts'
import { openStore, type TedStore } from '../src/store/index.ts'
import {
  api,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

const day = 24 * 60 * 60 * 1000
const line = (n: number) => `${JSON.stringify({ t: 'out', line: `line ${n}` })}\n`

describe('pruning Run output', () => {
  let root: string
  let runsDir: string
  let store: TedStore

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ted-retention-'))
    runsDir = path.join(root, 'runs')
    await mkdir(runsDir)
    store = await openStore({ directory: path.join(root, 'store') })
  })

  afterEach(async () => {
    await store.close()
    vi.useRealTimers()
    await rm(root, { recursive: true, force: true })
  })

  const entry = { layers: [], order: [] }

  async function makeFolder(id: string, writtenDaysAgo = 0): Promise<void> {
    const dir = path.join(runsDir, id)
    await mkdir(dir)
    await writeFile(path.join(dir, 'launch.json'), '{}')
    const file = path.join(dir, 'host.log')
    await writeFile(file, line(1))
    const at = new Date(Date.now() - writtenDaysAgo * day)
    await utimes(file, at, at)
  }

  async function makeRun(taskId?: string, state: 'finished' | 'working' = 'finished') {
    const id = randomUUID()
    store.startRun({
      id,
      agent: 'claude',
      prompt: 'Hi',
      cwd: '/tmp',
      ...(taskId !== undefined && { taskId }),
    })
    if (state === 'finished') {
      store.recordRunOutput(id, {
        toOffset: line(1).length,
        state: 'finished',
        ending: { how: 'exited', code: 0, errorLines: [], at: new Date().toISOString() },
      })
    }
    await makeFolder(id)
    return id
  }

  const prune = (daysFromNow: number) =>
    pruneRunOutput({
      runsDir,
      keepDays: store.settings().runOutputDays,
      endOf: (runId) => runOutputEnd(store, runId),
      now: new Date(Date.now() + daysFromNow * day),
    })

  const kept = async () => (await readdir(runsDir)).sort()

  test('keeps the output of an open Task’s Runs, however old', async () => {
    const task = await store.createTask({ title: 'Fix login' })
    const run = await makeRun(task.id)

    expect(await prune(400)).toEqual({ removed: [] })
    expect(await kept()).toEqual([run])
  })

  test('keeps side-chat snapshots for open Tasks and prunes them with the closed Task', async () => {
    const task = await store.createTask({ title: 'Side chat retention' })
    const source = await makeRun(task.id)
    const id = randomUUID()
    await makeFolder(id)
    store.sideChats.save({
      id,
      sourceRunId: source,
      taskId: task.id,
      factoryId: task.factoryId,
      lead: { agent: 'claude' },
      snapshotAt: new Date().toISOString(),
      truncated: false,
      digest: 'digest',
      contextSent: false,
      outputAfter: 0,
      state: 'ready',
    })
    expect(runOutputEnd(store, id)).toBe('keep')
    expect(await prune(400)).toEqual({ removed: [] })
    store.changeStage(task.id, 'done', entry)
    expect((await prune(8)).removed.sort()).toEqual([source, id].sort())
  })

  test('a queued side question keeps its snapshot after the Task retention deadline', async () => {
    const task = await store.createTask({ title: 'Queued side question' })
    const source = await makeRun(task.id)
    const id = randomUUID()
    await makeFolder(id)
    const chat = {
      id,
      sourceRunId: source,
      taskId: task.id,
      factoryId: task.factoryId,
      lead: { agent: 'claude' as const },
      snapshotAt: new Date().toISOString(),
      truncated: false,
      digest: 'digest',
      contextSent: false,
      outputAfter: 0,
      state: 'queued' as const,
    }
    store.sideChats.save(chat)
    store.changeStage(task.id, 'done', entry)
    expect((await prune(8)).removed).toEqual([source])
    store.sideChats.save({ ...chat, state: 'ready' })
    expect((await prune(8)).removed).toEqual([id])
  })

  test('removes a Done Task’s Run output 7 days after it became Done, and not before', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const task = await store.createTask({ title: 'Fix login' })
    const run = await makeRun(task.id, 'working')
    const sub = await makeRun(task.id, 'working')
    vi.setSystemTime(Date.now() + 1000)
    for (const id of [run, sub]) store.recordRunOutput(id, { toOffset: 1, state: 'finished' })
    store.changeStage(task.id, 'done', entry)
    const intervals = store.taskIntervalHistory(task.id)
    expect(intervals.intervals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'run-working',
          contributors: expect.arrayContaining([
            expect.objectContaining({ id: run }),
            expect.objectContaining({ id: sub }),
          ]),
        }),
      ]),
    )

    expect(await prune(6)).toEqual({ removed: [] })
    expect(await kept()).toEqual([run, sub].sort())

    expect((await prune(8)).removed.sort()).toEqual([run, sub].sort())
    expect(await kept()).toEqual([])
    expect(store.taskIntervalHistory(task.id, intervals.asOf)).toEqual(intervals)
  })

  test('an archived Task follows the same rule, and unarchiving it keeps its output again', async () => {
    const archived = await store.createTask({ title: 'Fix login' })
    const back = await store.createTask({ title: 'Add dark mode' })
    const gone = await makeRun(archived.id)
    const stays = await makeRun(back.id)
    store.archiveTask(archived.id)
    store.archiveTask(back.id)

    expect(await prune(6)).toEqual({ removed: [] })

    store.unarchiveTask(back.id, { queue: false, waitForBlockers: false })
    expect(await prune(8)).toEqual({ removed: [gone] })
    expect(await kept()).toEqual([stays])
  })

  test('never touches a live Run, even one of a Task that was Done long ago', async () => {
    const task = await store.createTask({ title: 'Fix login' })
    const live = await makeRun(task.id, 'working')
    const devRun = await makeRun(undefined, 'working')
    store.changeStage(task.id, 'done', entry)

    expect(await prune(400)).toEqual({ removed: [] })
    expect(await kept()).toEqual([live, devRun].sort())
  })

  test('the number of days comes from the runOutputDays setting', async () => {
    const task = await store.createTask({ title: 'Fix login' })
    const run = await makeRun(task.id)
    store.changeStage(task.id, 'done', entry)

    store.updateSettings({ runOutputDays: 30 })
    expect(await prune(8)).toEqual({ removed: [] })

    store.updateSettings({ runOutputDays: 2 })
    expect(await prune(3)).toEqual({ removed: [run] })
  })

  test('a Run without a Task is removed 7 days after it finished', async () => {
    const run = await makeRun()

    expect(await prune(6)).toEqual({ removed: [] })
    expect(await prune(8)).toEqual({ removed: [run] })
  })

  test('keeps every Run of a Coordinator while the Coordinator exists', async () => {
    const first = await makeRun()
    const second = await makeRun()
    store.coordinators.save({
      factoryId: 'factory-1',
      runId: second,
      runIds: [first, second],
      lead: { agent: 'claude' },
      phase: 'ready',
      opening: '',
      receipts: [],
      taskIds: [],
    })

    expect(await prune(400)).toEqual({ removed: [] })

    store.coordinators.remove('factory-1')
    expect(await prune(6)).toEqual({ removed: [] })
    expect((await prune(8)).removed.sort()).toEqual([first, second].sort())
  })

  test('keeps a plan’s output for as long as the plan exists, whatever its outcome', async () => {
    const plan = (title: string) =>
      store.plans.start({ factoryId: 'factory-1', title, message: 'Plan it', agent: 'claude' })
    const open = plan('Open')
    const failed = plan('Failed')
    const stopped = plan('Stopped')
    const finished = plan('Finished')
    for (const { id } of [open, failed, stopped, finished]) {
      store.plans.began(id, [])
      store.startRun({ id, agent: 'claude', prompt: 'Plan', cwd: '/tmp' })
      store.recordRunOutput(id, { toOffset: 1, state: 'finished' })
      await makeFolder(id)
    }
    store.plans.ended(failed.id, { outcome: 'failed', error: 'no' })
    store.plans.ended(stopped.id, { outcome: 'stopped' })
    store.plans.ended(finished.id, { outcome: 'finished' })

    expect(await prune(400)).toEqual({ removed: [] })
    expect(await kept()).toEqual([open.id, failed.id, stopped.id, finished.id].sort())
  })

  test('an Automation Run is removed 7 days after its firing ended', async () => {
    const at = new Date().toISOString()
    const running = store.automations.fire({ automationId: 'a-1', trigger: 'run-now', at })
    const ended = store.automations.fire({ automationId: 'a-1', trigger: 'run-now', at })
    for (const { id } of [running, ended]) {
      store.automations.began(id)
      store.startRun({ id, agent: 'claude', prompt: 'Go', cwd: '/tmp' })
      store.recordRunOutput(id, { toOffset: 1, state: 'finished' })
      await makeFolder(id)
    }
    store.automations.ended(ended.id, { outcome: 'finished' })

    expect(await prune(6)).toEqual({ removed: [] })
    expect(await prune(400)).toEqual({ removed: [ended.id] })
    expect(await kept()).toEqual([running.id])
  })

  test('a Run folder the store doesn’t know is removed 7 days after it was last written', async () => {
    const old = randomUUID()
    const recent = randomUUID()
    await makeFolder(old, 8)
    await makeFolder(recent, 6)

    expect(await prune(0)).toEqual({ removed: [old] })
    expect(await kept()).toEqual([recent])
  })

  test('never follows a link or touches anything that isn’t a Run folder', async () => {
    const outside = path.join(root, 'outside')
    await mkdir(outside)
    await writeFile(path.join(outside, 'host.log'), line(1))
    const old = new Date(Date.now() - 30 * day)
    await utimes(path.join(outside, 'host.log'), old, old)
    const linked = randomUUID()
    await symlink(outside, path.join(runsDir, linked))
    await writeFile(path.join(runsDir, 'notes.txt'), 'keep me')
    await mkdir(path.join(runsDir, '..weird'))
    await mkdir(path.join(runsDir, 'not-a-run-id'))
    await utimes(path.join(runsDir, 'not-a-run-id'), old, old)
    await writeFile(path.join(runsDir, randomUUID()), 'a file, not a folder')

    expect(await prune(400)).toEqual({ removed: [] })
    expect(await readdir(outside)).toEqual(['host.log'])
    expect(await readdir(runsDir)).toHaveLength(5)
  })
})

describe('Run output retention in the daemon', () => {
  let home: string
  let cleanup: () => Promise<void>
  let scratch: string
  let origin: string
  let daemon: RunningDaemon | undefined

  beforeEach(async () => {
    ;({ home, cleanup } = await makeTempHome())
    scratch = await mkdtemp(path.join(tmpdir(), 'ted-origin-'))
    origin = await makeOriginRepo(scratch)
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
  })

  afterEach(async () => {
    await daemon?.stop()
    daemon = undefined
    await killRunHosts(home)
    await cleanup()
    await rm(scratch, { recursive: true, force: true })
  })

  async function start(daysFromNow = 0) {
    daemon = await startDaemon({
      home,
      version: '9.9.9',
      claudeBin: stubClaudePath,
      retention: { now: () => new Date(Date.now() + daysFromNow * day), checkEveryMs: 200 },
    })
    return api(daemon.port, { appKey: daemon.appToken })
  }

  const runFolders = () => readdir(path.join(home, 'runs'))

  test('a Done Task’s Run chat stays for 7 days, then shows “Output no longer kept”; a shorter setting removes it sooner', async () => {
    let client = await start()
    const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
      const res = await client.call(method, route, body)
      if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
      return res.body as T
    }
    await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
    const advance = ['ted', 'outcome', 'advance']
    const title = JSON.stringify({
      steps: [{ say: 'working on it' }, { everyMessage: [{ run: advance }] }, { run: advance }],
    })
    const done = await ok<Task>('POST', '/tasks', { title, factory: 'NB', start: true })
    const open = await ok<Task>('POST', '/tasks', {
      title: JSON.stringify({ steps: [{ say: 'still here' }, { endTurn: true }] }),
      factory: 'NB',
      start: true,
    })
    const task = (id: string) =>
      waitUntil(
        async () => (await ok<Task[]>('GET', '/tasks')).find((t) => t.id === id),
        'the Task',
      )
    await waitUntil(async () => ((await task(done.id)).stage === 'done' ? true : undefined), 'Done')
    const openRun = await waitUntil(async () => (await task(open.id)).leadRunId, 'a Task Lead')
    await waitUntil(
      async () => (await client.getRun(openRun)).run.state === 'idle' || undefined,
      'the open Task’s Run to go idle',
    )
    await ok('POST', `/tasks/${open.id}/stop`)
    await waitUntil(
      async () => (await client.getRun(openRun)).run.state === 'finished' || undefined,
      'the open Task’s Run to stop',
    )
    const doneRun = (await runFolders()).find((id) => id !== openRun) as string
    await waitUntil(
      async () => (await client.getRun(doneRun)).run.state === 'finished' || undefined,
      'the Done Task’s Run to finish',
    )
    expect((await client.getRun(doneRun)).run).toMatchObject({ taskId: done.id, state: 'finished' })
    const before = await client.call('GET', `/runs/${doneRun}/chat`)
    expect(JSON.stringify(before.body.items)).toContain('working on it')
    await daemon?.stop()

    client = await start(6)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect((await runFolders()).sort()).toEqual([doneRun, openRun].sort())

    await ok('PATCH', '/settings', { runOutputDays: 5 })
    await waitUntil(
      async () => !(await runFolders()).includes(doneRun) || undefined,
      'the Done Task’s Run output to be removed',
    )
    expect(await runFolders()).toEqual([openRun])
    const chat = await client.call('GET', `/runs/${doneRun}/chat`)
    expect(chat.status).toBe(200)
    expect(chat.body.items).toContainEqual({
      kind: 'ted',
      id: 'output-not-kept',
      title: 'Output no longer kept',
      text: 'TED no longer keeps this Run’s output, so its messages and tool calls can’t be shown.',
    })
    expect((await task(done.id)).stage).toBe('done')
    const kept = await client.call('GET', `/runs/${openRun}/chat`)
    expect(JSON.stringify(kept.body.items)).toContain('still here')
  })
})
