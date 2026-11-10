import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { demoEnvironment, seedDemoFromCli, verifyDemo } from '@ted/daemon/demo'
import { DaemonClient, readDaemonInfo } from '@ted/protocol'
import { type ElectronApplication, _electron as electron } from 'playwright'
import { afterEach, expect, test } from 'vitest'
import { killAppHosts, killRunHosts, stopDaemonIn } from '../../daemon/test/helpers.ts'
import { installedElectron } from '../scripts/electron-path.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'

let home: string
let app: ElectronApplication | undefined
const original = { ...process.env }
afterEach(async () => {
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
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  await buildRenderer()
  await seedDemoFromCli(home)
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
  let window = await app.firstWindow({ timeout: 180_000 })
  let nav = window.getByRole('navigation', { name: 'Sidebar' })
  await nav.waitFor({ timeout: 180_000 })
  await nav.getByRole('button', { name: 'Garden', exact: true }).click()
  await window
    .getByRole('region', { name: 'Backlog', exact: true })
    .getByText('Add keyboard hints to the editor')
    .waitFor()
  const manifest = JSON.parse(await readFile(path.join(home, 'demo.json'), 'utf8'))
  console.log(`Demo ready in ${Date.now() - started} ms; scenarios ${manifest.elapsedMs} ms`)
  expect(Date.now() - started).toBeLessThan(60_000)
  const before = await readFile(path.join(home, 'demo.json'), 'utf8')
  await closeApp(app)
  app = await launch()
  window = await app.firstWindow({ timeout: 180_000 })
  nav = window.getByRole('navigation', { name: 'Sidebar' })
  await nav.waitFor()
  expect(await readFile(path.join(home, 'demo.json'), 'utf8')).toBe(before)
  await nav.getByRole('button', { name: 'Garden', exact: true }).waitFor()
  const info = await readDaemonInfo(home)
  expect(info).toBeDefined()
  if (info) await verifyDemo(new DaemonClient(info, info.token))
}, 240_000)
