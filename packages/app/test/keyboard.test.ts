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
const stubClaudePath = fileURLToPath(
  new URL('../../daemon/test/fixtures/stub-claude.ts', import.meta.url),
)

vi.setConfig({ testTimeout: 90_000 })

let home: string
let app: ElectronApplication | undefined

beforeAll(async () => {
  await buildRenderer()
})

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-app-keys-'))
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
  TED_CLAUDE_BIN: stubClaudePath,
  TED_HIDDEN_WINDOW: '1',
})

const sidebar = (window: Page) => window.getByRole('navigation', { name: 'Sidebar' })
const title = (window: Page) => window.getByRole('heading', { level: 1 }).first()

async function launch(): Promise<{ window: Page; ted: DaemonClient }> {
  const origin = await makeOriginRepo(path.join(home, 'origin'))
  await (await daemonAsApp(home, env())).addFactory({ repo: origin, key: 'NB' })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  const ted = appClient(info, process.env.TED_APP_TOKEN)
  app = await electron.launch({ executablePath: electronPath, args: [appDir], env: env() })
  const window = await app.firstWindow()
  await window.emulateMedia({ colorScheme: null })
  await sidebar(window).waitFor()
  return { window, ted }
}

async function press(window: Page, ...keys: string[]) {
  for (const key of keys) await window.keyboard.press(key)
}

const focusedTask = (window: Page) =>
  window.evaluate(() => document.activeElement?.closest('[data-task]')?.getAttribute('data-task'))

describe('Keyboard shortcuts', () => {
  test('G and a letter go to each screen, and ⌘[ and ⌘] retrace them', async () => {
    const { window, ted } = await launch()
    await ted.createTask({ factory: 'NB', title: 'Sync notes', description: 'x', start: false })

    await press(window, 'g', 'a')
    await expect.poll(() => title(window).textContent()).toBe('All Tasks')
    await press(window, 'g', 'b')
    await expect.poll(() => title(window).textContent()).toMatch(/Board$/)
    await press(window, 'g', 'l')
    await expect.poll(() => title(window).textContent()).toMatch(/List$/)
    await press(window, 'g', 'p')
    await expect.poll(() => title(window).textContent()).toMatch(/Plans$/)

    await press(window, 'ControlOrMeta+BracketLeft')
    await expect.poll(() => title(window).textContent()).toMatch(/List$/)
    await press(window, 'ControlOrMeta+BracketLeft', 'ControlOrMeta+BracketLeft')
    await expect.poll(() => title(window).textContent()).toBe('All Tasks')
    await press(window, 'ControlOrMeta+BracketRight')
    await expect.poll(() => title(window).textContent()).toMatch(/Board$/)

    await press(window, 'g', 'i')
    await expect.poll(() => title(window).textContent()).toBe('Inbox')
  })

  test('/ focuses the filter box, and letters typed there are text, not shortcuts', async () => {
    const { window, ted } = await launch()
    await ted.createTask({ factory: 'NB', title: 'Sync notes', description: 'x', start: false })
    await ted.createTask({ factory: 'NB', title: 'Fix crash', description: 'y', start: false })
    await press(window, 'g', 'b')
    await expect.poll(() => title(window).textContent()).toMatch(/Board$/)

    await press(window, '/')
    await window.keyboard.type('gacrash')
    const box = window.getByRole('searchbox', { name: 'Filter by ID or title' })
    expect(await box.inputValue()).toBe('gacrash')
    expect(await title(window).textContent()).toMatch(/Board$/)
    expect(await window.getByRole('dialog', { name: 'New Task' }).count()).toBe(0)

    await box.fill('crash')
    await expect.poll(() => window.locator('article[data-task]').count()).toBe(1)
  })

  test('? shows every shortcut, and Esc closes the sheet', async () => {
    const { window } = await launch()
    await press(window, 'Shift+Slash')
    const sheet = window.getByRole('dialog', { name: 'Keyboard shortcuts' })
    await sheet.getByRole('region', { name: 'Task actions' }).waitFor()
    const row = sheet.getByRole('row').filter({ hasText: 'Go to Board' })
    expect(await row.locator('kbd').allTextContents()).toEqual(['G', 'B'])
    await press(window, 'Escape')
    await sheet.waitFor({ state: 'detached' })

    await press(window, 'ControlOrMeta+Slash')
    await sheet.waitFor()
  })

  test('on the Board J, K, H and L move between cards, Enter opens, and Task keys act on the card', async () => {
    const { window, ted } = await launch()
    const first = await ted.createTask({
      factory: 'NB',
      title: 'First',
      description: 'x',
      start: false,
    })
    const second = await ted.createTask({
      factory: 'NB',
      title: 'Second',
      description: 'y',
      start: false,
    })
    await press(window, 'g', 'b')
    await expect.poll(() => title(window).textContent()).toMatch(/Board$/)

    await press(window, 'j')
    expect(await focusedTask(window)).toBe(first.displayId)
    await press(window, 'j')
    expect(await focusedTask(window)).toBe(second.displayId)
    await press(window, 'k')
    expect(await focusedTask(window)).toBe(first.displayId)
    await press(window, 'l')
    expect(await focusedTask(window)).toBe(first.displayId)

    await press(window, 'Alt+ArrowDown')
    await expect
      .poll(async () => (await ted.listTasks()).sort((a, b) => a.rank - b.rank).map((t) => t.id))
      .toEqual([second.id, first.id])

    await press(window, 'p')
    const palette = window.getByRole('dialog', { name: 'Search and commands' })
    await palette.getByRole('combobox', { name: 'Set Priority…' }).waitFor()
    await window.keyboard.type('High')
    await press(window, 'Enter')
    await palette.waitFor({ state: 'detached' })
    await expect
      .poll(async () => (await ted.listTasks()).find((t) => t.id === first.id)?.priority)
      .toBe('high')

    await window.locator(`[data-task="${second.displayId}"]`).focus()
    await press(window, 'Enter')
    const thread = window.getByRole('region', { name: 'Task thread' })
    await thread.getByRole('heading', { name: 'Second' }).waitFor()
    await press(window, 'Escape')
    await thread.waitFor({ state: 'detached' })
    await expect.poll(() => title(window).textContent()).toMatch(/Board$/)

    await window.locator(`[data-task="${second.displayId}"]`).focus()
    await press(window, 'ControlOrMeta+Backspace')
    const dialog = window.getByRole('dialog', { name: `Archive ${second.displayId}?` })
    await dialog.waitFor()
    await press(window, 'ControlOrMeta+Enter')
    await dialog.waitFor({ state: 'detached' })
    await expect
      .poll(async () => (await ted.listTasks()).filter((t) => t.archived).map((t) => t.id))
      .toEqual([second.id])
  })

  test('⌥↓ moves a List row in rank, and ⌘⌫ in the comment box edits text instead of archiving', async () => {
    const { window, ted } = await launch()
    const first = await ted.createTask({
      factory: 'NB',
      title: 'One',
      description: 'x',
      start: false,
    })
    const second = await ted.createTask({
      factory: 'NB',
      title: 'Two',
      description: 'y',
      start: false,
    })
    await press(window, 'g', 'l')
    await expect.poll(() => title(window).textContent()).toMatch(/List$/)

    await window.locator(`tr[data-task="${first.displayId}"]`).focus()
    await press(window, 'Alt+ArrowDown')
    await expect
      .poll(async () => (await ted.listTasks()).sort((a, b) => a.rank - b.rank).map((t) => t.id))
      .toEqual([second.id, first.id])

    await press(window, 'Enter')
    const comment = window.getByRole('textbox', { name: 'Comment' })
    await comment.fill('Keep this')
    await press(window, 'ControlOrMeta+Backspace')
    expect(await window.getByRole('dialog', { name: `Archive ${first.displayId}?` }).count()).toBe(
      0,
    )
  })

  test('A needs a confirming Enter to approve, and Esc cancels it', async () => {
    const { window, ted } = await launch()
    const steps = {
      steps: [
        {
          permission: {
            tool: 'Bash',
            input: { command: 'npm install yjs', description: 'Install yjs' },
            description: 'Install yjs',
          },
        },
        { endTurn: true },
      ],
    }
    const task = await ted.createTask({
      factory: 'NB',
      title: JSON.stringify(steps),
      description: 'x',
      start: false,
    })
    await ted.startTask(task.id)
    const row = window
      .getByRole('region', { name: 'Inbox' })
      .getByRole('button')
      .filter({ hasText: 'Permission' })
    await row.click()
    const card = window.getByRole('region', { name: 'Permission', exact: true })
    const approve = card.getByRole('button', { name: /^Approve/ })
    await approve.waitFor()

    await press(window, 'a')
    await card.getByText('↵ to confirm').waitFor()
    await press(window, 'Escape')
    await card.getByText('↵ to confirm').waitFor({ state: 'detached' })
    await window.getByRole('region', { name: 'Task thread' }).waitFor()

    await press(window, 'a', 'Enter')
    await window.getByText('You approved · this request only').waitFor()
  })
})
