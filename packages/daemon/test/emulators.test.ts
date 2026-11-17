import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import type { StubAndroidState } from './fixtures/stub-android.ts'
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

const image = 'system-images;android-35;google_apis;arm64-v8a'
const avd = 'Ted_Dev_NB-1_widgets_android'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let stubState: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-emus-'))
  origin = await makeOriginRepo(scratch)
  stubState = path.join(scratch, 'android.json')
  await writeStub({ avds: { Pixel_8_API_35: { image, hardware: 'pixel_8' } } })
  process.env.TED_STUB_ANDROID = stubState
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  delete process.env.TED_STUB_ANDROID
  await killAppHosts(home)
  await killRunHosts(home)
  for (const emulator of Object.values((await stub()).running ?? {})) {
    try {
      process.kill(emulator.pid, 'SIGTERM')
    } catch {}
  }
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function writeStub(state: StubAndroidState) {
  await writeFile(stubState, JSON.stringify(state))
}

async function stub(): Promise<StubAndroidState> {
  return JSON.parse(await readFile(stubState, 'utf8').catch(() => '{}')) as StubAndroidState
}

async function stubCalls(): Promise<string[][]> {
  const text = await readFile(`${stubState}.calls`, 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as string[])
}

async function start() {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    apps: { pollMs: 50, readyTimeoutMs: 20_000, stopGraceMs: 3_000 },
    emulators: { supported: true, pollMs: 100 },
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

const workflow = [
  'version: 1',
  'order: [intake, work, merge]',
  'repos:',
  '  - name: widgets',
  '    apps:',
  '      - name: android',
  '        kind: android-emulator',
  '        device: Pixel_8_API_35',
  '        run: "echo serial $ANDROID_SERIAL $TED_EMULATOR_SERIAL $GRADLE_USER_HOME; exec sleep 600"',
].join('\n')

async function addFactory(client: Client) {
  await commitToOrigin(scratch, { '.ted/workflow.yaml': workflow })
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

const android = async (client: Client, task: Task) =>
  (await client.ok<TaskApp[]>('GET', `/tasks/${task.id}/apps`)).find((a) => a.name === 'android')

const serialLines = async (client: Client, task: Task) =>
  (await client.ok<{ text: string }>('GET', `/tasks/${task.id}/apps/widgets/android/log`)).text
    .split('\n')
    .filter((l) => l.startsWith('serial '))

async function leadResults(client: Client, task: Task, count: number) {
  const lead = (await taskNow(client, task)).leadRunId as string
  return waitUntil(
    async () => {
      const texts = assistantTexts((await client.getRun(lead)).conversation)
      return texts.length >= count
        ? texts.map((t) => JSON.parse(t) as { code: number; stdout: string; stderr: string })
        : undefined
    },
    'the Task Lead’s commands',
    30_000,
  )
}

describe('Android emulator Apps', () => {
  test('ted run-app boots a headless emulator made for the Task, ted app screenshot saves its screen, Show reopens it with a window, and archiving deletes it', async () => {
    const client = await start()
    await addFactory(client)
    const task = await taskWithWorktree(
      client,
      JSON.stringify({
        steps: [
          { run: ['ted', 'run-app', 'android'] },
          { run: ['ted', 'app', 'screenshot', 'android'] },
          { run: ['ted', 'app', 'tap', 'android', '1'] },
          { endTurn: true },
        ],
      }),
    )

    const results = await leadResults(client, task, 3)
    expect(results.map((r) => r.code)).toEqual([0, 0, 2])
    expect(results[2]?.stderr).toContain('ted app tap works only in an Automation Run')
    expect(results[0]?.stdout).toContain('android is running on Pixel_8_API_35')
    expect(results[1]?.stdout).toBe('Saved android screenshot.png to the Task\n')

    expect((await stub()).avds?.[avd]).toEqual({ image, hardware: 'pixel_8' })
    const [serial, running] = Object.entries((await stub()).running ?? {})[0] ?? []
    expect(serial).toBe('emulator-5554')
    expect(running).toMatchObject({ avd, window: false })
    expect(await android(client, task)).toMatchObject({
      kind: 'android-emulator',
      state: 'running',
      simulator: { device: 'Pixel_8_API_35', booted: true },
    })
    const taskCache = path.join(await realpath(home), 'sandbox', 'NB-1', 'cache')
    const [line] = await waitUntil(async () => {
      const lines = await serialLines(client, task)
      return lines.length > 0 ? lines : undefined
    }, 'the App to print its serial')
    expect(line).toBe(`serial emulator-5554 emulator-5554 ${taskCache}/gradle`)

    const notes = (await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)).filter(
      (c) => c.attachments !== undefined,
    )
    expect(notes.map((c) => [c.body, c.attachments?.[0]?.mediaType])).toEqual([
      ['Screenshot of android', 'image/png'],
    ])
    const bytes = await client.ok<{ data: string }>(
      'GET',
      `/attachments/${notes[0]?.attachments?.[0]?.hash}/${encodeURIComponent('android screenshot.png')}`,
    )
    expect(Buffer.from(bytes.data, 'base64').toString()).toBe(`PNG of ${avd}`)

    const slots = await client.ok<SimulatorSlots>('GET', '/emulators')
    expect(slots).toMatchObject({ supported: true, limit: 2 })
    expect(slots.booted.map((s) => [s.displayId, s.app, s.udid])).toEqual([
      ['NB-1', 'android', 'emulator-5554'],
    ])

    const shown = await client.ok<TaskApp>('POST', `/tasks/${task.id}/apps/show`, {
      name: 'android',
    })
    expect(shown.simulator).toMatchObject({ booted: true, window: true })
    expect((await stub()).snapshots?.[avd]).toEqual(['ted-show'])
    expect(Object.values((await stub()).running ?? {})).toMatchObject([
      { avd, window: true, snapshot: 'ted-show' },
    ])
    await waitUntil(
      async () => (await serialLines(client, task)).length >= 2,
      'the App to restart on the reopened emulator',
    )

    await client.ok('POST', `/tasks/${task.id}/archive`)
    await waitUntil(async () => (await stub()).avds?.[avd] === undefined, 'the AVD to be deleted')
    expect(Object.keys((await stub()).running ?? {})).toEqual([])
    expect((await stub()).avds?.Pixel_8_API_35).toBeDefined()
    expect((await client.ok<SimulatorSlots>('GET', '/emulators')).booted).toEqual([])
  })

  test('with every emulator slot taken, a Run asks the human and approving shuts the chosen emulator down', async () => {
    const client = await start()
    await addFactory(client)
    await client.ok('PATCH', '/settings', { maxRunningEmulators: 1 })
    const first = await taskWithWorktree(client)
    await client.ok('POST', `/tasks/${first.id}/apps/start`, { name: 'android' })
    const second = await taskWithWorktree(
      client,
      JSON.stringify({
        steps: [
          { run: ['ted', 'run-app', 'android', '--reason', 'Check sign-in'] },
          { endTurn: true },
        ],
      }),
    )

    const request = await waitUntil(
      async () =>
        (await client.ok<Comment[]>('GET', `/tasks/${second.id}/comments`)).find(
          (c) => c.simulator !== undefined && c.answer === undefined,
        ),
      'the emulator request',
      20_000,
    )
    expect(request).toMatchObject({
      kind: 'permission',
      title: 'android needs an emulator · 1 of 1 running',
      simulator: { platform: 'android', app: 'android', device: 'Pixel_8_API_35', limit: 1 },
    })

    const answered = await client.ok<Comment>('POST', `/comments/${request.id}/answer`, {
      action: 'approve',
      simulator: request.simulator?.booted[0]?.udid,
    })
    expect(answered.answer).toMatchObject({ kind: 'approved', shutDown: 'NB-1' })
    const [result] = await leadResults(client, second, 1)
    expect(result?.code).toBe(0)
    expect((await android(client, first))?.simulator).toMatchObject({
      booted: false,
      shutDown: { for: 'NB-2' },
    })
    await waitUntil(
      async () =>
        (await client.ok<{ text: string }[]>('GET', `/tasks/${first.id}/events`)).some(
          (e) => e.text === 'Ted shut down android’s emulator to free a slot for NB-2',
        ),
      'the shut-down thread line',
    )
    const slots = await client.ok<SimulatorSlots>('GET', '/emulators')
    expect(slots.booted.map((s) => s.displayId)).toEqual(['NB-2'])
  })

  test('an Audit reads its emulator’s screen, taps through two screens and files a Task with a screenshot for the planted problem', async () => {
    const client = await start()
    await addFactory(client)
    const template = (await client.ok<AutomationTemplate[]>('GET', '/automations/templates')).find(
      (t) => t.id === 'audit',
    )
    if (!template) throw new Error('missing audit template')
    expect(template.prompt).toContain('ted app screen <App>')
    const source = 'http://localhost/audit/android/details/buy-button-covers-price'
    const app = (...args: string[]) => ({ run: ['ted', 'app', ...args] })
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
          { run: ['ted', 'run-app', 'android'] },
          {
            run: [
              'sh',
              '-c',
              `ted app tap android "$(ted app screen android | grep '"Open details"' | cut -d ' ' -f 1)"`,
            ],
          },
          app('screen', 'android'),
          app('appearance', 'android', 'dark'),
          app('size', 'android', '720x1280', '--density', '320'),
          app('tap', 'android', '5000,100'),
          app('type', 'android', "it's"),
          {
            run: [
              'sh',
              '-c',
              `shot=$(ted app screenshot android | sed -n 's/^Saved \\(.*\\.png\\)\\. Attach.*/\\1/p') && ted task create --source ${source} --description "Details screen at 720x1280 in dark mode: the Buy button covers the price." --attach "$shot" "Buy button covers the price on Details"`,
            ],
          },
          app('key', 'android', 'back'),
          app('screen', 'android'),
          { waitFor: released },
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
    const results = await waitUntil(
      async () => {
        const texts = assistantTexts((await client.getRun(runId)).conversation)
        return texts.length >= 10
          ? texts.map((t) => JSON.parse(t) as { code: number; stdout: string; stderr: string })
          : undefined
      },
      'the Audit’s commands',
      60_000,
    )
    const refused = await client.call('POST', `/runs/${runId}/apps/device`, {
      action: 'screen',
      app: { name: 'android' },
    })
    expect(refused.status).toBe(403)
    await writeFile(released, '')

    expect(results.map((r) => r.code === 0)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      true,
      true,
      true,
      true,
    ])
    expect(results[1]?.stdout).toContain('Tapped 540,680')
    const details = results[2]?.stdout ?? ''
    expect(details).toMatch(/^<<<SCREEN [0-9a-f]{8}>>>$/m)
    expect(details).toContain('"Price: 10 widgets for $5 & free <delivery>" at 540,560')
    expect(details).toContain('Button "Buy" id="com.example.widgets:id/buy" clickable')
    expect(results[5]?.stderr).toContain('5000,100 is off the screen, which is 720x1280')
    expect(results[7]?.stdout).toContain('Created NB-1')
    expect(results[9]?.stdout).toContain('"Open details"')
    const [avdName, ui] = Object.entries((await stub()).ui ?? {})[0] ?? []
    expect(ui).toEqual({
      screen: 'home',
      night: true,
      size: '720x1280',
      density: '320',
      typed: "'it'\\''s'",
    })

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
    expect(Buffer.from(bytes.data, 'base64').toString()).toBe(`PNG of ${avdName}`)
    await waitUntil(
      async () => ((await stub()).avds?.[avdName ?? ''] === undefined ? true : undefined),
      'the Audit’s emulator to be deleted',
    )
  })

  test('a missing Android SDK raises a stops-work Factory banner', async () => {
    await writeStub({ sdk: false })
    const client = await start()
    await addFactory(client)
    const task = await taskWithWorktree(client)

    const res = await client.call('POST', `/tasks/${task.id}/apps/start`, { name: 'android' })
    expect(res.status).toBe(409)
    expect((res.body as { error: string }).error).toContain('Ted couldn’t run the Android SDK’s')
    const banners = await client.ok<Banner[]>('GET', '/banners')
    expect(banners.find((b) => b.problem === 'emulator-tools')).toMatchObject({
      severity: 'stops-work',
      text: 'Android SDK not found · Android emulator Apps can’t start',
    })
    expect((await stubCalls()).some((c) => c[0] === 'avdmanager' && c[1] === 'create')).toBe(false)
  })
})
