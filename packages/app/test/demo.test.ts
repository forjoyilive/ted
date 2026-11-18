import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { demoEnvironment, seedDemoFromCli, stopDemoFromCli, verifyDemo } from '@ted/daemon/demo'
import { DaemonClient, readDaemonInfo } from '@ted/protocol'
import { type ElectronApplication, _electron as electron } from 'playwright'
import { afterEach, expect, test, vi } from 'vitest'
import {
  appHostStarts,
  hostRecords,
  isAlive,
  killAppHosts,
  killRunHosts,
  stopDaemonIn,
} from '../../daemon/test/helpers.ts'
import { installedElectron } from '../scripts/electron-path.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'
import { loadedWindow } from './first-window.ts'

let home: string
let app: ElectronApplication | undefined
const original = { ...process.env }
afterEach(async () => {
  vi.restoreAllMocks()
  await closeApp(app)
  if (home) {
    await stopDaemonIn(home)
    await killAppHosts(home)
    await killRunHosts(home)
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, original)
}, 30_000)

test('opens the populated demo and reuses it when reopened', async () => {
  const started = Date.now()
  const parent = path.resolve('node_modules/.cache/ted-home')
  await mkdir(parent, { recursive: true })
  home = await mkdtemp(path.join(parent, 'demo-app-'))
  const env = { ...demoEnvironment(home), TED_HIDDEN_WINDOW: '1' }
  const elsewhere = await mkdtemp(path.join(parent, 'demo-elsewhere-'))
  Object.assign(process.env, {
    TED_HOME: elsewhere,
    TED_CLAUDE_BIN: path.join(elsewhere, 'missing-claude'),
    TED_CODEX_BIN: path.join(elsewhere, 'missing-codex'),
    TED_GH_BIN: path.join(elsewhere, 'missing-gh'),
  })
  const callerEnv = { ...process.env }
  await buildRenderer()
  const taskReads = vi.spyOn(DaemonClient.prototype, 'listTasks')
  const conversationReads = vi.spyOn(DaemonClient.prototype, 'getRun')
  const planReads = vi.spyOn(DaemonClient.prototype, 'getPlan')
  const automationReads = vi.spyOn(DaemonClient.prototype, 'getAutomation')
  await seedDemoFromCli(home)
  expect(process.env).toEqual(callerEnv)
  expect(await readdir(elsewhere)).toEqual([])
  await rm(elsewhere, { recursive: true })
  expect(taskReads.mock.calls.length).toBeLessThan(100)
  expect(conversationReads.mock.calls.length).toBeLessThan(100)
  expect(planReads.mock.calls.length).toBeLessThan(30)
  expect(automationReads.mock.calls.length).toBeLessThan(15)
  vi.restoreAllMocks()
  const launch = async () => {
    const launched = await electron.launch({
      executablePath: await installedElectron(),
      args: [fileURLToPath(new URL('..', import.meta.url))],
      env,
      timeout: 180_000,
    })
    return launched
  }
  app = await launch()
  let window = await loadedWindow(app)
  let nav = window.getByRole('navigation', { name: 'Sidebar' })
  await nav.waitFor({ timeout: 180_000 })
  await nav.getByRole('button', { name: 'Garden', exact: true }).click()
  const gardenViews = nav
    .getByRole('article', { name: 'Garden', exact: true })
    .getByRole('button', { name: 'Views', exact: true })
  if ((await gardenViews.getAttribute('aria-expanded')) !== 'true') await gardenViews.click()
  await nav.getByRole('button', { name: 'Task views' }).click()
  await nav.getByRole('button', { name: 'Board', exact: true }).click()
  await window
    .getByRole('region', { name: 'Backlog', exact: true })
    .getByText('Add keyboard hints to the editor')
    .waitFor()
  const manifest = JSON.parse(await readFile(path.join(home, 'demo.json'), 'utf8'))
  console.log(
    `Demo prepared and opened in ${Date.now() - started} ms; scenarios ${manifest.elapsedMs} ms`,
  )
  const before = await readFile(path.join(home, 'demo.json'), 'utf8')
  await closeApp(app)
  app = await launch()
  window = await loadedWindow(app)
  nav = window.getByRole('navigation', { name: 'Sidebar' })
  await nav.waitFor()
  expect(await readFile(path.join(home, 'demo.json'), 'utf8')).toBe(before)
  await nav.getByRole('button', { name: 'Garden', exact: true }).waitFor()
  const info = await readDaemonInfo(home)
  expect(info).toBeDefined()
  if (info) await verifyDemo(new DaemonClient(info, info.token))
  expect((await seedDemoFromCli(home)).tasks).toEqual(manifest.tasks)
  await closeApp(app)
  app = undefined
  const pids = [info?.pid ?? 0]
  for (const run of await readdir(path.join(home, 'runs'))) {
    for (const record of await hostRecords(home, run)) {
      if (record.t === 'start') pids.push(Number(record.hostPid), Number(record.agentPid))
    }
  }
  const appStarts = await appHostStarts(home)
  expect(appStarts.length).toBeGreaterThan(0)
  for (const start of appStarts) pids.push(start.hostPid, start.pid ?? 0)
  expect(pids.filter((pid) => pid > 1 && isAlive(pid)).length).toBeGreaterThan(0)
  await stopDemoFromCli(home)
  expect(await readDaemonInfo(home)).toBeUndefined()
  expect(pids.filter((pid) => pid > 1 && isAlive(pid))).toEqual([])
  expect(JSON.parse(await readFile(path.join(home, 'demo.json'), 'utf8')).complete).toBe(false)
}, 240_000)
