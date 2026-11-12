import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
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
  waitUntil,
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
const run = promisify(execFile)

vi.setConfig({ testTimeout: 90_000 })

let home: string
let app: ElectronApplication | undefined

beforeAll(async () => {
  await buildRenderer()
})

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-app-changes-'))
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

async function client(): Promise<DaemonClient> {
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  return appClient(info, process.env.TED_APP_TOKEN)
}

async function git(cwd: string, ...args: string[]) {
  await run('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  })
}

async function write(worktree: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(worktree, name)), { recursive: true })
    await writeFile(path.join(worktree, name), text)
  }
}

async function openTaskWithChanges(): Promise<Page> {
  const parent = path.join(home, 'origin')
  const origin = await makeOriginRepo(parent)
  await commitToOrigin(parent, {
    '.gitignore': 'stub-*\n',
    'src/search/SearchPanel.tsx': ['one', 'two', 'three', 'four', 'five', ''].join('\n'),
  })
  const daemon = await daemonAsApp(home, env())
  await daemon.addFactory({ repo: origin, key: 'NB' })
  const task = await daemon.createTask({
    factory: 'NB',
    title: JSON.stringify({ steps: [{ endTurn: true }] }),
  })
  await daemon.startTask(task.id)
  const worktree = await waitUntil(
    async () => (await daemon.listTasks()).find((t) => t.id === task.id)?.repos[0]?.worktree,
    'the worktree',
  )
  await write(worktree, { 'src/search/SearchPanel.tsx': 'one\ntwo\nTHREE\nfour\nfive\n' })
  await git(worktree, 'commit', '-qam', 'guard')
  await write(worktree, {
    'src/search/useSearch.ts': 'export {}\n',
    'README.md': '# widgets\nmore\n',
  })

  app = await electron.launch({ executablePath: electronPath, args: [appDir], env: env() })
  const window = await loadedWindow(app)
  await window.emulateMedia({ colorScheme: null })
  await sidebar(window).getByRole('button', { name: 'All Tasks' }).click()
  await window.getByRole('row').filter({ hasText: 'NB-1' }).click()
  await window.getByRole('region', { name: 'Task thread' }).waitFor()
  return window
}

describe('Changes in Task details', () => {
  test('lists files by repo with totals; a file opens its diff, previous and next walk the list, and ← Task Lead returns', async () => {
    const window = await openTaskWithChanges()
    const changes = window
      .getByRole('complementary', { name: 'Task details' })
      .getByRole('region', { name: 'Changes' })
    await changes.getByRole('heading', { name: 'Changes · 3 files' }).waitFor()
    const repo = changes.getByRole('list', { name: 'widgets' })
    await changes.getByText('+3').first().waitFor()
    await expect
      .poll(() => repo.getByRole('button').allTextContents())
      .toEqual([
        'README.md+1Uncommitted',
        'SearchPanel.tsxsrc/search+1−1',
        'useSearch.tssrc/search+1Uncommitted',
      ])
    const thread = window.getByRole('region', { name: 'Task thread' })
    await thread.getByRole('textbox').first().fill('Half-written note')

    await repo.getByRole('button', { name: /^SearchPanel\.tsx/ }).click()
    const diff = window.getByRole('region', { name: 'Diff' })
    await diff.getByText('2 of 3').waitFor()
    await diff
      .getByText(
        'Local changes · Task branch against its merge-base with main, widgets’s base branch, including uncommitted work',
      )
      .waitFor()
    const removed = diff.getByRole('row', { name: /three/ })
    await expect.poll(() => removed.textContent()).toBe('3−three')
    const added = diff.getByRole('row', { name: /THREE/ })
    await expect.poll(() => added.textContent()).toBe('3+THREE')
    expect(await added.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
      await removed.evaluate((el) => getComputedStyle(el).backgroundColor),
    )

    await diff.getByRole('button', { name: 'Next file' }).click()
    await diff.getByText('3 of 3').waitFor()
    await diff.getByText('useSearch.ts', { exact: true }).waitFor()
    await expect(diff.getByRole('button', { name: 'Next file' }).isDisabled()).resolves.toBe(true)
    await diff.getByRole('button', { name: 'Previous file' }).click()
    await diff.getByRole('button', { name: 'Previous file' }).click()
    await diff.getByText('1 of 3').waitFor()

    await diff.getByRole('button', { name: '← Task Lead' }).click()
    await thread.waitFor()
    await diff.waitFor({ state: 'detached' })
    expect(await thread.getByRole('textbox').first().inputValue()).toBe('Half-written note')

    {
      const changes = window
        .getByRole('complementary', { name: 'Task details' })
        .getByRole('region', { name: 'Changes' })
      await changes.getByRole('button', { name: 'All changes' }).click()

      const all = window.getByRole('region', { name: 'All changes' })
      await window.getByRole('complementary', { name: 'Task details' }).waitFor()
      await expect
        .poll(() => all.getByRole('heading', { level: 3 }).allTextContents())
        .toEqual(['README.md', 'src/search/SearchPanel.tsx', 'src/search/useSearch.ts'])
      await all.getByRole('row', { name: /THREE/ }).waitFor()
      expect(await all.getByRole('navigation', { name: 'Changed files' }).count()).toBe(0)

      await all.getByRole('button', { name: 'Collapse' }).click()
      await window.getByRole('region', { name: 'Task thread' }).waitFor()
      await window.getByRole('complementary', { name: 'Task details' }).waitFor()
    }
  })

  test('new uncommitted work shows up when the window is focused again', async () => {
    const window = await openTaskWithChanges()
    const changes = window
      .getByRole('complementary', { name: 'Task details' })
      .getByRole('region', { name: 'Changes' })
    await changes.getByRole('heading', { name: 'Changes · 3 files' }).waitFor()
    const [task] = await (await client()).listTasks()
    await write(task?.repos[0]?.worktree ?? '', { 'extra.txt': 'x\n' })

    await window.evaluate(() => globalThis.dispatchEvent(new Event('focus')))

    await changes.getByRole('heading', { name: 'Changes · 4 files' }).waitFor()
  })

  test('a committed change undone in the working tree remains readable as local committed work', async () => {
    const window = await openTaskWithChanges()
    const changes = window
      .getByRole('complementary', { name: 'Task details' })
      .getByRole('region', { name: 'Changes' })
    await changes.getByRole('heading', { name: 'Changes · 3 files' }).waitFor()
    const [task] = await (await client()).listTasks()
    await write(task?.repos[0]?.worktree ?? '', {
      'src/search/SearchPanel.tsx': ['one', 'two', 'three', 'four', 'five', ''].join('\n'),
    })
    await window.evaluate(() => globalThis.dispatchEvent(new Event('focus')))
    await changes.getByText('undone').waitFor()

    await changes.getByRole('button', { name: /^SearchPanel\.tsx/ }).click()
    const diff = window.getByRole('region', { name: 'Diff' })
    const committedOnly = diff.getByRole('button', { name: 'Committed only' })
    await expect.poll(() => committedOnly.getAttribute('aria-pressed')).toBe('true')
    await diff.getByRole('row', { name: /THREE/ }).waitFor()
    await diff.getByRole('button', { name: 'With uncommitted work' }).click()
    await diff.getByText('No line changes.').waitFor()
  })
})
