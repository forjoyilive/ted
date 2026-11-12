import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startExecutionService, stopExecutionService, workerRequest } from '@ted/daemon/execution'
import { type Factory, readDaemonInfo, type Task } from '@ted/protocol'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { redactSecrets } from '../../daemon/src/redact.ts'
import {
  api,
  assistantTexts,
  commitToOrigin,
  fixtureEnvironment,
  hostRecords,
  isAlive,
  killRunHosts,
  makeOriginRepo,
  removeHome,
  stopDaemonIn,
  waitUntil,
} from '../../daemon/test/helpers.ts'
import { observe } from '../../daemon/test/support/execution-observations.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'
import { loadedWindow } from './first-window.ts'
import { resolveElectron } from './support/electron-installation.ts'
import { executionStartupGate } from './support/execution-startup.ts'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const stubClaudePath = fileURLToPath(
  new URL('../../daemon/test/fixtures/stub-claude.ts', import.meta.url),
)
const electronPath = resolveElectron()

vi.setConfig({ testTimeout: 90_000 })

let home: string
let cwd: string
let app: ElectronApplication | undefined
let feed: http.Server | undefined
let latest: { version: string; failInstall?: boolean }
let cliWorker = false

const loadWorkers = Number(process.env.UPDATE_RESTART_LOAD) || 0
let workload: ChildProcess | undefined
let workloadEnded = false

beforeAll(async () => {
  await buildRenderer()
  if (loadWorkers < 1) return
  workload = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../../../scripts/check-load.ts', import.meta.url)),
      String(loadWorkers),
    ],
    { env: { ...process.env }, stdio: ['ignore', 'pipe', 'ignore'] },
  )
  workload.once('exit', () => {
    workloadEnded = true
  })
  const [ready] = (await once(workload.stdout as NonNullable<ChildProcess['stdout']>, 'data', {
    signal: AbortSignal.timeout(20_000),
  })) as [Buffer]
  if (!ready.toString('utf8').includes('READY')) throw new Error('CPU workload was not ready')
})

afterAll(() => {
  const endedEarly = workloadEnded
  workload?.kill('SIGKILL')
  expect(endedEarly).toBe(false)
})

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-app-update-'))
  cwd = await mkdtemp(path.join(tmpdir(), 'ted-app-update-cwd-'))
  latest = { version: '99.0.0' }
  cliWorker = false
  feed = http.createServer((req, res) => {
    if (req.url !== '/latest.json') return void res.writeHead(404).end()
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(latest))
  })
  feed.listen(0, '127.0.0.1')
  await once(feed, 'listening')
})

afterEach(async () => {
  await closeApp(app)
  app = undefined
  if (cliWorker) await stopExecutionService(await executionHome())
  feed?.close()
  feed = undefined
  await stopDaemonIn(home)
  await killRunHosts(home)
  await removeHome(home)
  await rm(cwd, { recursive: true, force: true })
}, 30_000)

const updateLog = () => path.join(home, 'update-test.log')
const executionHome = async () => path.join(await realpath(home), 'execution-worker')

async function launchApp(
  extraEnv: Record<string, string> = {},
  launched?: (app: ElectronApplication) => void,
): Promise<Page> {
  const port = ((feed as http.Server).address() as AddressInfo).port
  app = await electron.launch({
    executablePath: electronPath,
    args: [appDir],
    env: {
      ...process.env,
      TED_HOME: home,
      TED_IDLE_EXIT_MS: '30000',
      TED_CLAUDE_BIN: stubClaudePath,
      TED_HIDDEN_WINDOW: '1',
      TED_UPDATE_FEED: `http://127.0.0.1:${port}/`,
      TED_UPDATE_LOG: updateLog(),
      TED_EXECUTION_HOME: await executionHome(),
      ...extraEnv,
    },
  })
  launched?.(app)
  const window = await loadedWindow(app)
  return window
}

const sidebar = (window: Page) => window.getByRole('navigation', { name: 'Sidebar' })

async function menuLabels(electronApp: ElectronApplication): Promise<string[]> {
  return electronApp.evaluate(({ Menu }) => {
    const labels: string[] = []
    const walk = (menu: Electron.Menu | null | undefined) => {
      for (const item of menu?.items ?? []) {
        if (item.label) labels.push(item.label)
        walk(item.submenu)
      }
    }
    walk(Menu.getApplicationMenu())
    return labels
  })
}

async function daemonApi() {
  const info = await waitUntil(() => readDaemonInfo(home), 'daemon.json')
  return { info, client: api(info.port, { appKey: process.env.TED_APP_TOKEN ?? '' }) }
}

describe('in-app updates', () => {
  test('a downloaded update shows the chip, the menu item and About and updates', async () => {
    const window = await launchApp()

    await sidebar(window).getByRole('button', { name: 'Update ready · Restart' }).waitFor()
    expect(await menuLabels(app as ElectronApplication)).toContain('Restart to update to 99.0')

    await sidebar(window)
      .getByRole('button', { name: /^Settings/ })
      .last()
      .click()
    await window.getByText('Update ready: TED 99.0.0.').waitFor()
    await window.getByRole('button', { name: 'Check for updates' }).waitFor()
    await window.getByRole('button', { name: 'Restart to update' }).waitFor()
  })

  test('Restart to update keeps a working Run going into the next launch with no lost output', async () => {
    const started = performance.now()
    const file = path.join(home, 'logs', 'update-restart.json')
    const pids: Record<'electron' | 'oldDaemon' | 'host', number | undefined> = {
      electron: undefined,
      oldDaemon: undefined,
      host: undefined,
    }
    const observations: Record<string, unknown>[] = []
    let stderr = ''
    let saving = Promise.resolve()
    let ended = false
    const save = () => {
      saving = saving.then(async () => {
        try {
          await mkdir(path.dirname(file), { recursive: true })
          await writeFile(file, JSON.stringify({ pids, observations, stderr }, null, 2))
        } catch {
          console.warn('Update restart: could not save diagnostics')
        }
      })
      return saving
    }
    const mark = async (phase: string) => {
      const alive = (pid: number | undefined) => (pid === undefined ? null : isAlive(pid))
      const observation = {
        phase,
        elapsedMs: Math.round(performance.now() - started),
        electronAlive: alive(pids.electron),
        oldDaemonAlive: alive(pids.oldDaemon),
        hostAlive: alive(pids.host),
        daemonInfoPid: (await readDaemonInfo(home).catch(() => undefined))?.pid ?? null,
      }
      observations.push(observation)
      console.log('Update restart:', JSON.stringify({ home, ...observation }))
      await save()
    }
    const watch = (launched: ElectronApplication) => {
      pids.electron = launched.process().pid
      launched.process().stderr?.on('data', (data: Buffer) => {
        if (ended) return
        stderr = redactSecrets((stderr + data.toString('utf8')).slice(-16_384))
        void save()
      })
    }

    try {
      const gate = await executionStartupGate(cwd)
      await mark('launch-start')
      const window = await launchApp(gate.env, watch)
      await mark('launch-loaded')
      await sidebar(window)
        .getByRole('button', { name: /^Settings/ })
        .last()
        .click()
      await window
        .getByRole('navigation', { name: 'Settings' })
        .getByRole('button', { name: 'Machines', exact: true })
        .click()
      const opened = app?.waitForEvent('window')
      await window.getByRole('button', { name: 'Use this Mac as a worker…' }).click()
      const worker = await opened
      if (!worker) throw new Error('Worker window did not open')
      await worker.getByRole('button', { name: 'Start worker' }).click()
      await expect
        .poll(async () => (await workerRequest(await executionHome(), 'status')).state)
        .toBe('unpaired')
      const workerControl = JSON.parse(
        await readFile(path.join(await executionHome(), 'control.json'), 'utf8'),
      ) as { pid: number }
      await window.getByTitle('Back (Esc)').click()
      await mark('worker-started')
      let { info, client } = await daemonApi()
      pids.oldDaemon = info.pid
      const release = path.join(cwd, 'release')
      const run = await client.startRun(
        [
          { lines: 20, everyMs: 50 },
          { waitFor: release },
          { say: 'after the update' },
          { endTurn: true },
        ],
        cwd,
      )
      await waitUntil(
        async () =>
          assistantTexts((await client.getRun(run.id)).conversation).length >= 3 || undefined,
        'some output',
      )
      const hostStart = (await hostRecords(home, run.id)).find((r) => r.t === 'start')
      if (hostStart) pids.host = Number(hostStart.hostPid)
      await mark('output-seen')

      const checkRelease = path.join(cwd, 'release-check')
      const origin = await makeOriginRepo(cwd)
      const checkCommand = `while [ ! -f '${checkRelease.replaceAll("'", "'\\''")}' ]; do sleep 0.05; done`
      await commitToOrigin(cwd, {
        '.ted/workflow.yaml': [
          'version: 1',
          'order: [intake, work, validate, merge]',
          'stages:',
          '  validate:',
          '    checks:',
          '      - name: Held Check',
          `        run: ${JSON.stringify(checkCommand)}`,
          '',
        ].join('\n'),
      })
      const factoryResult = await client.call('POST', '/dev/factories', { repo: origin, key: 'NB' })
      expect(factoryResult.status).toBe(201)
      const factory = factoryResult.body as Factory
      const taskResult = await client.call('POST', '/tasks', {
        factory: factory.key,
        title: JSON.stringify({
          steps: [
            { run: ['sh', '-c', 'echo changed > changed.txt'] },
            { run: ['ted', 'checks'] },
            { endTurn: true },
          ],
        }),
      })
      expect(taskResult.status).toBe(201)
      const task = taskResult.body as Task
      expect((await client.call('POST', `/tasks/${task.id}/start`)).status).toBe(200)
      await expect
        .poll(() => client.call('GET', '/update/work'))
        .toMatchObject({
          body: { checks: 1, merges: 0 },
        })

      await mark('check-running')
      await stopExecutionService(await executionHome())
      await gate.hold()
      const starting = worker
        .evaluate(() => globalThis.window.ted.request('workerStart'))
        .catch(() => undefined)
      let startingPid: number
      try {
        startingPid = await gate.pid()
        const installing = window.getByRole('button', { name: 'Update ready · Restart' })
        const exited = once(
          app?.process() as NonNullable<ReturnType<ElectronApplication['process']>>,
          'exit',
        )
        await installing.click()
        await mark('restart-clicked')
        await window.getByRole('button', { name: 'Restarting…', exact: true }).waitFor()
        await gate.release()
        await window.getByRole('button', { name: 'Finishing 1 Check…', exact: true }).waitFor()
        await waitUntil(() => !isAlive(startingPid), 'the worker to stop before handover waits')
        await expect(workerRequest(await executionHome(), 'status')).rejects.toThrow()
        await expect(
          window.evaluate(() => globalThis.window.ted.request('openWorker')),
        ).rejects.toThrow('Worker is stopping')
        expect(isAlive(info.pid)).toBe(true)
        expect(await client.call('GET', '/update/work')).toMatchObject({
          body: { checks: 1, merges: 0 },
        })
        await writeFile(checkRelease, '')
        await mark('check-released')
        await exited
        await mark('app-exited')
        await starting
        await waitUntil(() => !isAlive(startingPid), 'the delayed worker to exit during update')
      } finally {
        await gate.release()
        await writeFile(checkRelease, '')
      }

      app = undefined
      expect(isAlive(workerControl.pid)).toBe(false)
      await expect(workerRequest(await executionHome(), 'status')).rejects.toThrow()
      await observe('worker-update-handover', {
        appOwnedWorker: 'exited before update installation completed',
        localControl: 'unavailable after shutdown',
      })
      await observe('worker-startup-update', {
        startup: 'held before control publication',
        update: 'waited for startup and confirmed owned worker exit',
      })
      await observe('worker-update-start-refused', {
        handover: 'held by a real Check after initial worker shutdown',
        reopen: 'refused while Check remained running',
        localControl: 'unavailable before installation',
      })

      expect(await readFile(updateLog(), 'utf8')).toBe('install 99.0.0\n')
      await waitUntil(() => !isAlive(info.pid) || undefined, 'the old daemon to stop')
      await mark('old-daemon-stopped')
      const host = (await hostRecords(home, run.id)).find((r) => r.t === 'start')
      expect(isAlive(Number(host?.hostPid))).toBe(true)

      latest = { version: '0.0.1' }
      await mark('relaunch-start')
      const relaunched = await launchApp({}, watch)
      await mark('relaunch-loaded')
      ;({ info, client } = await daemonApi())
      await writeFile(release, '')
      const done = await waitUntil(async () => {
        const r = await client.getRun(run.id)
        return r.run.state === 'idle' ? r : undefined
      }, 'the Run to finish its turn under the new daemon')
      await mark('run-idle')
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
      expect(assistantTexts(done.conversation)).toEqual([...lines, 'after the update'])
      expect((await hostRecords(home, run.id)).filter((r) => r.t === 'start')).toHaveLength(1)
      await relaunched
        .getByRole('region', { name: 'Problems' })
        .getByText('Update to 99.0 failed')
        .waitFor()

      await mark('banner-shown')
    } catch (error) {
      await mark('failed')
      throw error
    } finally {
      ended = true
      await saving
    }
  })

  test('a failed install shows the warning banner with Download, and TED comes back', async () => {
    latest = { version: '99.0.0', failInstall: true }
    await startExecutionService(await executionHome(), fixtureEnvironment(home))
    cliWorker = true
    await workerRequest(await executionHome(), 'start')
    const workerControl = JSON.parse(
      await readFile(path.join(await executionHome(), 'control.json'), 'utf8'),
    ) as { pid: number }
    const window = await launchApp()
    const { info } = await daemonApi()

    await sidebar(window).getByRole('button', { name: 'Update ready · Restart' }).click()

    const banner = window.getByRole('region', { name: 'Problems' })
    await banner.getByText('Update to 99.0 failed').waitFor()
    await banner.getByRole('button', { name: 'Download' }).waitFor()
    expect(await readFile(updateLog(), 'utf8')).toBe('install 99.0.0\n')
    const next = await waitUntil(async () => {
      const now = await readDaemonInfo(home)
      return now && now.pid !== info.pid ? now : undefined
    }, 'a new daemon')
    expect(isAlive(next.pid)).toBe(true)
    expect(isAlive(workerControl.pid)).toBe(true)
    expect((await workerRequest(await executionHome(), 'status')).state).toBe('unpaired')
    await observe('worker-update-cli-owned', {
      cliOwnedWorker: 'same process remains available',
      failedInstall: 'daemon recovered',
    })
    await expect
      .poll(() =>
        window.evaluate(() =>
          (
            globalThis as unknown as { ted: { request(name: string): Promise<unknown> } }
          ).ted.request('connection'),
        ),
      )
      .toEqual({ state: 'connected' })
    const opened = app?.waitForEvent('window')
    await window.evaluate(() => globalThis.window.ted.request('openWorker'))
    const worker = await opened
    if (!worker) throw new Error('Worker window did not reopen after update failure')
    await worker.evaluate(() => globalThis.window.ted.request('workerStart'))
    expect(isAlive(workerControl.pid)).toBe(true)
    expect((await workerRequest(await executionHome(), 'status')).state).toBe('unpaired')
  })
})
