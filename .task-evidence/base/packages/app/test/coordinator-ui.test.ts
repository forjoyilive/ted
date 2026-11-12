import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Coordinator, type CoordinatorTask, tedPaths } from '@ted/protocol'
import { type ElectronApplication, _electron as electron } from 'playwright'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { loadRunTokens } from '../../daemon/src/run-token.ts'
import {
  api,
  daemonAsApp,
  killRunHosts,
  makeOriginRepo,
  removeHome,
  stopDaemonIn,
  waitUntil,
} from '../../daemon/test/helpers.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'
import { loadedWindow } from './first-window.ts'
import { resolveElectron } from './support/electron-installation.ts'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const electronPath = resolveElectron()
let home: string
let app: ElectronApplication | undefined
vi.setConfig({ testTimeout: 120_000 })
beforeAll(async () => {
  await buildRenderer()
})
afterEach(async () => {
  await closeApp(app)
  await stopDaemonIn(home)
  await killRunHosts(home)
  await removeHome(home)
})

test('Coordinator opens from the sidebar, sends, shows receipts and keeps its whole conversation when reopened and after a new Run', async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-coordinator-ui-'))
  const env = {
    ...process.env,
    TED_HOME: home,
    TED_IDLE_EXIT_MS: '30000',
    TED_HIDDEN_WINDOW: '1',
    TED_CLAUDE_BIN: fileURLToPath(
      new URL('../../daemon/test/fixtures/stub-claude.ts', import.meta.url),
    ),
  }
  const client = await daemonAsApp(home, env)
  const origin = await makeOriginRepo(path.join(home, 'origin'))
  const factory = await client.addFactory({ repo: origin, key: 'NB' })
  const task = await client.createTask({ factory: 'NB', title: 'Discuss priorities' })
  app = await electron.launch({ executablePath: electronPath, args: [appDir], env })
  const window = await loadedWindow(app)
  const sidebar = window.getByRole('navigation', { name: 'Sidebar' })
  await window.keyboard.press('Meta+1')
  const entry = sidebar.getByRole('button', { name: /^Coordinator/ })
  await entry.click()
  const pane = window.getByRole('region', { name: 'Coordinator', exact: true })
  await pane.getByRole('heading', { name: /What needs your attention/ }).waitFor()
  const input = pane.getByRole('textbox', { name: 'Message to the Coordinator' })
  await input.fill(
    JSON.stringify({
      steps: [{ say: 'Here is what needs attention.' }, { waitFor: path.join(home, 'finish') }],
    }),
  )
  await pane.getByRole('button', { name: 'Send', exact: true }).click()
  await pane.getByText('Here is what needs attention.', { exact: true }).waitFor()
  const c = await waitUntil(async () => {
    const c = await client.coordinator(factory.id)
    return c?.status === 'working' ? c : undefined
  }, 'working Coordinator')
  await entry.getByRole('img', { name: 'Working' }).waitFor()
  const info = JSON.parse(
    await (await import('node:fs/promises')).readFile(tedPaths(home).daemonInfo, 'utf8'),
  ) as { port: number }
  const tokens = await loadRunTokens(tedPaths(home).runTokenKey)
  const run = api(info.port, tokens.issue(c.runId))
  const raw = (await run.call('GET', `/coordinator/tasks/${task.id}`)).body as { context: string }
  const read = JSON.parse(raw.context.split('\n').slice(1, -1).join('\n')) as CoordinatorTask
  expect(
    (
      await run.call('POST', `/coordinator/tasks/${task.id}/start`, {
        operation: 'ui-start',
        version: read.version,
      })
    ).status,
  ).toBe(200)
  await pane.getByRole('button', { name: /Started NB-/ }).waitFor()
  const details = window.getByRole('complementary', { name: 'Coordinator details' })
  await details.getByRole('button', { name: /Discuss priorities/ }).waitFor()
  await window.screenshot({
    path: path.join(process.cwd(), 'node_modules/.cache/ted-40/coordinator-implemented.png'),
  })
  await sidebar.getByRole('button', { name: 'List', exact: true }).click()
  await entry.click()
  await pane.getByText('Here is what needs attention.', { exact: true }).waitFor()
  await pane.getByRole('button', { name: /Started NB-/ }).waitFor()
  expect(((await client.coordinator(factory.id)) as Coordinator).runId).toBe(c.runId)
  await pane.getByRole('button', { name: 'Stop the turn', exact: true }).click()
  await waitUntil(
    async () =>
      (await client.coordinator(factory.id))?.status === 'ready' &&
      (await client.getRunChat(c.runId)).run.state === 'finished',
    'stopped Coordinator',
  )
  await entry.getByRole('img', { name: 'Working' }).waitFor({ state: 'detached' })
  await pane
    .getByRole('textbox', { name: 'Message to the Coordinator' })
    .fill(JSON.stringify({ steps: [{ say: 'Picking up where we were.' }, { endTurn: true }] }))
  await pane.getByRole('button', { name: 'Send', exact: true }).click()
  await pane.getByText('Picking up where we were.', { exact: true }).waitFor()
  expect(((await client.coordinator(factory.id)) as Coordinator).runId).not.toBe(c.runId)
  await sidebar.getByRole('button', { name: 'List', exact: true }).click()
  await entry.click()
  await pane.getByText('Picking up where we were.', { exact: true }).waitFor()
  await pane.getByText('Here is what needs attention.', { exact: true }).waitFor()
})

test('Stop keeps unstarted messages visible as Not sent when the Coordinator is reopened', async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-coordinator-unsent-ui-'))
  const env = {
    ...process.env,
    TED_HOME: home,
    TED_IDLE_EXIT_MS: '30000',
    TED_HIDDEN_WINDOW: '1',
    TED_CLAUDE_BIN: fileURLToPath(
      new URL('../../daemon/test/fixtures/stub-claude.ts', import.meta.url),
    ),
  }
  const client = await daemonAsApp(home, env)
  const origin = await makeOriginRepo(path.join(home, 'origin'))
  const factory = await client.addFactory({ repo: origin, key: 'NB' })
  await client.updateSettings({ maxWorkingRuns: 1 })
  const task = await client.createTask({
    factory: 'NB',
    title: JSON.stringify({ steps: [{ waitFor: path.join(home, 'task-end') }, { endTurn: true }] }),
  })
  await client.startTask(task.id)
  await waitUntil(
    async () => (await client.listTasks()).find((t) => t.id === task.id)?.leadRunId !== undefined,
    'Task slot',
  )
  app = await electron.launch({ executablePath: electronPath, args: [appDir], env })
  const window = await loadedWindow(app)
  const sidebar = window.getByRole('navigation', { name: 'Sidebar' })
  await window.keyboard.press('Meta+1')
  await sidebar.getByRole('button', { name: /^Coordinator/ }).click()
  const pane = window.getByRole('region', { name: 'Coordinator', exact: true })
  await pane
    .getByRole('textbox', { name: 'Message to the Coordinator' })
    .fill('Compare the release Tasks before starting anything.')
  await pane.getByRole('button', { name: 'Send', exact: true }).click()
  await pane.getByRole('button', { name: 'Stop the turn', exact: true }).click()
  await pane.getByText('Not sent', { exact: true }).waitFor()
  await pane
    .getByText('Compare the release Tasks before starting anything.', { exact: true })
    .waitFor()
  expect((await client.coordinator(factory.id))?.started).toBe(false)
  await sidebar.getByRole('button', { name: 'List', exact: true }).click()
  await sidebar.getByRole('button', { name: /^Coordinator/ }).click()
  await pane.getByText('Not sent', { exact: true }).waitFor()
  await pane
    .getByText('Compare the release Tasks before starting anything.', { exact: true })
    .waitFor()
  for (const mode of ['light', 'dark'] as const) {
    await window.emulateMedia({ colorScheme: mode })
    await window.screenshot({
      path: path.join(process.cwd(), `node_modules/.cache/ted-40/coordinator-unsent-${mode}.png`),
    })
  }
})
