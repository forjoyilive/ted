import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type DaemonClient, readDaemonInfo } from '@ted/protocol'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  appClient,
  daemonAsApp,
  makeOriginRepo,
  removeHome,
  stopDaemonIn,
} from '../../daemon/test/helpers.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'
import { loadedWindow } from './first-window.ts'
import { resolveElectron } from './support/electron-installation.ts'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const electronPath = resolveElectron()

vi.setConfig({ testTimeout: 90_000 })

let home: string
let app: ElectronApplication | undefined

beforeAll(async () => {
  await buildRenderer()
})

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-app-edit-'))
})

afterEach(async () => {
  await closeApp(app)
  app = undefined
  await stopDaemonIn(home)
  await removeHome(home)
}, 30_000)

const env = () => ({
  ...process.env,
  TED_HOME: home,
  TED_IDLE_EXIT_MS: '30000',
  TED_HIDDEN_WINDOW: '1',
})

const sidebar = (window: Page) => window.getByRole('navigation', { name: 'Sidebar' })

async function launchApp(): Promise<Page> {
  app = await electron.launch({ executablePath: electronPath, args: [appDir], env: env() })
  const window = await loadedWindow(app)
  await window.emulateMedia({ colorScheme: null })
  return window
}

async function client(): Promise<DaemonClient> {
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  return appClient(info, process.env.TED_APP_TOKEN)
}

async function openTask(): Promise<Page> {
  const origin = await makeOriginRepo(path.join(home, 'origin'))
  await (await daemonAsApp(home, env())).addFactory({ repo: origin, key: 'NB' })
  const window = await launchApp()
  await (await client()).createTask({
    factory: 'NB',
    title: 'Search ignores accents',
    description: 'Typing cafe should find Café.\nOnly in titles.',
    start: false,
  })
  await sidebar(window).getByRole('button', { name: 'All Tasks' }).click()
  await window.getByRole('row').filter({ hasText: 'NB-1' }).click()
  await window.getByRole('region', { name: 'Task thread' }).waitFor()
  return window
}

describe('Editing a Task', () => {
  test('E edits the description; the thread shows the change and the Original request stays', async () => {
    const window = await openTask()
    const thread = window.getByRole('region', { name: 'Task thread' })

    await window.keyboard.press('e')
    const dialog = window.getByRole('dialog', { name: 'Edit NB-1' })
    await dialog
      .getByRole('textbox', { name: 'Description' })
      .fill('Typing cafe should find Café.\nIn titles and bodies.')
    await dialog.getByRole('button', { name: /^Save/ }).click()
    await dialog.waitFor({ state: 'detached' })

    await thread.getByText('You edited the description').waitFor()
    await thread.getByRole('button', { name: 'Show changes' }).click()
    await thread.getByText('Only in titles.', { exact: true }).waitFor()
    await thread.getByText('In titles and bodies.', { exact: true }).waitFor()

    const request = thread.getByRole('region', { name: 'Original request' })
    await request.getByText(/Only in titles\./).waitFor()
    await request.getByRole('button', { name: 'Description history · 1 edit' }).click()
    const history = window.getByRole('dialog', { name: 'NB-1 description history' })
    await history.getByText(/^Version 2 · edited by you .* · current$/).waitFor()
    await history.getByText(/^Original request · /).waitFor()
    await history.getByRole('button', { name: 'Close' }).click()

    await thread.getByRole('button', { name: 'Task actions' }).click()
    await window.getByRole('menuitem', { name: /Edit title and description/ }).click()
    await dialog.getByRole('textbox', { name: 'Title' }).fill('Accent-blind search')
    await window.keyboard.press('Meta+Enter')
    await thread.getByRole('heading', { name: 'Accent-blind search' }).waitFor()
    await thread.getByText('You renamed this Task to “Accent-blind search”').waitFor()

    const subPrompt = path.join(home, 'layout-helper.md')
    await writeFile(
      subPrompt,
      JSON.stringify({ steps: [{ say: 'Selected Run stays readable.' }, { endTurn: true }] }),
    )
    const daemon = await client()
    const layout = await daemon.createTask({
      factory: 'NB',
      title: JSON.stringify({
        steps: [
          {
            run: [
              'ted',
              'run',
              'start',
              '--agent',
              'claude',
              '--name',
              'Layout helper',
              '--prompt-file',
              subPrompt,
            ],
          },
          { endTurn: true },
        ],
      }),
      description: 'Long original request.\n\n'.repeat(100),
      start: true,
    })
    await sidebar(window).getByRole('button', { name: 'All Tasks' }).click()
    await window.getByRole('row').filter({ hasText: layout.displayId }).click()
    await window.setViewportSize({ width: 1200, height: 900 })
    await thread.getByRole('button', { name: 'See more', exact: true }).click()
    await thread.getByRole('tab', { name: /Layout helper/ }).click()
    const chat = thread.getByRole('region', { name: 'Run chat', exact: true })
    await chat.getByText('Selected Run stays readable.', { exact: true }).waitFor()
    const messages = chat.locator('[data-scroller]').first()
    await expect
      .poll(() => messages.evaluate((element) => element.clientHeight))
      .toBeGreaterThan(100)
    await messages.scrollIntoViewIfNeeded()
    await expect(
      chat.getByText('Selected Run stays readable.', { exact: true }).isVisible(),
    ).resolves.toBe(true)
  })
})
