import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { afterEach, beforeAll, beforeEach, describe, test, vi } from 'vitest'
import {
  commitToOrigin,
  daemonAsApp,
  makeOriginRepo,
  removeHome,
  stopDaemonIn,
  waitUntil,
} from '../../daemon/test/helpers.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'
import { firstWindow } from './first-window.ts'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const electronPath = createRequire(import.meta.url)('electron') as string
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
  home = await mkdtemp(path.join(tmpdir(), 'ted-app-line-comments-'))
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
  const window = await firstWindow(app)
  await window.emulateMedia({ colorScheme: null })
  await sidebar(window).waitFor()
  await sidebar(window).getByRole('button', { name: 'All Tasks' }).click()
  await window.getByRole('row').filter({ hasText: 'NB-1' }).click()
  await window.getByRole('region', { name: 'Task thread' }).waitFor()
  return window
}

describe('Line comments', () => {
  test('a draft from the gutter shows inline, counts in Changes, and Send to Task Lead posts it to the thread', async () => {
    const window = await openTaskWithChanges()
    const details = window.getByRole('complementary', { name: 'Task details' })
    const changes = details.getByRole('region', { name: 'Changes' })
    await changes.getByRole('button', { name: /^SearchPanel\.tsx/ }).click()
    const diff = window.getByRole('region', { name: 'Diff' })
    const added = diff.getByRole('row', { name: /THREE/ })
    await added.hover()
    await added.getByRole('button', { name: 'Comment on line 3' }).click()
    await diff.getByRole('textbox', { name: 'Line comment' }).fill('Keep it lower case.')
    await diff.getByText('Line 3', { exact: true }).waitFor()
    await diff.getByRole('button', { name: 'Add comment' }).click()

    const card = diff.getByRole('article', { name: 'Line comment on line 3' })
    const profile = await (await daemonAsApp(home, env())).getProfile()
    await card.getByText(profile.name, { exact: true }).waitFor()
    await card.getByText('· draft · line 3').waitFor()
    await card.getByText('Keep it lower case.').waitFor()
    await changes.getByRole('heading', { name: 'Changes · 3 files · 1 draft' }).waitFor()
    const bar = diff.getByRole('region', { name: 'Draft line comments' })
    await bar.getByText('1 draft comment on 1 file').waitFor()

    await card.getByRole('button', { name: 'Edit' }).click()
    await diff.getByRole('textbox', { name: 'Line comment' }).fill('Keep it lower case, please.')
    await diff.getByRole('button', { name: 'Save' }).click()
    await card.getByText('Keep it lower case, please.').waitFor()

    const two = diff.getByRole('row', { name: /two/ })
    await two.hover()
    await two.getByRole('button', { name: 'Comment on line 2' }).hover()
    await window.mouse.down()
    await diff.getByRole('row', { name: /four/ }).hover()
    await window.mouse.up()
    await diff.getByText('Lines 2–4', { exact: true }).waitFor()
    await diff.getByRole('button', { name: 'Cancel' }).click()
    await diff.getByRole('textbox', { name: 'Line comment' }).waitFor({ state: 'detached' })

    await diff.getByRole('button', { name: '← Thread' }).click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    await thread.getByRole('button', { name: '1 unsent line comment' }).click()
    await thread.getByRole('button', { name: 'src/search/SearchPanel.tsx · line 3' }).click()
    await diff.getByRole('region', { name: 'Draft line comments' }).waitFor()

    await bar.getByRole('button', { name: 'Send to Task Lead' }).click()
    await bar.waitFor({ state: 'detached' })
    await card.getByText('· sent · line 3').waitFor()
    await diff.getByRole('button', { name: '← Thread' }).click()
    await thread
      .getByRole('button', { name: '1 unsent line comment' })
      .waitFor({ state: 'detached' })
    await thread.getByRole('button', { name: '▸ 1 line comment' }).click()
    await thread.getByText('Keep it lower case, please.').waitFor()
    await thread.getByRole('button', { name: 'src/search/SearchPanel.tsx · line 3' }).click()
    await diff.getByRole('row', { name: /THREE/ }).waitFor()
  })
})
