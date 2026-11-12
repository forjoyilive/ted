import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDaemonInfo } from '@ted/protocol'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { redactSecrets } from '../../daemon/src/redact.ts'
import {
  api,
  assistantTexts,
  hostRecords,
  isAlive,
  killRunHosts,
  removeHome,
  stopDaemonIn,
  waitUntil,
} from '../../daemon/test/helpers.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'
import { loadedWindow } from './first-window.ts'
import { resolveElectron } from './support/electron-installation.ts'

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

beforeAll(async () => {
  await buildRenderer()
})

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-app-update-'))
  cwd = await mkdtemp(path.join(tmpdir(), 'ted-app-update-cwd-'))
  latest = { version: '99.0.0' }
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
  feed?.close()
  feed = undefined
  await stopDaemonIn(home)
  await killRunHosts(home)
  await removeHome(home)
  await rm(cwd, { recursive: true, force: true })
}, 30_000)

const updateLog = () => path.join(home, 'update-test.log')

async function launchApp(): Promise<Page> {
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
    },
  })
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
    const save = async () => {
      try {
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, JSON.stringify({ pids, observations, stderr }, null, 2))
      } catch {
        console.warn('Update restart: could not save diagnostics')
      }
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
    const watch = (launched: ElectronApplication | undefined) => {
      pids.electron = launched?.process().pid
      launched?.process().stderr?.on('data', (data: Buffer) => {
        stderr = redactSecrets((stderr + data.toString('utf8')).slice(-16_384))
        void save()
      })
    }

    try {
      await mark('launch-start')
      const window = await launchApp()
      watch(app)
      await mark('launch-loaded')
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
      await mark('run-started')
      await waitUntil(
        async () =>
          assistantTexts((await client.getRun(run.id)).conversation).length >= 3 || undefined,
        'some output',
      )
      const hostStart = (await hostRecords(home, run.id)).find((r) => r.t === 'start')
      if (hostStart) pids.host = Number(hostStart.hostPid)
      await mark('output-seen')

      const exited = once(
        app?.process() as NonNullable<ReturnType<ElectronApplication['process']>>,
        'exit',
      )
      await sidebar(window).getByRole('button', { name: 'Update ready · Restart' }).click()
      await mark('restart-clicked')
      await exited
      app = undefined
      await mark('app-exited')

      expect(await readFile(updateLog(), 'utf8')).toBe('install 99.0.0\n')
      await waitUntil(() => !isAlive(info.pid) || undefined, 'the old daemon to stop')
      await mark('old-daemon-stopped')
      const host = (await hostRecords(home, run.id)).find((r) => r.t === 'start')
      expect(isAlive(Number(host?.hostPid))).toBe(true)

      latest = { version: '0.0.1' }
      await mark('relaunch-start')
      const relaunched = await launchApp()
      watch(app)
      await mark('relaunch-loaded')
      ;({ info, client } = await daemonApi())
      await writeFile(release, '')
      await mark('run-released')
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
    }
  })

  test('a failed install shows the warning banner with Download, and TED comes back', async () => {
    latest = { version: '99.0.0', failInstall: true }
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
    await expect
      .poll(() =>
        window.evaluate(() =>
          (
            globalThis as unknown as { ted: { request(name: string): Promise<unknown> } }
          ).ted.request('connection'),
        ),
      )
      .toEqual({ state: 'connected' })
  })
})
