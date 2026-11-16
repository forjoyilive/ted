import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Coordinator, type CoordinatorTask, tedPaths } from '@ted/protocol'
import { type ElectronApplication, _electron as electron } from 'playwright'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { loadRunTokens } from '../../daemon/src/run-token.ts'
import { api, daemonAsApp, makeOriginRepo, waitUntil } from '../../daemon/test/helpers.ts'
import { buildRenderer } from './build-renderer.ts'
import { loadedWindow } from './first-window.ts'
import { cleanupCoordinator } from './support/coordinator-cleanup.ts'
import { resolveElectron } from './support/electron-installation.ts'

const longReply = Array.from({ length: 40 }, (_, n) => `Point ${n + 1} to weigh.`)
const appDir = fileURLToPath(new URL('..', import.meta.url))
const electronPath = resolveElectron()
let home: string
let app: ElectronApplication | undefined
vi.setConfig({ testTimeout: 120_000 })
beforeAll(async () => {
  await buildRenderer()
})
afterEach(async ({ task }) => {
  const test = task.name
  const closing = app
  app = undefined
  await cleanupCoordinator(home, closing, (evidence) =>
    process.stderr.write(`Coordinator cleanup: ${JSON.stringify({ test, ...evidence })}\n`),
  )
})

test('Coordinator opens from the sidebar, sends, shows receipts and keeps its whole conversation and scroll position when reopened and after a new Run', async () => {
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
  const current = async () => {
    const [chat] = await client.coordinatorChats(factory.id)
    return chat && client.coordinator(chat.id)
  }
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
      steps: [
        { say: ['Here is what needs attention.', ...longReply].join('\n\n') },
        { waitFor: path.join(home, 'finish') },
      ],
    }),
  )
  await pane.getByRole('button', { name: 'Send', exact: true }).click()
  await pane.getByText('Here is what needs attention.', { exact: true }).waitFor()
  const c = await waitUntil(async () => {
    const c = await current()
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
  await pane.getByText(/Started NB-/).waitFor()
  await pane.getByRole('button', { name: /^Open NB-/ }).waitFor()
  const details = window.getByRole('complementary', { name: 'Coordinator details' })
  await details.getByRole('button', { name: /Discuss priorities/ }).waitFor()
  await window.screenshot({
    path: path.join(process.cwd(), 'node_modules/.cache/ted-40/coordinator-implemented.png'),
  })
  await sidebar.getByRole('button', { name: 'Task views' }).click()
  await sidebar.getByRole('button', { name: 'List', exact: true }).click()
  await entry.click()
  await pane.getByText('Here is what needs attention.', { exact: true }).waitFor()
  await pane.getByText(/Started NB-/).waitFor()
  expect(((await current()) as Coordinator).runId).toBe(c.runId)
  await pane.getByRole('button', { name: 'Stop the turn', exact: true }).click()
  await waitUntil(
    async () =>
      (await current())?.status === 'ready' &&
      (await client.getRunChat(c.runId)).run.state === 'finished',
    'stopped Coordinator',
  )
  await entry.getByRole('img', { name: 'Working' }).waitFor({ state: 'detached' })
  const scroller = pane.locator('[data-scroller]')
  await scroller.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event('scroll'))
  })
  await pane
    .getByRole('textbox', { name: 'Message to the Coordinator' })
    .fill(JSON.stringify({ steps: [{ say: 'Picking up where we were.' }, { endTurn: true }] }))
  await pane.getByRole('button', { name: 'Send', exact: true }).click()
  await pane.getByText('Picking up where we were.', { exact: true }).waitFor()
  expect(((await current()) as Coordinator).runId).not.toBe(c.runId)
  await sidebar.getByRole('button', { name: 'List', exact: true }).click()
  await entry.click()
  await pane.getByText('Picking up where we were.', { exact: true }).waitFor({ state: 'attached' })
  await pane.getByText(/^Here is what needs attention\./).waitFor()
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeLessThan(5)
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
  await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: false }))
  const client = await daemonAsApp(home, env)
  const origin = await makeOriginRepo(path.join(home, 'origin'))
  const factory = await client.addFactory({ repo: origin, key: 'NB' })
  const current = async () => {
    const [chat] = await client.coordinatorChats(factory.id)
    return chat && client.coordinator(chat.id)
  }
  await client.checkAgentHealth()
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
  expect((await current())?.started).toBe(false)
  await sidebar.getByRole('button', { name: 'Task views' }).click()
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
