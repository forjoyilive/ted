import { mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
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

const appDir = fileURLToPath(new URL('..', import.meta.url))
const electronPath = createRequire(import.meta.url)('electron') as string

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
  const window = await app.firstWindow()
  await window.emulateMedia({ colorScheme: null })
  await sidebar(window).waitFor()
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
    const details = window.getByRole('complementary', { name: 'Task details' })

    await window.keyboard.press('e')
    const dialog = window.getByRole('dialog', { name: 'Edit NB-1' })
    await dialog
      .getByRole('textbox', { name: 'Description' })
      .fill('Typing cafe should find Café.\nIn titles and bodies.')
    await dialog.getByRole('button', { name: /^Save/ }).click()
    await dialog.waitFor({ state: 'detached' })

    await thread.getByText('You edited the description').waitFor()
    await thread.getByRole('button', { name: 'Show changes' }).click()
    await thread.getByText('Only in titles.').waitFor()
    await thread.getByText('In titles and bodies.').first().waitFor()

    const brief = details.getByRole('region', { name: 'Task brief' })
    await brief.getByRole('button', { name: 'Original request' }).click()
    await brief.getByText(/Only in titles\./).waitFor()
    await brief.getByRole('button', { name: 'History · 1 edit' }).click()
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
  })

  test('Priority and Clarify depth change from Task details', async () => {
    const window = await openTask()
    const details = window.getByRole('complementary', { name: 'Task details' })

    await details.getByLabel('Priority').selectOption('high')
    await details.locator('span', { hasText: /^High$/ }).waitFor()
    await details.getByLabel('Clarify depth').selectOption('few')
    await details.getByText('Few · set by you').waitFor()
    const task = (await (await client()).listTasks())[0]
    expect(task).toMatchObject({ priority: 'high', clarifyDepth: 'few', clarifyDepthBy: 'human' })
  })
})
