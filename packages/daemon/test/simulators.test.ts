import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  Automation,
  AutomationDetail,
  AutomationTemplate,
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
import { checkCpus } from '../src/tasks/check-slots.ts'
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
  deviceTypeIdentifier?: string
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

const workflow = (run = 'echo udid $TED_TASK $TED_SIMULATOR_UDID; exec sleep 600') =>
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
    '      - name: Watch',
    '        kind: ios-simulator',
    '        device: "iPhone 17"',
    '        run: "exec sleep 600"',
  ].join('\n')

const cpusFile = () => path.join(scratch, 'cpus')

const cpusTold = (count: number) =>
  waitUntil(async () => {
    const lines = (await readFile(cpusFile(), 'utf8').catch(() => '')).split('\n').filter(Boolean)
    return lines.length === count ? lines : undefined
  }, `${count} Apps to be told their CPUs`)

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
    await addFactory(
      client,
      'test -d $TED_DERIVED_DATA && echo udid $TED_TASK $TED_SIMULATOR_UDID $TED_DERIVED_DATA; exec sleep 600',
    )
    const task = await taskWithWorktree(client)

    expect(await iPhone(client, task)).toMatchObject({ kind: 'ios-simulator', state: 'stopped' })
    const started = await client.ok<TaskApp>('POST', `/tasks/${task.id}/apps/start`, {
      name: 'iPhone',
    })
    expect(started).toMatchObject({
      state: 'running',
      simulator: { device: 'iPhone 17', booted: true },
    })
    const clone = (await stubDevices()).find((d) => d.name === 'Ted Dev NB-1 iPhone')
    expect(clone?.state).toBe('Booted')
    expect((await stubCalls()).some((c) => c[0] === 'simctl' && c[1] === 'clone')).toBe(true)
    expect(
      (await stubCalls()).some(
        (c) => c.includes('-g') && c.includes('Simulator') && c.includes(clone?.udid ?? ''),
      ),
    ).toBe(true)
    const line = await waitUntil(
      async () =>
        (await client.ok<{ text: string }>('GET', `/tasks/${task.id}/apps/widgets/iPhone/log`)).text
          .split('\n')
          .find((l) => l.startsWith('udid ')),
      'the App to start',
      20_000,
    )
    const taskCache = path.join(await realpath(home), 'sandbox', 'NB-1')
    expect(line).toBe(`udid NB-1 ${clone?.udid} ${taskCache}/cache/xcode/DerivedData`)

    const slots = await client.ok<SimulatorSlots>('GET', '/simulators')
    expect(slots).toMatchObject({ supported: true, limit: 2 })
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
    expect((await stubDevices()).filter((d) => d.name === 'Ted Dev NB-1 iPhone')).toHaveLength(1)

    await client.ok('POST', `/tasks/${task.id}/archive`)
    await waitUntil(
      async () => !(await stubDevices()).some((d) => d.udid === clone?.udid),
      'the device to be deleted',
    )
    await waitUntil(
      async () => (await client.ok<SimulatorSlots>('GET', '/simulators')).booted.length === 0,
      'the simulator slot to be freed',
    )
    await waitUntil(
      async () =>
        !(await stat(taskCache).then(
          () => true,
          () => false,
        )),
      'the Task’s sandbox folder to be removed',
    )
  })

  test('one simulator App builds at a time: the next waits until the first prints TED_APP_READY', async () => {
    const client = await start()
    const built = path.join(scratch, 'built')
    await addFactory(
      client,
      `echo $TED_APP_CPUS >> '${cpusFile()}'; until [ -f '${built}' ]; do sleep 0.1; done; echo TED_APP_READY; exec sleep 600`,
    )
    const task = await taskWithWorktree(client)
    await client.ok('POST', `/tasks/${task.id}/apps/start`, { name: 'iPhone' })

    const watch = await client.ok<TaskApp>('POST', `/tasks/${task.id}/apps/start`, {
      name: 'Watch',
    })
    expect(watch).toMatchObject({
      state: 'waiting',
      waitingOn: { displayId: 'NB-1', app: 'iPhone' },
    })
    expect((await client.ok<SimulatorSlots>('GET', '/simulators')).waiting).toMatchObject([
      {
        taskId: task.id,
        displayId: 'NB-1',
        app: 'Watch',
        place: 1,
        waitingFor: { kind: 'build', displayId: 'NB-1', app: 'iPhone' },
      },
    ])

    await writeFile(built, '')
    await waitUntil(
      async () =>
        (await apps(client, task)).find((a) => a.name === 'Watch' && a.state === 'running'),
      'the Watch App to start once the iPhone App is built',
    )
    expect((await iPhone(client, task))?.state).toBe('running')
    expect((await client.ok<SimulatorSlots>('GET', '/simulators')).waiting).toEqual([])
    expect(await cpusTold(1)).toEqual([String(checkCpus(os.availableParallelism(), 1, 50))])
  })

  test('with one build at a time off, two builds at once split the CPU share', async () => {
    const client = await start()
    const built = path.join(scratch, 'built')
    await addFactory(
      client,
      `echo $TED_APP_CPUS >> '${cpusFile()}'; until [ -f '${built}' ]; do sleep 0.1; done; echo TED_APP_READY; exec sleep 600`,
    )
    await client.ok('PATCH', '/settings', { buildDeviceAppsOneAtATime: false })
    const first = await taskWithWorktree(client)
    const second = await taskWithWorktree(client)
    await client.ok('POST', `/tasks/${first.id}/apps/start`, { name: 'iPhone' })
    await client.ok('POST', `/tasks/${second.id}/apps/start`, { name: 'iPhone' })

    const cores = os.availableParallelism()
    expect((await cpusTold(2)).sort()).toEqual(
      [String(checkCpus(cores, 1, 50)), String(checkCpus(cores, 2, 50))].sort(),
    )
  })

  test('with every slot booted the human must pick one to shut down', async () => {
    const client = await start()
    await addFactory(client)
    await client.ok('PATCH', '/settings', { maxRunningDevices: 1 })
    const first = await taskWithWorktree(client)
    const second = await taskWithWorktree(client)
    await client.ok('POST', `/tasks/${first.id}/apps/start`, { name: 'iPhone' })

    const refused = await client.call('POST', `/tasks/${second.id}/apps/start`, {
      name: 'iPhone',
    })
    expect(refused.status).toBe(409)
    expect((refused.body as { error: string }).error).toBe(
      'The only simulator or emulator slot is taken. Choose one to shut down, then run iPhone again.',
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
    await eventText(client, first, 'Ted shut down iPhone’s simulator to free a slot for NB-2')
    const slots = await client.ok<SimulatorSlots>('GET', '/simulators')
    expect(slots.booted.map((s) => s.displayId)).toEqual(['NB-2'])
  })

  test('a Task’s other simulator App can take its first App’s slot', async () => {
    const client = await start()
    await addFactory(client)
    await client.ok('PATCH', '/settings', { maxRunningDevices: 1 })
    const task = await taskWithWorktree(client)
    await client.ok('POST', `/tasks/${task.id}/apps/start`, { name: 'iPhone' })
    const [booted] = (await client.ok<SimulatorSlots>('GET', '/simulators')).booted

    const watch = await client.ok<TaskApp>('POST', `/tasks/${task.id}/apps/start`, {
      name: 'Watch',
      shutDown: booted?.udid,
    })
    expect(watch.simulator?.booted).toBe(true)
    const slots = await client.ok<SimulatorSlots>('GET', '/simulators')
    expect(slots.booted.map((s) => s.app)).toEqual(['Watch'])
  })

  test('a Run that needs a slot asks the human, and Deny reaches ted run-app', async () => {
    const client = await start()
    await addFactory(client)
    await client.ok('PATCH', '/settings', { maxRunningDevices: 1 })
    const first = await taskWithWorktree(client)
    await client.ok('POST', `/tasks/${first.id}/apps/start`, { name: 'iPhone' })
    const second = await taskWithWorktree(client, runAppTitle)

    const request = await simulatorRequest(client, second)
    expect(request).toMatchObject({
      kind: 'permission',
      title: 'iPhone needs a simulator · 1 of 1 running',
      body: 'Validate wants to record the swipe. Pick a simulator or emulator to shut down, or deny and the Task Lead carries on without iPhone.',
      simulator: { app: 'iPhone', device: 'iPhone 17', limit: 1 },
    })
    expect(request.simulator?.booted.map((b) => b.displayId)).toEqual(['NB-1'])
    const waiting = await taskNow(client, second)
    expect(waiting.status?.kind).toBe('waiting-on-you')
    expect(waiting.activity).toBe('Waiting for a simulator slot')
    expect((await iPhone(client, second))?.state).toBe('waiting')
    expect((await client.ok<SimulatorSlots>('GET', '/simulators')).waiting).toMatchObject([
      { displayId: 'NB-2', app: 'iPhone', place: 1, waitingFor: { kind: 'answer' } },
    ])

    await client.ok('POST', `/comments/${request.id}/answer`, { action: 'deny' })

    const result = await leadResult(client, second)
    expect(result.code).toBe(1)
    expect((await client.ok<SimulatorSlots>('GET', '/simulators')).waiting).toEqual([])
    expect(result.stderr).toContain('No simulator slot: the human denied')
    expect((await iPhone(client, first))?.simulator?.booted).toBe(true)
  })

  test('approving shuts down the chosen simulator and runs the App', async () => {
    const client = await start()
    await addFactory(client)
    await client.ok('PATCH', '/settings', { maxRunningDevices: 1 })
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

  test('an approved App that waits for another App’s build names it, and ted run-app says so', async () => {
    const client = await start()
    const built = path.join(scratch, 'built')
    await addFactory(
      client,
      `until [ -f '${built}' ]; do sleep 0.1; done; echo TED_APP_READY; exec sleep 600`,
    )
    await client.ok('PATCH', '/settings', { maxRunningDevices: 2 })
    const first = await taskWithWorktree(client)
    await client.ok('POST', `/tasks/${first.id}/apps/start`, { name: 'iPhone' })
    await writeFile(built, '')
    await waitForApp(client, first, (a) => a.state === 'running', 'NB-1’s iPhone to be built')
    const builder = await taskWithWorktree(client)
    await client.ok('POST', `/tasks/${builder.id}/apps/start`, { name: 'Watch' })
    await waitUntil(
      async () =>
        (await apps(client, builder)).find((a) => a.name === 'Watch' && a.simulator?.booted),
      'NB-2’s Watch to boot and take the build turn',
    )
    const said = path.join(scratch, 'run-app.err')
    const second = await taskWithWorktree(
      client,
      JSON.stringify({
        steps: [{ run: ['sh', '-c', `ted run-app iPhone 2> '${said}'`] }, { endTurn: true }],
      }),
    )
    const request = await simulatorRequest(client, second)
    const nb1 = request.simulator?.booted.find((b) => b.displayId === 'NB-1')

    await client.ok('POST', `/comments/${request.id}/answer`, {
      action: 'approve',
      simulator: nb1?.udid,
    })
    const waiting = await waitForApp(
      client,
      second,
      (a) => a.waitingOn !== undefined,
      'NB-3’s iPhone to wait for NB-2’s build',
    )
    expect(waiting).toMatchObject({
      state: 'waiting',
      waitingOn: { displayId: 'NB-2', app: 'Watch' },
    })

    const building = 'Waiting for NB-2’s Watch to finish building…'
    await waitUntil(
      async () => (await readFile(said, 'utf8').catch(() => '')).includes(building),
      'ted run-app to say whose build it waits for',
    )
    await client.ok('POST', `/tasks/${builder.id}/apps/stop`, { name: 'Watch' })
    const result = await leadResult(client, second)
    expect(result.code).toBe(0)
    const lines = (await readFile(said, 'utf8')).split('\n')
    expect(lines.filter((l) => l.includes('Waiting for'))).toEqual([
      'Every simulator and emulator slot is taken, so Ted asked the human which one to shut down. Waiting for an answer…',
      building,
    ])
  })

  test('a slot that frees up first closes the request without shutting anything down', async () => {
    const client = await start()
    await addFactory(client)
    await client.ok('PATCH', '/settings', { maxRunningDevices: 1 })
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
    await eventText(client, task, 'Ted shut down iPhone’s simulator because it was idle')
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
    expect(Buffer.from(bytes.data, 'base64').toString()).toBe('MOV of Ted Dev NB-1 iPhone finished')
  })

  test('an Automation Run with a checkout runs its own Apps, waits in line for a simulator, and loses both when it ends', async () => {
    const client = await start()
    const stubApp = fileURLToPath(new URL('./fixtures/stub-app.ts', import.meta.url))
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': [
        'version: 1',
        'order: [intake, work, merge]',
        'repos:',
        '  - name: widgets',
        '    worktree:',
        '      setup:',
        '        run: "touch stub-setup"',
        '    apps:',
        '      - name: Web',
        '        kind: web',
        `        run: "'${process.execPath}' '${stubApp}'"`,
        '      - name: iPhone',
        '        kind: ios-simulator',
        '        device: "iPhone 17"',
        '        run: "exec sleep 600"',
      ].join('\n'),
    })
    await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
    await client.ok('PATCH', '/settings', { maxRunningDevices: 1 })
    const task = await taskWithWorktree(client)
    await client.ok('POST', `/tasks/${task.id}/apps/start`, { name: 'iPhone' })

    const automation = await client.ok<Automation>('POST', '/automations', {
      name: 'Nightly check',
      factory: 'NB',
      schedule: { kind: 'daily', at: '09:00' },
      on: false,
      checkout: true,
      runNow: true,
      prompt: JSON.stringify({
        steps: [
          { run: ['test', '-f', 'stub-setup'] },
          { run: ['ted', 'run-app', 'Web'] },
          { run: ['ted', 'run-app', 'iPhone'] },
          { run: ['ted', 'app', 'list'] },
          { endTurn: true },
        ],
      }),
    })
    expect(automation.checkout).toBe(true)
    const runId = await waitUntil(
      async () =>
        (await client.ok<AutomationDetail>('GET', `/automations/${automation.id}`)).history.find(
          (r) => r.runId !== undefined,
        )?.runId,
      'the Automation Run',
    )
    const runApps = () => client.ok<TaskApp[]>('GET', `/runs/${runId}/apps`)
    const waiting = await waitUntil(
      async () => {
        const list = await runApps()
        return list.find((a) => a.name === 'iPhone' && a.state === 'waiting') ? list : undefined
      },
      'the Run’s iPhone to wait for a slot',
      30_000,
    )
    expect(waiting.find((a) => a.name === 'Web')).toMatchObject({ state: 'running' })
    expect(
      await stat(path.join(home, 'automation-runs', runId, 'widgets', 'stub-setup')),
    ).toBeTruthy()
    const humanStart = await client.call('POST', `/runs/${runId}/apps/start`, { name: 'Web' })
    expect(humanStart.status).toBe(403)

    await client.ok('POST', `/tasks/${task.id}/apps/stop`, { name: 'iPhone' })

    const finished = await waitUntil(
      async () =>
        (await client.ok<AutomationDetail>('GET', `/automations/${automation.id}`)).history.find(
          (r) => r.runId === runId && r.finishedAt !== undefined,
        ),
      'the Automation Run to finish',
      30_000,
    )
    expect(finished.result.kind).toBe('no-new-tasks')
    const results = assistantTexts((await client.getRun(runId)).conversation).map(
      (t) => JSON.parse(t) as { code: number; stdout: string },
    )
    expect(results.map((r) => r.code)).toEqual([0, 0, 0, 0])
    expect(results[1]?.stdout).toContain('Web is running at http://localhost:')
    expect(results[1]?.stdout).toContain('until the Run ends')
    expect(results[2]?.stdout).toContain('iPhone is running on iPhone 17')
    expect(results[3]?.stdout).toContain('iPhone · widgets · ios-simulator · running')

    await waitUntil(
      async () =>
        (await stat(path.join(home, 'automation-runs', runId)).catch(() => undefined)) === undefined
          ? true
          : undefined,
      'the checkout to be removed',
    )
    await waitUntil(
      async () =>
        (await stubDevices()).some((d) => d.name === 'Ted Dev Nightly check iPhone')
          ? undefined
          : true,
      'the Run’s simulator to be deleted',
    )
    expect((await client.call('GET', `/runs/${runId}/apps`)).status).toBe(404)
    expect((await iPhone(client, task))?.state).toBe('stopped')

    const held = await client.ok<Automation>('POST', '/automations', {
      name: 'Held check',
      factory: 'NB',
      schedule: { kind: 'daily', at: '09:00' },
      on: false,
      checkout: true,
      runNow: true,
      prompt: JSON.stringify({
        steps: [
          { run: ['ted', 'run-app', 'Web'] },
          { waitFor: path.join(scratch, 'never') },
          { endTurn: true },
        ],
      }),
    })
    const heldRun = await waitUntil(
      async () =>
        (await client.ok<AutomationDetail>('GET', `/automations/${held.id}`)).history.find(
          (r) => r.runId !== undefined,
        )?.runId,
      'the held Automation Run',
    )
    await waitUntil(
      async () =>
        (await client.ok<TaskApp[]>('GET', `/runs/${heldRun}/apps`)).find(
          (a) => a.name === 'Web' && a.state === 'running',
        ),
      'the held Run’s Web App',
      30_000,
    )
    const cache = path.join(home, 'sandbox', `automation-${held.id}`)
    expect(await stat(cache)).toBeTruthy()
    await client.ok('DELETE', `/automations/${held.id}`)
    const gone = (file: string) =>
      stat(file).then(
        () => false,
        () => true,
      )
    expect(await gone(path.join(home, 'automation-runs', heldRun))).toBe(true)
    expect(await gone(path.join(home, 'apps', heldRun))).toBe(true)
    expect(await gone(cache)).toBe(true)
  }, 90_000)

  test('an Audit reads its simulator’s screen, taps through two screens and files a Task with a screenshot for the planted problem', async () => {
    await writeStub({
      deviceTypes: [
        { name: 'iPhone 17', identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' },
        {
          name: 'iPhone SE (3rd generation)',
          identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation',
        },
        {
          name: 'iPhone 6',
          identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-6',
          createFails: true,
        },
      ],
    })
    const client = await start()
    await addFactory(client)
    const template = (await client.ok<AutomationTemplate[]>('GET', '/automations/templates')).find(
      (t) => t.id === 'audit',
    )
    if (!template) throw new Error('missing audit template')
    expect(template.prompt).toContain('`ios-simulator` App')
    const source = 'http://localhost/audit/iPhone/details/buy-button-covers-price'
    const app = (...args: string[]) => ({ run: ['ted', 'app', ...args] })
    const tapLabel = (label: string) => ({
      run: [
        'sh',
        '-c',
        `ted app tap iPhone "$(ted app screen iPhone | grep 'label="${label}"' | cut -d ' ' -f 1)"`,
      ],
    })
    const released = path.join(scratch, 'released')
    const automation = await client.ok<Automation>('POST', '/automations', {
      template: template.id,
      name: template.name,
      factory: 'NB',
      schedule: template.schedule,
      on: false,
      checkout: true,
      runNow: true,
      prompt: `${template.prompt}\n${JSON.stringify({
        steps: [
          { run: ['ted', 'run-app', 'iPhone'] },
          tapLabel('Open details'),
          app('screen', 'iPhone'),
          app('appearance', 'iPhone', 'dark'),
          app('key', 'iPhone', 'back'),
          { run: ['sh', '-c', `printf '%s' "-it's" | ted app type iPhone`] },
          app('key', 'iPhone', 'enter'),
          app('tap', 'iPhone', '5000,100'),
          app('screen', 'Watch'),
          {
            run: [
              'sh',
              '-c',
              `shot=$(ted app screenshot iPhone | sed -n 's/^Saved \\(.*\\.png\\)\\. Attach.*/\\1/p') && ted task create --source ${source} --description "Details screen in dark mode: the Buy button covers the price." --attach "$shot" "Buy button covers the price on Details"`,
            ],
          },
          tapLabel('Back'),
          app('size', 'iPhone', '720x1280'),
          app('size', 'iPhone', 'iPhone SE (3rd generation)'),
          app('screen', 'iPhone'),
          app('size', 'iPhone', 'iPhone 6'),
          app('size', 'iPhone', 'reset'),
          { waitFor: released },
          app('screen', 'iPhone'),
          { endTurn: true },
        ],
      })}`,
    })
    const runId = await waitUntil(
      async () =>
        (await client.ok<AutomationDetail>('GET', `/automations/${automation.id}`)).history.find(
          (r) => r.runId !== undefined,
        )?.runId,
      'the Audit Run',
    )
    const results = (count: number) =>
      waitUntil(
        async () => {
          const texts = assistantTexts((await client.getRun(runId)).conversation)
          return texts.length >= count
            ? texts.map((t) => JSON.parse(t) as { code: number; stdout: string; stderr: string })
            : undefined
        },
        'the Audit’s commands',
        60_000,
      )
    const before = await results(16)
    const refused = await client.call('POST', `/runs/${runId}/apps/device`, {
      action: 'screen',
      app: { name: 'iPhone' },
    })
    expect(refused.status).toBe(403)

    expect(before.map((r) => r.code === 0)).toEqual([
      true,
      true,
      true,
      true,
      false,
      true,
      true,
      false,
      false,
      true,
      true,
      false,
      true,
      true,
      false,
      true,
    ])
    expect(before[1]?.stdout).toContain('Tapped 201,325')
    const details = before[2]?.stdout ?? ''
    expect(details).toMatch(/^<<<SCREEN [0-9a-f]{8}>>>$/m)
    expect(details).toContain('StaticText label="Price: 10 widgets for $5" at 201,270')
    expect(details).toContain('Button label="Buy" id="buy" clickable at 201,295')
    expect(before[4]?.stderr).toContain('iOS has no back key')
    expect(before[7]?.stderr).toContain('5000,100 is off the screen, which is 402x874 points')
    expect(before[8]?.stderr).toContain('Watch’s simulator isn’t booted')
    expect(before[9]?.stdout).toContain('Created NB-1')
    expect(before[11]?.stderr).toContain('can’t be resized')
    expect(before[12]?.stdout).toContain('iPhone now runs on iPhone SE (3rd generation)')
    expect(before[13]?.stdout).toContain('label="Open details"')
    expect(before[14]?.stderr).toContain('Ted couldn’t run iPhone on iPhone 6')
    expect(before[14]?.stderr).toContain('iPhone runs on iPhone SE (3rd generation) again.')
    expect(before[15]?.stdout).toContain('iPhone now runs on iPhone 17')
    const calls = await stubCalls()
    const firstUdid = calls.find((c) => c[1] === 'ui')?.[2]
    expect(calls).toContainEqual(['simctl', 'ui', firstUdid, 'appearance', 'dark'])
    const state = JSON.parse(await readFile(stubState, 'utf8')) as {
      ui: Record<string, { screen: string; typed?: string; keys?: string[] }>
    }
    expect(state.ui[firstUdid ?? '']).toMatchObject({ typed: "-it's", keys: ['40'] })
    const devices = await stubDevices()
    expect(devices.some((d) => d.udid === firstUdid)).toBe(false)
    expect(devices.filter((d) => d.name.startsWith('Ted Dev'))).toMatchObject([
      { state: 'Booted', deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' },
    ])

    await writeFile(stubState, JSON.stringify({ ...state, idb: false }))
    await writeFile(released, '')
    const after = await results(17)
    expect(after[16]?.code).not.toBe(0)
    expect(after[16]?.stderr).toContain('brew install facebook/fb/idb-companion')

    const finished = await waitUntil(
      async () =>
        (await client.ok<AutomationDetail>('GET', `/automations/${automation.id}`)).history.find(
          (r) => r.runId === runId && r.finishedAt !== undefined,
        ),
      'the Audit Run to finish',
      60_000,
    )
    expect(finished.result.kind).toBe('created')
    const filed = (await client.ok<Task[]>('GET', '/tasks')).filter(
      (t) => t.createdBy === 'automation',
    )
    expect(filed).toHaveLength(1)
    expect(filed[0]).toMatchObject({
      title: 'Buy button covers the price on Details',
      stage: 'backlog',
      source: { url: source },
    })
    const shot = filed[0]?.attachments[0]
    expect(shot?.mediaType).toBe('image/png')
    const bytes = await client.ok<{ data: string }>(
      'GET',
      `/attachments/${shot?.hash}/${encodeURIComponent(shot?.name ?? '')}`,
    )
    expect(Buffer.from(bytes.data, 'base64').toString()).toMatch(/^PNG of Ted Dev .* iPhone$/)
    await waitUntil(
      async () =>
        (await stubDevices()).some((d) => d.name.startsWith('Ted Dev')) ? undefined : true,
      'the Audit’s simulator to be deleted',
    )
  }, 60_000)

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
      limit: 2,
      booted: [],
      waiting: [],
    })
    expect(await stubCalls()).toEqual([])
  })
})
