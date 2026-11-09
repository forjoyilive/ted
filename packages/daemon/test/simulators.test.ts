import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  Banner,
  Comment,
  Factory,
  SimulatorSlots,
  Task,
  TaskApp,
  ThreadEvent,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  assistantTexts,
  commitToOrigin,
  killAppHosts,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

const runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-26-0'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let stubState: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-sims-'))
  origin = await makeOriginRepo(scratch)
  stubState = path.join(scratch, 'xcrun.json')
  await writeStub({})
  process.env.TED_STUB_XCRUN = stubState
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  delete process.env.TED_STUB_XCRUN
  await killAppHosts(home)
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

interface StubDevice {
  udid: string
  name: string
  state: string
}

async function writeStub(extra: Record<string, unknown>) {
  await writeFile(
    stubState,
    JSON.stringify({
      xcode: true,
      runtimes: [{ identifier: runtime, name: 'iOS 26.0', platform: 'iOS', isAvailable: true }],
      deviceTypes: [
        { name: 'iPhone 17', identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' },
      ],
      devices: {
        [runtime]: [
          {
            udid: 'BASE-IPHONE-17',
            name: 'iPhone 17',
            state: 'Shutdown',
            isAvailable: true,
            deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17',
          },
        ],
      },
      ...extra,
    }),
  )
}

async function stubDevices(): Promise<StubDevice[]> {
  const state = JSON.parse(await readFile(stubState, 'utf8')) as {
    devices: Record<string, StubDevice[]>
  }
  return Object.values(state.devices).flat()
}

async function stubCalls(): Promise<string[][]> {
  const text = await readFile(`${stubState}.calls`, 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as string[])
}

async function start(simulators: { supported?: boolean; idleMs?: number } = {}) {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    apps: { pollMs: 50, readyTimeoutMs: 20_000, stopGraceMs: 3_000 },
    simulators: { supported: true, pollMs: 100, ...simulators },
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  return { ...client, ok }
}

type Client = Awaited<ReturnType<typeof start>>

const udids = () => path.join(scratch, 'udids.txt')

const workflow = (
  run = `echo \\"$TED_TASK $TED_SIMULATOR_UDID\\" >> '${udids()}'; exec sleep 600`,
) =>
  [
    'version: 1',
    'order: [intake, work, merge]',
    'repos:',
    '  - name: widgets',
    '    apps:',
    '      - name: iPhone',
    '        kind: ios-simulator',
    '        device: "iPhone 17"',
    `        run: "${run}"`,
  ].join('\n')

async function addFactory(client: Client, run?: string) {
  await commitToOrigin(scratch, { '.ted/workflow.yaml': workflow(run) })
  await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
}

async function taskWithWorktree(client: Client, title = '{"steps": [{"endTurn": true}]}') {
  const task = await client.ok<Task>('POST', '/tasks', { title, factory: 'NB' })
  await client.ok('POST', `/tasks/${task.id}/start`)
  await waitUntil(async () => (await taskNow(client, task)).leadRunId, 'the Task Lead Run')
  return task
}

const taskNow = async (client: Client, task: Task) =>
  (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id) as Task

const apps = (client: Client, task: Task) => client.ok<TaskApp[]>('GET', `/tasks/${task.id}/apps`)

const iPhone = async (client: Client, task: Task) =>
  (await apps(client, task)).find((a) => a.name === 'iPhone')

const waitForApp = (client: Client, task: Task, check: (app: TaskApp) => boolean, what: string) =>
  waitUntil(async () => {
    const app = await iPhone(client, task)
    return app && check(app) ? app : undefined
  }, what)

const eventText = (client: Client, task: Task, text: string) =>
  waitUntil(
    async () =>
      (await client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)).find(
        (e) => e.text === text,
      ),
    `the thread event “${text}”`,
  )

async function leadResult(client: Client, task: Task) {
  const lead = (await taskNow(client, task)).leadRunId as string
  const [result] = await waitUntil(
    async () => {
      const texts = assistantTexts((await client.getRun(lead)).conversation)
      return texts.length >= 1 ? texts : undefined
    },
    'the Task Lead’s ted run-app',
    20_000,
  )
  return JSON.parse(result ?? '{}') as { code: number; stdout: string; stderr: string }
}

const runAppTitle = JSON.stringify({
  steps: [
    { run: ['ted', 'run-app', 'iPhone', '--reason', 'Validate wants to record the swipe.'] },
    { endTurn: true },
  ],
})

async function simulatorRequest(client: Client, task: Task): Promise<Comment> {
  return waitUntil(
    async () =>
      (await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)).find(
        (c) => c.simulator !== undefined && c.answer === undefined,
      ),
    'the simulator request',
    20_000,
  )
}

describe('iOS simulator Apps', () => {
  test('▶ clones a device for the Task, boots it, runs the App with its UDID, and archiving deletes it', async () => {
    const client = await start()
    await addFactory(client)
    const task = await taskWithWorktree(client)

    expect(await iPhone(client, task)).toMatchObject({ kind: 'ios-simulator', state: 'stopped' })
    const started = await client.ok<TaskApp>('POST', `/tasks/${task.id}/apps/start`, {
      name: 'iPhone',
    })
    expect(started).toMatchObject({
      state: 'running',
      simulator: { device: 'iPhone 17', booted: true },
    })
    const clone = (await stubDevices()).find((d) => d.name === 'TED NB-1 iPhone')
    expect(clone?.state).toBe('Booted')
    expect((await stubCalls()).some((c) => c[0] === 'simctl' && c[1] === 'clone')).toBe(true)
    expect(
      (await stubCalls()).some(
        (c) => c.includes('-g') && c.includes('Simulator') && c.includes(clone?.udid ?? ''),
      ),
    ).toBe(true)
    await waitUntil(
      async () => (await readFile(udids(), 'utf8').catch(() => '')).trim() || undefined,
      'the App to start',
      20_000,
    )
    expect((await readFile(udids(), 'utf8')).trim()).toBe(`NB-1 ${clone?.udid}`)

    const slots = await client.ok<SimulatorSlots>('GET', '/simulators')
    expect(slots).toMatchObject({ supported: true, limit: 3 })
    expect(slots.booted.map((s) => [s.displayId, s.app, s.recording])).toEqual([
      ['NB-1', 'iPhone', false],
    ])

    await client.ok('POST', `/tasks/${task.id}/apps/show`, { name: 'iPhone' })
    expect(
      (await stubCalls()).some(
        (c) => c[0] === '-a' && c.includes(clone?.udid ?? '') && !c.includes('-g'),
      ),
    ).toBe(true)

    const stopped = await client.ok<TaskApp>('POST', `/tasks/${task.id}/apps/stop`, {
      name: 'iPhone',
    })
    expect(stopped.state).toBe('stopped')
    expect(stopped.simulator).toMatchObject({ booted: false })
    expect((await stubDevices()).find((d) => d.udid === clone?.udid)?.state).toBe('Shutdown')

    const again = await client.ok<TaskApp>('POST', `/tasks/${task.id}/apps/start`, {
      name: 'iPhone',
    })
    expect(again.simulator?.booted).toBe(true)
    expect((await stubDevices()).filter((d) => d.name === 'TED NB-1 iPhone')).toHaveLength(1)

    await client.ok('POST', `/tasks/${task.id}/archive`)
    await waitUntil(
      async () => !(await stubDevices()).some((d) => d.udid === clone?.udid),
      'the device to be deleted',
    )
    expect((await client.ok<SimulatorSlots>('GET', '/simulators')).booted).toEqual([])
  })

  test('with every slot booted the human must pick one to shut down', async () => {
    const client = await start()
    await addFactory(client)
    await client.ok('PATCH', '/settings', { maxBootedSimulators: 1 })
    const first = await taskWithWorktree(client)
    const second = await taskWithWorktree(client)
    await client.ok('POST', `/tasks/${first.id}/apps/start`, { name: 'iPhone' })

    const refused = await client.call('POST', `/tasks/${second.id}/apps/start`, {
      name: 'iPhone',
    })
    expect(refused.status).toBe(409)
    expect((refused.body as { error: string }).error).toBe(
      'The only simulator slot is taken. Choose a simulator to shut down, then run iPhone again.',
    )
    const [booted] = (await client.ok<SimulatorSlots>('GET', '/simulators')).booted
    expect(booted?.displayId).toBe('NB-1')

    const started = await client.ok<TaskApp>('POST', `/tasks/${second.id}/apps/start`, {
      name: 'iPhone',
      shutDown: booted?.udid,
    })
    expect(started.simulator?.booted).toBe(true)
    const firstApp = await waitForApp(
      client,
      first,
      (a) => a.state === 'stopped',
      'NB-1’s iPhone to stop',
    )
    expect(firstApp.simulator).toMatchObject({ booted: false, shutDown: { for: 'NB-2' } })
    await eventText(client, first, 'TED shut down iPhone’s simulator to free a slot for NB-2')
    const slots = await client.ok<SimulatorSlots>('GET', '/simulators')
    expect(slots.booted.map((s) => s.displayId)).toEqual(['NB-2'])
  })

  test('a Run that needs a slot asks the human, and Deny reaches ted run-app', async () => {
    const client = await start()
    await addFactory(client)
    await client.ok('PATCH', '/settings', { maxBootedSimulators: 1 })
    const first = await taskWithWorktree(client)
    await client.ok('POST', `/tasks/${first.id}/apps/start`, { name: 'iPhone' })
    const second = await taskWithWorktree(client, runAppTitle)

    const request = await simulatorRequest(client, second)
    expect(request).toMatchObject({
      kind: 'permission',
      title: 'iPhone needs a simulator · 1 of 1 booted',
      body: 'Validate wants to record the swipe. Pick one to shut down, or deny and the Task Lead carries on without iPhone.',
      simulator: { app: 'iPhone', device: 'iPhone 17', limit: 1 },
    })
    expect(request.simulator?.booted.map((b) => b.displayId)).toEqual(['NB-1'])
    const waiting = await taskNow(client, second)
    expect(waiting.status?.kind).toBe('waiting-on-you')
    expect(waiting.activity).toBe('Waiting for a simulator slot')
    expect((await iPhone(client, second))?.state).toBe('waiting')

    await client.ok('POST', `/comments/${request.id}/answer`, { action: 'deny' })

    const result = await leadResult(client, second)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('No simulator slot: the human denied')
    expect((await iPhone(client, first))?.simulator?.booted).toBe(true)
  })

  test('approving shuts down the chosen simulator and runs the App', async () => {
    const client = await start()
    await addFactory(client)
    await client.ok('PATCH', '/settings', { maxBootedSimulators: 1 })
    const first = await taskWithWorktree(client)
    await client.ok('POST', `/tasks/${first.id}/apps/start`, { name: 'iPhone' })
    const second = await taskWithWorktree(client, runAppTitle)
    const request = await simulatorRequest(client, second)

    const answered = await client.ok<Comment>('POST', `/comments/${request.id}/answer`, {
      action: 'approve',
      simulator: request.simulator?.booted[0]?.udid,
    })
    expect(answered.answer).toMatchObject({ kind: 'approved', shutDown: 'NB-1' })

    const result = await leadResult(client, second)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('iPhone is running on iPhone 17')
    expect((await iPhone(client, first))?.simulator?.shutDown?.for).toBe('NB-2')
  })

  test('a slot that frees up first closes the request without shutting anything down', async () => {
    const client = await start()
    await addFactory(client)
    await client.ok('PATCH', '/settings', { maxBootedSimulators: 1 })
    const first = await taskWithWorktree(client)
    await client.ok('POST', `/tasks/${first.id}/apps/start`, { name: 'iPhone' })
    const second = await taskWithWorktree(client, runAppTitle)
    const request = await simulatorRequest(client, second)

    await client.ok('POST', `/tasks/${first.id}/apps/stop`, { name: 'iPhone' })

    const result = await leadResult(client, second)
    expect(result.code).toBe(0)
    const closed = await client.ok<Comment[]>('GET', `/tasks/${second.id}/comments`)
    expect(closed.find((c) => c.id === request.id)?.answer).toMatchObject({
      kind: 'withdrawn',
      slotFreed: true,
    })
    expect((await iPhone(client, first))?.simulator?.shutDown?.for).toBeUndefined()
  })

  test('an idle simulator is shut down', async () => {
    const client = await start({ idleMs: 500 })
    await addFactory(client, 'echo built')
    const task = await taskWithWorktree(client)
    await client.ok('POST', `/tasks/${task.id}/apps/start`, { name: 'iPhone' })
    await waitForApp(client, task, (a) => a.state === 'exited', 'the build to finish')

    const idle = await waitForApp(
      client,
      task,
      (a) => a.simulator?.booted === false,
      'the simulator to shut down',
    )
    expect(idle.simulator?.shutDown?.for).toBeUndefined()
    await eventText(client, task, 'TED shut down iPhone’s simulator because it was idle')
    expect((await client.ok<SimulatorSlots>('GET', '/simulators')).booted).toEqual([])
  })

  test('ted app screenshot and record save files to the Task', async () => {
    const client = await start()
    await addFactory(client)
    const task = await taskWithWorktree(
      client,
      JSON.stringify({
        steps: [
          { run: ['ted', 'run-app', 'iPhone'] },
          { run: ['ted', 'app', 'screenshot', 'iPhone'] },
          { run: ['ted', 'app', 'record', 'iPhone', '--start'] },
          { run: ['ted', 'app', 'record', 'iPhone', '--stop'] },
          { endTurn: true },
        ],
      }),
    )
    const lead = (await taskNow(client, task)).leadRunId as string
    const results = await waitUntil(
      async () => {
        const texts = assistantTexts((await client.getRun(lead)).conversation)
        return texts.length >= 4
          ? texts.map((t) => JSON.parse(t) as { code: number; stdout: string })
          : undefined
      },
      'the captures',
      30_000,
    )
    expect(results.map((r) => r.code)).toEqual([0, 0, 0, 0])
    expect(results[1]?.stdout).toBe('Saved iPhone screenshot.png to the Task\n')
    expect(results[3]?.stdout).toBe('Saved iPhone recording.mov to the Task\n')
    const notes = (await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)).filter(
      (c) => c.attachments !== undefined,
    )
    expect(notes.map((c) => [c.body, c.attachments?.[0]?.mediaType])).toEqual([
      ['Screenshot of iPhone', 'image/png'],
      ['Recording of iPhone', 'video/quicktime'],
    ])
    const bytes = await client.ok<{ data: string }>(
      'GET',
      `/attachments/${notes[1]?.attachments?.[0]?.hash}/${encodeURIComponent('iPhone recording.mov')}`,
    )
    expect(Buffer.from(bytes.data, 'base64').toString()).toBe('MOV of TED NB-1 iPhone finished')
  })

  test('missing Xcode raises a stops-work Factory banner', async () => {
    await writeStub({ xcode: false })
    const client = await start()
    await addFactory(client)
    const task = await taskWithWorktree(client)

    const res = await client.call('POST', `/tasks/${task.id}/apps/start`, { name: 'iPhone' })
    expect(res.status).toBe(409)
    expect((res.body as { error: string }).error).toContain('Xcode not found')
    const banners = await client.ok<Banner[]>('GET', '/banners')
    expect(banners.find((b) => b.problem === 'simulator-tools')).toMatchObject({
      severity: 'stops-work',
      text: 'Xcode not found · iOS simulator Apps can’t start',
    })

    await writeStub({})
    const banner = banners.find((b) => b.problem === 'simulator-tools')
    await client.ok('POST', `/banners/${banner?.id}/action`, {})
    await waitUntil(
      async () =>
        !(await client.ok<Banner[]>('GET', '/banners')).some(
          (b) => b.problem === 'simulator-tools',
        ),
      'the banner to clear',
    )
  })

  test('nothing about simulators shows where they aren’t supported', async () => {
    const client = await start({ supported: false })
    await addFactory(client)
    const task = await taskWithWorktree(client)
    expect(await iPhone(client, task)).toBeUndefined()
    expect(await client.ok<SimulatorSlots>('GET', '/simulators')).toEqual({
      supported: false,
      limit: 3,
      booted: [],
    })
    expect(await stubCalls()).toEqual([])
  })
})
