import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { readDaemonInfo } from '@ted/protocol'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { build } from 'vite'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  appClient,
  daemonAsApp,
  makeOriginRepo,
  removeHome,
  stopDaemonIn,
  waitUntil,
} from '../../daemon/test/helpers.ts'
import { closeApp } from './close-app.ts'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const cliPath = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url))
const stubClaudePath = fileURLToPath(
  new URL('../../daemon/test/fixtures/stub-claude.ts', import.meta.url),
)
const electronPath = createRequire(import.meta.url)('electron') as string
const run = promisify(execFile)

vi.setConfig({ testTimeout: 90_000 })

let home: string
let bin: string
let app: ElectronApplication | undefined

beforeAll(async () => {
  await build({ configFile: path.join(appDir, 'vite.config.ts'), logLevel: 'warn' })
})

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-app-'))
  bin = path.join(home, 'bin')
  await mkdir(bin)
  await writeFile(
    path.join(bin, 'code'),
    `#!/bin/sh\nline=code\nfor a in "$@"; do line="$line [$a]"; done\nprintf '%s\\n' "$line" >> '${editorLog()}'\n`,
    { mode: 0o755 },
  )
})

afterEach(async () => {
  await closeApp(app)
  app = undefined
  await stopDaemonIn(home)
  await removeHome(home)
}, 30_000)

const editorLog = () => path.join(home, 'editor.log')

const env = () => ({
  ...process.env,
  TED_HOME: home,
  TED_IDLE_EXIT_MS: '30000',
  TED_CLAUDE_BIN: stubClaudePath,
  TED_HIDDEN_WINDOW: '1',
  SHELL: '/bin/sh',
  ENV: '',
  PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
})

async function launchApp(): Promise<Page> {
  app = await electron.launch({ executablePath: electronPath, args: [appDir], env: env() })
  const window = await app.firstWindow()
  await window.getByRole('navigation', { name: 'Sidebar' }).waitFor()
  return window
}

function ted(...args: string[]) {
  return run(process.execPath, [cliPath, ...args], { env: env() })
}

async function startedTask(): Promise<string> {
  const origin = await makeOriginRepo(path.join(home, 'origin'))
  const asApp = await daemonAsApp(home, env())
  await asApp.addFactory({ repo: origin, key: 'NB' })
  await ted('task', 'create', '--factory', 'NB', JSON.stringify({ steps: [{ endTurn: true }] }))
  await ted('task', 'start', 'NB-1')
  const worktree = path.join(home, 'worktrees', 'NB-1', 'widgets')
  await waitUntil(async () => {
    const info = await readDaemonInfo(home)
    if (!info) return undefined
    const tasks = await appClient(info, process.env.TED_APP_TOKEN).listTasks()
    return tasks[0]?.repos.some((r) => r.worktree === worktree && !r.removed) || undefined
  }, 'NB-1 to have a worktree')
  return worktree
}

async function openTask(window: Page) {
  await window
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('button', { name: 'All Tasks' })
    .click()
  await window.getByRole('row').filter({ hasText: 'NB-1' }).click()
  return window
    .getByRole('complementary', { name: 'Task details' })
    .getByRole('region', { name: 'Code' })
}

async function typeInShell(window: Page, text: string) {
  await window.getByRole('region', { name: 'Shell' }).locator('.xterm-helper-textarea').focus()
  await window.keyboard.type(text)
  await window.keyboard.press('Enter')
}

describe('Task shell', () => {
  test('Shell opens the login shell in the worktree, keeps it across a reload, and ⌃` brings it back', async () => {
    const worktree = await startedTask()
    const window = await launchApp()
    const code = await openTask(window)

    await code.getByRole('button', { name: 'Shell' }).click()

    const shell = window.getByRole('region', { name: 'Shell' })
    await shell.getByText(worktree, { exact: true }).waitFor()
    await typeInShell(window, 'echo "task=$TED_TASK sum=$((40 + 2))"')
    await shell.getByText('task=NB-1 sum=42').waitFor()

    await window.reload()
    const again = await openTask(window)
    await again.getByRole('button', { name: 'Shell' }).click()
    await shell.getByText('task=NB-1 sum=42').waitFor()

    await shell.getByRole('button', { name: '← Thread' }).click()
    await shell.waitFor({ state: 'detached' })
    await window.getByRole('region', { name: 'Task thread' }).click({ position: { x: 5, y: 5 } })
    await window.keyboard.press('Control+Backquote')
    await shell.getByText('task=NB-1 sum=42').waitFor()

    await shell.getByRole('button', { name: 'Restart shell' }).click()
    await waitUntil(
      async () => (await shell.getByText('task=NB-1 sum=42').count()) === 0 || undefined,
      'the restarted shell to start empty',
    )
  })

  test('the first Open in editor asks which editor, and later ones open straight away', async () => {
    const worktree = await startedTask()
    const window = await launchApp()
    const code = await openTask(window)

    await code.getByRole('button', { name: 'Open in editor' }).click()
    const picker = window.getByRole('dialog', { name: 'Choose an editor' })
    await picker.getByRole('radio', { name: 'VS Code' }).check()
    await picker.getByRole('button', { name: 'Open' }).click()
    await picker.waitFor({ state: 'detached' })
    await code.getByRole('button', { name: 'Open in editor' }).click()

    const lines = await waitUntil(async () => {
      const text = await readFile(editorLog(), 'utf8').catch(() => '')
      const found = text.split('\n').filter((l) => l !== '')
      return found.length >= 2 ? found : undefined
    }, 'VS Code to open twice')
    expect(lines).toEqual([`code [${worktree}]`, `code [${worktree}]`])
    expect(await picker.count()).toBe(0)

    await window
      .getByRole('navigation', { name: 'Sidebar' })
      .getByRole('button', { name: /^Settings/ })
      .last()
      .click()
    const row = window.getByRole('group', { name: 'Editor and command line' })
    expect(await row.getByLabel('Editor').inputValue()).toBe('code')
    await row.getByLabel('Editor').selectOption('custom')
    await row.getByLabel('Custom command').fill('my-editor --line {line} {path}')
    await row.getByLabel('Custom command').press('Enter')
    await waitUntil(async () => {
      const info = await readDaemonInfo(home)
      if (!info) return undefined
      const settings = await appClient(info, process.env.TED_APP_TOKEN).getSettings()
      return settings.editorCommand === 'my-editor --line {line} {path}' || undefined
    }, 'the custom command to be saved')
  })
})
