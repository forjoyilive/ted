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
import { firstWindow } from './first-window.ts'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const electronPath = createRequire(import.meta.url)('electron') as string

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
  const window = await firstWindow(app)
  await window.emulateMedia({ colorScheme: null })
  await sidebar(window).waitFor()
  return { window, ted: await client() }
}

async function openPalette(window: Page) {
  await window.keyboard.press('Meta+k')
  await palette(window).waitFor()
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

  test('finds description history, briefs and Comments; archived results are labelled and lower', async () => {
    const { window, ted } = await launch()
    const open = await ted.createTask({
      factory: 'NB',
      title: 'Search improvements',
      description: 'Search ignores accents',
      start: false,
    })
    await ted.editTask(open.id, { description: 'Fold diacritics' })
    const old = await ted.createTask({
      factory: 'NB',
      title: 'Old accents work',
      description: 'z',
      start: false,
    })
    await ted.archiveTask(old.id)
    const other = await ted.createTask({
      factory: 'NB',
      title: 'Toast',
      description: 'w',
      start: false,
    })
    await ted.postComment(other.id, 'Watch the accents in toasts')

    await openPalette(window)
    await palette(window).getByRole('combobox').fill('accents')
    const tasks = palette(window).getByRole('group', { name: 'Tasks' })
    await tasks.getByRole('option').nth(1).waitFor()
    const rows = await tasks.getByRole('option').allTextContents()
    expect(rows[0]).toContain('Search improvements')
    expect(rows[0]).toContain('in Original request')
    expect(rows[1]).toContain('Old accents work')
    expect(rows[1]).toContain('Archived')
    const comments = palette(window).getByRole('group', { name: 'Comments' })
    await comments.getByText('“Watch the accents in toasts”').waitFor()
    await comments.getByText(/You · Toast/).waitFor()

    await comments.getByRole('option').click()
    await window
      .getByRole('region', { name: 'Task thread' })
      .getByRole('heading', { name: 'Toast' })
      .waitFor()
  })

  test('finds planning chats by title and opens one', async () => {
    const { window, ted } = await launch()
    await ted.startPlan({
      factory: 'NB',
      message: `Offline editing\n${JSON.stringify({ steps: [{ endTurn: true }] })}`,
    })

    await openPalette(window)
    await palette(window).getByRole('combobox').fill('offline')
    const plans = palette(window).getByRole('group', { name: 'Plans' })
    await plans.getByRole('option', { name: /Offline editing/ }).click()

    await palette(window).waitFor({ state: 'detached' })
    await window
      .getByRole('region', { name: 'Planning chat' })
      .getByRole('heading', { name: 'Offline editing' })
      .waitFor()
  })

  test('commands run from the palette, including the open Task’s actions', async () => {
    const { window, ted } = await launch()
    await ted.createTask({ factory: 'NB', title: 'Sync notes', description: 'y', start: false })

    await openPalette(window)
    await palette(window).getByRole('combobox').fill('open widgets')
    const openFactory = results(window).getByRole('option', { name: 'Open widgets' })
    expect(await openFactory.textContent()).toContain('⌘1')
    await palette(window).getByRole('combobox').fill('go to all')
    await results(window)
      .getByRole('option', { name: /Go to All Tasks/ })
      .click()
    await window.getByRole('row').filter({ hasText: 'NB-1' }).click()
    await window.getByRole('region', { name: 'Task thread' }).waitFor()

    await openPalette(window)
    await palette(window).getByRole('combobox').fill('priority')
    await window.keyboard.press('Enter')
    await palette(window).getByRole('combobox').fill('high')
    await results(window).getByRole('option', { name: /High/ }).click()
    await palette(window).waitFor({ state: 'detached' })
    await expect.poll(async () => (await ted.listTasks())[0]?.priority).toBe('high')

    await openPalette(window)
    await palette(window).getByRole('combobox').fill('delete')
    await window.keyboard.press('Enter')
    await window.getByRole('dialog', { name: /Delete NB-1/ }).waitFor()
  })

  test('no results offers Create Task with the typed text', async () => {
    const { window } = await launch()

    await openPalette(window)
    await palette(window).getByRole('combobox').fill('kanban export')
    await palette(window).getByText('No results for ‘kanban export’').waitFor()
    await results(window).getByRole('option', { name: 'Create Task “kanban export”' }).waitFor()
    await window.keyboard.press('Enter')

    const dialog = window.getByRole('dialog', { name: 'New Task' })
    expect(await dialog.getByRole('textbox', { name: 'Description' }).inputValue()).toBe(
      'kanban export',
    )
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
