import { mkdtemp } from 'node:fs/promises'
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

const title = (window: Page) => window.getByRole('heading', { level: 1 }).first()

async function launch(): Promise<{ window: Page; ted: DaemonClient }> {
  const origin = await makeOriginRepo(path.join(home, 'origin'))
  await (await daemonAsApp(home, env())).addFactory({ repo: origin, key: 'NB' })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  const ted = appClient(info, process.env.TED_APP_TOKEN)
  app = await electron.launch({ executablePath: electronPath, args: [appDir], env: env() })
  const window = await loadedWindow(app)
  await window.emulateMedia({ colorScheme: null })
  return { window, ted }
}

async function press(window: Page, ...keys: string[]) {
  for (const key of keys) await window.keyboard.press(key)
}

const focusedTask = (window: Page) =>
  window.evaluate(() => document.activeElement?.closest('[data-task]')?.getAttribute('data-task'))

describe('Keyboard shortcuts', () => {
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

    await window.evaluate(() => {
      document.documentElement.dataset.watchApproval = 'true'
      document.documentElement.dataset.approvalFrames = '0'
      const frame = () => {
        if (document.documentElement.dataset.watchApproval !== 'true') return
        if (
          document
            .querySelector('[aria-label="Task thread"]')
            ?.textContent?.includes('You approved · this request only')
        ) {
          document.documentElement.dataset.approvalFrames = String(
            Number(document.documentElement.dataset.approvalFrames) + 1,
          )
        }
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })
    await press(window, 'a', 'Enter')
    await expect
      .poll(async () => (await ted.listComments(task.id)).find((c) => c.permission)?.answer?.kind)
      .toBe('approved')
    const inbox = window.getByRole('region', { name: 'Inbox' })
    await inbox.getByText('Nothing waiting on you').waitFor()
    await inbox
      .getByRole('status')
      .getByText(`Approved ${task.displayId}’s permission request`)
      .waitFor()
    await inbox.getByRole('status').getByText('This request only').waitFor()
    const frames = await window.evaluate(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
      document.documentElement.dataset.watchApproval = 'false'
      return Number(document.documentElement.dataset.approvalFrames)
    })
    expect(frames).toBe(0)
    await inbox.getByRole('switch', { name: 'Answered' }).click()
    await inbox.getByRole('button').filter({ hasText: 'Permission' }).click()
    await window
      .getByRole('region', { name: 'Task thread' })
      .getByText('You approved · this request only')
      .waitFor()
  })
})
