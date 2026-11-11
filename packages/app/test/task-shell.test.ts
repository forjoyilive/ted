import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { readDaemonInfo } from '@ted/protocol'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  appClient,
  daemonAsApp,
  makeOriginRepo,
  removeHome,
  stopDaemonIn,
  waitUntil,
} from '../../daemon/test/helpers.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'
import { loadedWindow } from './first-window.ts'

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
  await buildRenderer()
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
  const window = await loadedWindow(app)
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

    await shell.getByRole('button', { name: 'Find', exact: true }).click()
    await shell.getByRole('textbox', { name: 'Find', exact: true }).fill('task=NB-1 sum=42')
    await shell.getByText('1 of 1', { exact: true }).waitFor()
    await shell.getByRole('button', { name: 'Restart shell' }).click()
    await window
      .getByRole('dialog', { name: 'Restart Shell 1?' })
      .getByRole('button', { name: 'Restart shell' })
      .click()
    await waitUntil(
      async () => (await shell.getByText('task=NB-1 sum=42').count()) === 0 || undefined,
      'the restarted shell to start empty',
    )
    await expect.poll(() => shell.getByRole('search', { name: 'Find in shell' }).count()).toBe(0)
    await typeInShell(window, 'printf "fresh-%s\\n" "needle"')
    await shell.getByText('fresh-needle', { exact: true }).waitFor()
    await shell.getByRole('button', { name: 'Find', exact: true }).click()
    await shell.getByRole('textbox', { name: 'Find', exact: true }).fill('fresh-needle')
    await shell.getByText('1 of 1', { exact: true }).waitFor()
  })

  test('nested panes keep their shells and layout across navigation and reload', async () => {
    await startedTask()
    const window = await launchApp()
    await app?.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1440, 1000),
    )
    const code = await openTask(window)
    await code.getByRole('button', { name: 'Shell' }).click()
    const shell = window.getByRole('region', { name: 'Shell', exact: true })
    const first = shell.getByRole('region', { name: 'Shell 1', exact: true })
    await first.locator('.xterm-helper-textarea').focus()
    await window.keyboard.type('MARK=kept; echo "first=$MARK"')
    await window.keyboard.press('Enter')
    await first.getByText('first=kept', { exact: true }).waitFor()
    await first.getByRole('button', { name: 'Split right', exact: true }).click()
    const second = shell.getByRole('region', { name: 'Shell 2', exact: true })
    await second.locator('.xterm-helper-textarea').focus()
    await window.keyboard.type('echo "second=$MARK"')
    await window.keyboard.press('Enter')
    await second.getByText('second=', { exact: true }).waitFor()
    expect(await second.getByText('first=kept', { exact: true }).count()).toBe(0)
    await second.getByRole('button', { name: 'Split below', exact: true }).click()
    const third = shell.getByRole('region', { name: 'Shell 3', exact: true })
    await third.locator('.xterm-helper-textarea').waitFor()
    const divider = shell.getByRole('separator').first()
    await divider.focus()
    await divider.press('ArrowRight')
    await expect.poll(() => divider.getAttribute('aria-valuenow')).toBe('55')
    await first.getByRole('button', { name: 'Find', exact: true }).click()
    await first
      .getByRole('search', { name: 'Find in shell' })
      .getByRole('textbox', { name: 'Find', exact: true })
      .fill('first=kept')
    expect(await second.getByRole('search').count()).toBe(0)
    await first.getByRole('button', { name: 'Close find' }).click()
    if (process.env.TED_SHELL_SCREENSHOT) {
      for (const mode of ['light', 'dark'] as const) {
        await app?.evaluate(({ nativeTheme }, theme) => {
          nativeTheme.themeSource = theme
        }, mode)
        await window.emulateMedia({ colorScheme: mode })
        await window.evaluate((theme) => {
          document.documentElement.style.colorScheme = theme
        }, mode)
        await expect
          .poll(() => shell.evaluate((element) => getComputedStyle(element).backgroundColor))
          .toBe(mode === 'dark' ? 'rgb(28, 28, 27)' : 'rgb(255, 255, 255)')
        await window.screenshot({ path: `${process.env.TED_SHELL_SCREENSHOT}-${mode}.png` })
      }
      await app?.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.setSize(900, 760),
      )
      await window.screenshot({ path: `${process.env.TED_SHELL_SCREENSHOT}-narrow.png` })
    }
    await shell.getByRole('button', { name: '← Thread' }).click()
    const again = window
      .getByRole('complementary', { name: 'Task details' })
      .getByRole('region', { name: 'Code' })
    await again.getByRole('button', { name: 'Shell' }).click()
    await third.locator('.xterm-helper-textarea').waitFor()
    await window.reload()
    const reopened = await openTask(window)
    await reopened.getByRole('button', { name: 'Shell' }).click()
    await first.getByText('first=kept', { exact: true }).waitFor()
    await third.locator('.xterm-helper-textarea').waitFor()
    await expect
      .poll(() => shell.getByRole('separator').first().getAttribute('aria-valuenow'))
      .toBe('55')
    await second.getByRole('button', { name: 'Restart shell', exact: true }).click()
    expect(await window.getByRole('dialog', { name: 'Restart Shell 2?' }).textContent()).toContain(
      'Programs that detached into separate sessions may keep running.',
    )
    await window
      .getByRole('dialog', { name: 'Restart Shell 2?' })
      .getByRole('button', { name: 'Restart shell', exact: true })
      .click()
    await expect.poll(() => second.getByText('second=', { exact: true }).count()).toBe(0)
    await first.locator('.xterm-helper-textarea').focus()
    await window.keyboard.type('echo "still=$MARK"')
    await window.keyboard.press('Enter')
    await first.getByText('still=kept', { exact: true }).waitFor()
  })

  test('layout changes retain terminal and Find state without stealing control focus; closing a pane confirms, keeps the other alive, and closing all stays empty', async () => {
    await startedTask()
    const window = await launchApp()
    await app?.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1440, 1000),
    )
    const code = await openTask(window)
    await code.getByRole('button', { name: 'Shell' }).click()
    const shell = window.getByRole('region', { name: 'Shell', exact: true })
    const first = shell.getByRole('region', { name: 'Shell 1', exact: true })
    const terminal = await first.locator('.xterm-helper-textarea').elementHandle()
    if (!terminal) throw new Error('no terminal')
    await first.getByRole('button', { name: 'Find', exact: true }).click()
    const find = first.getByRole('textbox', { name: 'Find', exact: true })
    await find.fill('kept')
    await first.getByRole('button', { name: 'Split right', exact: true }).click()
    const second = shell.getByRole('region', { name: 'Shell 2', exact: true })
    await second.locator('.xterm-helper-textarea').waitFor()
    expect(await terminal.evaluate((element) => element.isConnected)).toBe(true)
    expect(await find.inputValue()).toBe('kept')
    const secondTerminal = await second.locator('.xterm-helper-textarea').elementHandle()
    if (!secondTerminal) throw new Error('no second terminal')
    await second.getByRole('button', { name: 'Split below', exact: true }).click()
    const third = shell.getByRole('region', { name: 'Shell 3', exact: true })
    await third.locator('.xterm-helper-textarea').waitFor()
    expect(await secondTerminal.evaluate((element) => element.isConnected)).toBe(true)
    await find.click()
    await window.keyboard.type('needle')
    expect(await find.inputValue()).toBe('keptneedle')
    expect(await find.evaluate((element) => element === document.activeElement)).toBe(true)
    await third.locator('.xterm-helper-textarea').focus()
    const split = first.getByRole('button', { name: 'Split right', exact: true })
    await split.focus()
    await window.keyboard.press('Enter')
    await shell
      .getByRole('region', { name: 'Shell 4', exact: true })
      .locator('.xterm-helper-textarea')
      .waitFor()
    expect(await terminal.evaluate((element) => element.isConnected)).toBe(true)
    for (const number of [4, 3]) {
      await shell.getByRole('button', { name: `Close Shell ${number}`, exact: true }).click()
      await window
        .getByRole('dialog', { name: `Close Shell ${number}?` })
        .getByRole('button', { name: 'Close shell', exact: true })
        .click()
      await expect
        .poll(() => shell.getByRole('region', { name: `Shell ${number}`, exact: true }).count())
        .toBe(0)
    }
    expect(await secondTerminal.evaluate((element) => element.isConnected)).toBe(true)
    await expect
      .poll(() => secondTerminal.evaluate((element) => element === document.activeElement))
      .toBe(true)
    expect(await find.inputValue()).toBe('keptneedle')
    expect(await terminal.evaluate((element) => element.isConnected)).toBe(true)

    await shell.getByRole('button', { name: 'Close Shell 2', exact: true }).click()
    await window
      .getByRole('dialog', { name: 'Close Shell 2?' })
      .getByRole('button', { name: 'Close shell', exact: true })
      .click()
    await expect
      .poll(() => shell.getByRole('region', { name: 'Shell 2', exact: true }).count())
      .toBe(0)
    await first.getByRole('button', { name: 'Split below' }).click()
    await shell.getByRole('button', { name: 'Close Shell 2', exact: true }).click()
    expect(await window.getByRole('dialog', { name: 'Close Shell 2?' }).textContent()).toContain(
      'Programs that detached into separate sessions may keep running.',
    )
    await window
      .getByRole('dialog', { name: 'Close Shell 2?' })
      .getByRole('button', { name: 'Cancel' })
      .click()
    await shell
      .getByRole('region', { name: 'Shell 2', exact: true })
      .locator('.xterm-helper-textarea')
      .waitFor()
    await shell.getByRole('button', { name: 'Close Shell 2', exact: true }).click()
    await window
      .getByRole('dialog', { name: 'Close Shell 2?' })
      .getByRole('button', { name: 'Close shell', exact: true })
      .click()
    await expect
      .poll(() => shell.getByRole('region', { name: 'Shell 2', exact: true }).count())
      .toBe(0)
    await typeInShell(window, 'echo alive')
    await first.getByText('alive', { exact: true }).waitFor()
    await shell.getByRole('button', { name: 'Close Shell 1', exact: true }).click()
    await window
      .getByRole('dialog', { name: 'Close Shell 1?' })
      .getByRole('button', { name: 'Close shell', exact: true })
      .click()
    await shell.getByRole('button', { name: 'Open Shell', exact: true }).waitFor()
    await shell.getByRole('button', { name: '← Thread' }).click()
    await window
      .getByRole('complementary', { name: 'Task details' })
      .getByRole('region', { name: 'Code' })
      .getByRole('button', { name: 'Shell', exact: true })
      .click()
    await shell.getByRole('button', { name: 'Open Shell', exact: true }).click()
    await first.locator('.xterm-helper-textarea').waitFor()
    expect(await first.getByText('alive', { exact: true }).count()).toBe(0)
  })

  test('Find stays usable inside minimum-width panes on either side in both themes', async () => {
    await startedTask()
    const window = await launchApp()
    await app?.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1440, 1000),
    )
    const code = await openTask(window)
    await code.getByRole('button', { name: 'Shell' }).click()
    const shell = window.getByRole('region', { name: 'Shell', exact: true })
    const first = shell.getByRole('region', { name: 'Shell 1', exact: true })
    await first.getByRole('button', { name: 'Split right', exact: true }).click()
    const second = shell.getByRole('region', { name: 'Shell 2', exact: true })
    for (const pane of [first, second]) {
      await pane.locator('.xterm-helper-textarea').focus()
      await window.keyboard.type('printf "needle-%s\\nneedle-%s\\n" 42 42')
      await window.keyboard.press('Enter')
      await expect.poll(() => pane.getByText('needle-42', { exact: true }).count()).toBe(2)
    }
    const divider = shell.getByRole('separator')
    for (const [pane, target, key] of [
      [first, 10, 'ArrowLeft'],
      [second, 90, 'ArrowRight'],
    ] as const) {
      await divider.focus()
      let ratio = Number(await divider.getAttribute('aria-valuenow'))
      while (ratio !== target) {
        await divider.press(key)
        ratio += key === 'ArrowLeft' ? -5 : 5
        await expect.poll(() => divider.getAttribute('aria-valuenow')).toBe(String(ratio))
        await expect.poll(() => divider.getAttribute('tabindex')).toBe('0')
      }
      const bounds = await pane.boundingBox()
      if (!bounds) throw new Error('no pane bounds')
      expect(bounds.width).toBeCloseTo(220, 0)
      for (const mode of ['light', 'dark'] as const) {
        await app?.evaluate(({ nativeTheme }, theme) => {
          nativeTheme.themeSource = theme
        }, mode)
        await window.emulateMedia({ colorScheme: mode })
        await window.evaluate((theme) => {
          document.documentElement.style.colorScheme = theme
        }, mode)
        await pane.getByRole('button', { name: 'Find', exact: true }).click()
        const find = pane.getByRole('search', { name: 'Find in shell' })
        const input = find.getByRole('textbox', { name: 'Find', exact: true })
        await input.fill('needle-42')
        const count = find.locator('[aria-live="polite"]')
        await expect.poll(() => count.textContent()).toMatch(/^[12] of 2$/)
        const before = await count.textContent()
        await find.getByRole('button', { name: 'Next match' }).click()
        await expect.poll(() => count.textContent()).not.toBe(before)
        await find.getByRole('button', { name: 'Previous match' }).click()
        await expect.poll(() => count.textContent()).toBe(before)
        expect(await input.inputValue()).toBe('needle-42')
        for (const control of [find, input, count, ...(await find.getByRole('button').all())]) {
          const box = await control.boundingBox()
          if (!box) throw new Error('no Find control bounds')
          expect(box.x).toBeGreaterThanOrEqual(bounds.x)
          expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width)
          expect(box.y).toBeGreaterThanOrEqual(bounds.y)
          expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height)
        }
        await find.getByRole('button', { name: 'Close find' }).click()
        await expect.poll(() => pane.getByRole('search').count()).toBe(0)
      }
    }
  })

  test('the first Open in editor asks which editor, later ones open straight away, and Open in editor in a diff opens the file at its first changed line', async () => {
    const worktree = await startedTask()
    await writeFile(path.join(worktree, 'README.md'), '# widgets\nsecond line\n')
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

    const changes = window
      .getByRole('complementary', { name: 'Task details' })
      .getByRole('region', { name: 'Changes' })
    await changes.getByRole('button', { name: /^README\.md/ }).click()
    const diff = window.getByRole('region', { name: 'Diff' })
    await diff.getByRole('row', { name: /second line/ }).waitFor()
    await diff.getByRole('button', { name: /Open in editor/ }).click()

    const line = await waitUntil(async () => {
      const text = await readFile(editorLog(), 'utf8').catch(() => '')
      return text.split('\n').filter((l) => l !== '')[2]
    }, 'VS Code to open the file')
    expect(line).toBe(`code [${worktree}] [--goto] [${worktree}/README.md:2:1]`)

    await window
      .getByRole('complementary', { name: 'Task details' })
      .getByRole('region', { name: 'Code' })
      .getByRole('button', { name: 'Shell' })
      .click()
    await window
      .getByRole('region', { name: 'Shell' })
      .getByText(worktree, { exact: true })
      .waitFor()
    await diff.waitFor({ state: 'detached' })

    await window
      .getByRole('navigation', { name: 'Sidebar' })
      .getByRole('button', { name: /^Settings/ })
      .last()
      .click()
    const row = window.getByRole('group', { name: 'Editor and command line' })
    await row.getByLabel('Editor', { exact: true }).waitFor()
    await row.getByRole('status', { name: 'Finding editors…' }).waitFor({ state: 'detached' })
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
