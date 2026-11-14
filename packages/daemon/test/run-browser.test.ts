import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Automation, AutomationDetail, AutomationTemplate, Factory, Task } from '@ted/protocol'
import { afterEach, expect, test, vi } from 'vitest'
import { resolveElectron } from '../../app/test/support/electron-installation.ts'
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

const stubApp = fileURLToPath(new URL('./fixtures/stub-app.ts', import.meta.url))
const execFileAsync = promisify(execFile)
const stubElectron = fileURLToPath(new URL('./fixtures/stub-electron', import.meta.url))
vi.setConfig({ testTimeout: 120_000 })

let daemon: RunningDaemon | undefined
let done: (() => Promise<void>) | undefined

afterEach(async () => {
  await done?.()
  done = undefined
})

const pngSize = (data: Buffer) => ({ width: data.readUInt32BE(16), height: data.readUInt32BE(20) })

const browser = (...args: string[]) => ({ run: ['ted', 'browser', ...args] })

async function setUp(apps?: string[]) {
  const { home, cleanup } = await makeTempHome()
  const scratch = await mkdtemp(path.join(tmpdir(), 'ted-run-browser-'))
  process.env.TED_ELECTRON_BIN = resolveElectron()
  done = async () => {
    await daemon?.stop()
    daemon = undefined
    delete process.env.TED_ELECTRON_BIN
    await killAppHosts(home)
    await killRunHosts(home)
    await cleanup()
    await rm(scratch, { recursive: true, force: true })
  }
  const origin = await makeOriginRepo(scratch)
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': [
      'version: 1',
      'order: [intake, work, merge]',
      'repos:',
      '  - name: widgets',
      '    apps:',
      ...(apps ?? [
        '      - name: Web',
        '        kind: web',
        `        run: "'${process.execPath}' '${stubApp}'"`,
        '        env:',
        '          STUB_APP_BROWSER: "1"',
      ]),
    ].join('\n'),
  })
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    apps: { pollMs: 50, readyTimeoutMs: 20_000, stopGraceMs: 3_000 },
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  return { home, scratch, client, ok }
}

test('an Automation Run drives its web App in a headless browser, at a narrow width and in dark mode, and stays on the App', async () => {
  const { home, scratch, client, ok } = await setUp()
  const automation = await ok<Automation>('POST', '/automations', {
    name: 'Audit',
    factory: 'NB',
    schedule: { kind: 'daily', at: '09:00' },
    on: false,
    checkout: true,
    runNow: true,
    prompt: JSON.stringify({
      steps: [
        { run: ['ted', 'run-app', 'Web'] },
        browser('open', 'Web'),
        browser('navigate', '/pages/one'),
        {
          run: [
            'sh',
            '-c',
            'ted browser click "$(ted browser snapshot | grep " a Next page" | cut -d " " -f 1)"',
          ],
        },
        {
          run: [
            'sh',
            '-c',
            'for i in $(seq 40); do out=$(ted browser snapshot 2>&1) && case "$out" in *"Second page"*) echo "$out"; exit 0;; esac; sleep 0.25; done; echo "$out"; exit 1',
          ],
        },
        browser('resize', '390x844'),
        browser('screenshot'),
        browser('color-scheme', 'dark'),
        browser('screenshot'),
        browser('navigate', 'http://example.com/'),
        { waitFor: path.join(scratch, 'app-stopped') },
        browser('snapshot'),
        { endTurn: true },
      ],
    }),
  })
  const runId = await waitUntil(
    async () =>
      (await ok<AutomationDetail>('GET', `/automations/${automation.id}`)).history.find(
        (r) => r.runId !== undefined,
      )?.runId,
    'the Automation Run',
  )
  const browserFolders = async () =>
    (await readdir(path.join(home, 'browsers')).catch(() => [] as string[])).filter((name) =>
      name.startsWith(runId),
    )
  await waitUntil(
    async () =>
      assistantTexts((await client.getRun(runId)).conversation).length >= 10 ? true : undefined,
    'the browser steps',
    90_000,
  )
  expect(await browserFolders()).toHaveLength(1)
  await ok('POST', `/runs/${runId}/apps/stop`, { name: 'Web' })
  await waitUntil(
    async () => ((await browserFolders()).length === 0 ? true : undefined),
    'the browser to close with its App',
  )
  await writeFile(path.join(scratch, 'app-stopped'), '')
  const finished = await waitUntil(
    async () =>
      (await ok<AutomationDetail>('GET', `/automations/${automation.id}`)).history.find(
        (r) => r.runId === runId && r.finishedAt !== undefined,
      ),
    'the Automation Run to finish',
    90_000,
  )
  const results = assistantTexts((await client.getRun(runId)).conversation).map(
    (t) => JSON.parse(t) as { code: number; stdout: string; stderr: string },
  )
  expect(results.slice(0, 9).map((r) => [r.code, r.stderr])).toEqual(
    Array.from({ length: 9 }, () => [0, '']),
  )
  expect(results[4]?.stdout).toContain('Second page')
  expect(results[6]?.stdout).toContain('Attach with ted task create --attach')
  expect(results[9]?.code).not.toBe(0)
  expect(results[9]?.stderr).toContain('Navigate within this App’s origin')
  expect(results[10]?.code).not.toBe(0)

  const shots = finished.screenshots ?? []
  expect(shots.map((s) => [s.name, s.mediaType])).toEqual([
    ['Web screenshot.png', 'image/png'],
    ['Web screenshot.png', 'image/png'],
  ])
  expect(shots[0]?.hash).not.toBe(shots[1]?.hash)
  const bytes = await ok<{ data: string }>(
    'GET',
    `/attachments/${shots[0]?.hash}/${encodeURIComponent('Web screenshot.png')}`,
  )
  const { width, height } = pngSize(Buffer.from(bytes.data, 'base64'))
  expect({ width, height }).toEqual({ width: 390, height: 844 })
})

test('an Audit files one Backlog Task with its screenshot, and a second Audit of the same problem files nothing new', async () => {
  const { client, ok } = await setUp()
  const templates = await ok<AutomationTemplate[]>('GET', '/automations/templates')
  const template = templates.find((t) => t.id === 'audit')
  if (!template) throw new Error('missing audit template')
  expect(template.checkout).toBe(true)
  expect(template.prompt).toContain('skipped: no Audit driver for <kind> Apps yet')
  expect(template.prompt).toContain('`electron` (a desktop app)')
  expect(template.prompt).toContain('File at most 5 Tasks in one Run')
  expect(template.prompt).toContain('open that image and look at it before you judge the page')
  const source = 'http://localhost/audit/web/pages/one/header-overlaps-text'
  const automation = await ok<Automation>('POST', '/automations', {
    template: template.id,
    name: template.name,
    factory: 'NB',
    schedule: template.schedule,
    on: false,
    checkout: template.checkout,
    runNow: true,
    prompt: `${template.prompt}\n${JSON.stringify({
      steps: [
        { run: ['ted', 'run-app', 'Web'] },
        browser('open', 'Web'),
        browser('navigate', '/pages/one'),
        browser('resize', '390x844'),
        {
          run: [
            'sh',
            '-c',
            `shot=$(ted browser screenshot | sed -n 's/^Saved \\(.*\\.png\\)\\. Attach.*/\\1/p') && ted task create --source ${source} --description "Page one at 390x844: the header covers the first line." --attach "$shot" "Header covers text on page one"`,
          ],
        },
        { endTurn: true },
      ],
    })}`,
  })
  const finishedRuns = async (count: number) =>
    waitUntil(
      async () => {
        const { history } = await ok<AutomationDetail>('GET', `/automations/${automation.id}`)
        const finished = history.filter((r) => r.finishedAt !== undefined)
        return finished.length >= count ? finished : undefined
      },
      `${count} finished Audit Runs`,
      90_000,
    )
  const [first] = await finishedRuns(1)
  const results = async (runId: string | undefined) =>
    assistantTexts((await client.getRun(runId ?? '')).conversation).map(
      (t) => JSON.parse(t) as { code: number; stdout: string; stderr: string },
    )
  expect((await results(first?.runId)).slice(0, 5).map((r) => [r.code, r.stderr])).toEqual(
    Array.from({ length: 5 }, () => [0, '']),
  )
  expect(first?.result.kind).toBe('created')
  const filed = async () =>
    (await ok<Task[]>('GET', '/tasks')).filter((t) => t.createdBy === 'automation')
  const [task, ...others] = await filed()
  expect(others).toEqual([])
  expect(task).toMatchObject({
    title: 'Header covers text on page one',
    stage: 'backlog',
    source: { url: source },
  })
  expect(task?.leadRunId).toBeUndefined()
  expect(task?.attachments.map((a) => a.mediaType)).toEqual(['image/png'])

  await ok('POST', `/automations/${automation.id}/run`)
  const second = (await finishedRuns(2)).find((r) => r.runId !== first?.runId)
  const last = (await results(second?.runId))[4]
  expect(last?.code).not.toBe(0)
  expect(last?.stderr).toContain(`Already tracked as ${task?.displayId}`)
  expect(second?.result.kind).toBe('no-new-tasks')
  expect((await filed()).map((t) => t.id)).toEqual([task?.id])
})

// Its own setup: an Electron App instead of the web App, started in the real OS sandbox.
test('an Automation Run drives its Electron App in the sandbox with a hidden window, and every Electron process ends with the firing', async () => {
  const { client, ok } = await setUp([
    '      - name: Desk',
    '        kind: command',
    '        electron: true',
    `        run: "'${resolveElectron()}' '${stubElectron}' $TED_ELECTRON_ARGS"`,
  ])
  const snapshotUntil = (text: string) => ({
    run: [
      'sh',
      '-c',
      `for i in $(seq 40); do out=$(ted browser snapshot 2>&1) && case "$out" in *"${text}"*) echo "$out"; exit 0;; esac; sleep 0.25; done; echo "$out"; exit 1`,
    ],
  })
  const ref = (name: string) =>
    `$(ted browser snapshot | grep " ${name}" | head -n 1 | cut -d " " -f 1)`
  const automation = await ok<Automation>('POST', '/automations', {
    name: 'Audit',
    factory: 'NB',
    schedule: { kind: 'daily', at: '09:00' },
    on: false,
    checkout: true,
    runNow: true,
    prompt: JSON.stringify({
      steps: [
        { run: ['ted', 'run-app', 'Desk'] },
        { run: ['ted', 'app', 'list'] },
        browser('open', 'Desk'),
        snapshotUntil('visible false'),
        { run: ['sh', '-c', `ted browser click "${ref('button Press me')}"`] },
        { run: ['sh', '-c', `ted browser fill "${ref('input Name')}" Ada`] },
        snapshotUntil('typed Ada'),
        browser('resize', '390x844'),
        browser('screenshot'),
        browser('color-scheme', 'dark'),
        snapshotUntil('dark true'),
        browser('screenshot'),
        browser('navigate', '/other'),
        { endTurn: true },
      ],
    }),
  })
  const runId = await waitUntil(
    async () =>
      (await ok<AutomationDetail>('GET', `/automations/${automation.id}`)).history.find(
        (r) => r.runId !== undefined,
      )?.runId,
    'the Automation Run',
  )
  const finished = await waitUntil(
    async () =>
      (await ok<AutomationDetail>('GET', `/automations/${automation.id}`)).history.find(
        (r) => r.runId === runId && r.finishedAt !== undefined,
      ),
    'the Automation Run to finish',
    90_000,
  )
  const results = assistantTexts((await client.getRun(runId)).conversation).map(
    (t) => JSON.parse(t) as { code: number; stdout: string; stderr: string },
  )
  expect(results.slice(0, 12).map((r) => [r.code, r.stderr])).toEqual(
    Array.from({ length: 12 }, () => [0, '']),
  )
  expect(results[1]?.stdout).toMatch(/^Desk · widgets · electron · running · port \d+$/m)
  expect(results[3]?.stdout).toContain('Desk window')
  expect(results[6]?.stdout).toContain('Pressed')
  expect(results[12]?.code).not.toBe(0)
  expect(results[12]?.stderr).toContain('A desktop App has no addresses to navigate to')

  const shots = finished.screenshots ?? []
  expect(shots.map((s) => s.name)).toEqual(['Desk screenshot.png', 'Desk screenshot.png'])
  expect(shots[0]?.hash).not.toBe(shots[1]?.hash)
  const bytes = await ok<{ data: string }>(
    'GET',
    `/attachments/${shots[0]?.hash}/${encodeURIComponent('Desk screenshot.png')}`,
  )
  expect(pngSize(Buffer.from(bytes.data, 'base64'))).toEqual({ width: 390, height: 844 })

  const electronProcesses = async () => {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='])
    return stdout.split('\n').filter((line) => line.includes(stubElectron))
  }
  await waitUntil(
    async () => ((await electronProcesses()).length === 0 ? true : undefined),
    'every Electron process to end when the firing stops its Apps',
  )
})
