import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type DaemonClient, readDaemonInfo } from '@ted/protocol'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  appClient,
  commitToOrigin,
  daemonAsApp,
  makeOriginRepo,
  removeHome,
  stopDaemonIn,
  stubClaudePath,
  stubCodexPath,
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
  home = await mkdtemp(path.join(tmpdir(), 'ted-app-search-'))
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
  TED_CLAUDE_BIN: stubClaudePath,
  TED_CODEX_BIN: stubCodexPath,
})

const sidebar = (window: Page) => window.getByRole('navigation', { name: 'Sidebar' })
const palette = (window: Page) => window.getByRole('dialog', { name: 'Search and commands' })
const results = (window: Page) => palette(window).getByRole('listbox', { name: 'Results' })

async function client(): Promise<DaemonClient> {
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  return appClient(info, process.env.TED_APP_TOKEN)
}

async function launch(): Promise<{ window: Page; ted: DaemonClient }> {
  const origin = await makeOriginRepo(path.join(home, 'origin'))
  await (await daemonAsApp(home, env())).addFactory({ repo: origin, key: 'NB' })
  app = await electron.launch({ executablePath: electronPath, args: [appDir], env: env() })
  const window = await loadedWindow(app)
  await window.emulateMedia({ colorScheme: null })
  return { window, ted: await client() }
}

describe('Search and commands (⌘K)', () => {
  test('an exact ID puts that Task first and Enter opens it', async () => {
    const { window, ted } = await launch()
    await ted.createTask({ factory: 'NB', title: 'Mentions NB-2', description: 'x', start: false })
    await ted.createTask({ factory: 'NB', title: 'Sync notes', description: 'y', start: false })

    await sidebar(window)
      .getByRole('button', { name: /Search/ })
      .click()
    await palette(window).getByRole('combobox').fill('nb-2')
    const first = results(window).getByRole('option').first()
    await expect.poll(() => first.textContent()).toContain('Sync notes')
    expect(await first.getAttribute('aria-selected')).toBe('true')
    await window.keyboard.press('Enter')

    await palette(window).waitFor({ state: 'detached' })
    const thread = window.getByRole('region', { name: 'Task thread' })
    await thread.getByRole('heading', { name: 'Sync notes' }).waitFor()
  })

  test('Conversation search opens and expands the exact tool match, then restores its query', async () => {
    const { window, ted } = await launch()
    await commitToOrigin(path.join(home, 'origin'), {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
    const toolSteps = [
      {
        emit: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'find',
                name: 'Bash',
                input: { command: 'inspect cache', description: 'Inspect the cache' },
              },
            ],
          },
        },
      },
      {
        emit: {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'find',
                content: 'retainedneedle: cache eviction passes',
              },
            ],
          },
        },
      },
      { say: 'The cache is bounded.' },
      { endTurn: true },
    ]
    const task = await ted.createTask({
      factory: 'NB',
      title: 'Inspect cache behavior',
      description: JSON.stringify({ steps: toolSteps }),
    })
    await ted.setTaskLead(task.id, { agent: 'claude' })
    await ted.startTask(task.id)
    await expect.poll(async () => (await ted.search('retainedneedle')).conversations.length).toBe(1)
    await sidebar(window)
      .getByRole('button', { name: /Search/ })
      .click()
    await palette(window).getByRole('combobox').fill('retainedneedle')
    const hit = palette(window).getByRole('group', { name: 'Conversations' }).getByRole('option')
    await hit.waitFor()
    const captures = path.join(appDir, '../../node_modules/.cache/ted-95-work')
    await mkdir(captures, { recursive: true })
    await window.screenshot({ path: path.join(captures, 'search-results.png') })
    await hit.click()
    const row = palette(window).getByRole('button', { name: /Bash.*inspect cache/ })
    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('true')
    const focused = palette(window).locator('[data-chat-item][tabindex="-1"]')
    await expect.poll(() => focused.evaluate((el) => el === document.activeElement)).toBe(true)
    expect(await palette(window).getByRole('textbox').count()).toBe(0)
    await window.screenshot({ path: path.join(captures, 'conversation-match.png') })
    await window.keyboard.press('Escape')
    expect(await palette(window).getByRole('combobox').inputValue()).toBe('retainedneedle')
    await hit.waitFor()
    await window.keyboard.press('Escape')
    await palette(window).waitFor({ state: 'detached' })
  })

  test('⌘F finds text inside the current pane', async () => {
    const { window, ted } = await launch()
    await ted.createTask({
      factory: 'NB',
      title: 'Sync notes',
      description: 'Conflicts resolve by last write',
      start: false,
    })
    await sidebar(window).getByRole('button', { name: 'All Tasks' }).click()
    await window.getByRole('row').filter({ hasText: 'NB-1' }).click()
    await window.getByRole('region', { name: 'Task thread' }).waitFor()

    await window.keyboard.press('Meta+f')
    const find = window.getByRole('search', { name: 'Find in pane' })
    await find.getByRole('textbox').fill('last write')
    await find.getByText(/^1 of \d+$/).waitFor()
    await find.getByRole('textbox').fill('nothing like this')
    await find.getByText('No matches').waitFor()
    await window.keyboard.press('Escape')
    await find.waitFor({ state: 'detached' })
  })
})
