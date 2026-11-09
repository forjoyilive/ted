import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DaemonClient, readDaemonInfo } from '@ted/protocol'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { build } from 'vite'
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  commitToOrigin,
  hostRecords,
  killRunHosts,
  makeOriginRepo,
} from '../../daemon/test/helpers.ts'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const cliPath = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url))
const stubClaudePath = fileURLToPath(
  new URL('../../daemon/test/fixtures/stub-claude.ts', import.meta.url),
)
const electronPath = createRequire(import.meta.url)('electron') as string
const run = promisify(execFile)

let home: string
let app: ElectronApplication | undefined
let extraEnv: Record<string, string> = {}

beforeAll(async () => {
  await build({ configFile: path.join(appDir, 'vite.config.ts'), logLevel: 'warn' })
})

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-app-'))
  extraEnv = {}
})

afterEach(async () => {
  await app?.close()
  app = undefined
  const info = await readDaemonInfo(home)
  if (info && isAlive(info.pid)) {
    process.kill(info.pid, 'SIGTERM')
    await waitForExit(info.pid)
  }
  await killRunHosts(home)
  await rm(home, { recursive: true, force: true })
}, 30_000)

const env = () => ({
  ...process.env,
  TED_HOME: home,
  TED_IDLE_EXIT_MS: '30000',
  TED_CLAUDE_BIN: stubClaudePath,
  TED_HIDDEN_WINDOW: '1',
  ...extraEnv,
})

async function launchApp(extraEnv: Record<string, string> = {}): Promise<Page> {
  app = await electron.launch({
    executablePath: electronPath,
    args: [appDir],
    env: { ...env(), ...extraEnv },
  })
  const window = await app.firstWindow()
  await window.emulateMedia({ colorScheme: null })
  await sidebar(window).waitFor()
  return window
}

const sidebar = (window: Page) => window.getByRole('navigation', { name: 'Sidebar' })
const settingsNav = (window: Page) => window.getByRole('navigation', { name: 'Settings' })

async function openSettings(window: Page): Promise<void> {
  await sidebar(window)
    .getByRole('button', { name: /^Settings/ })
    .last()
    .click()
  await settingsNav(window).waitFor()
}

const onePixelPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='

async function openAllTasks(window: Page): Promise<void> {
  await sidebar(window).getByRole('button', { name: 'All Tasks' }).click()
}

const taskRow = (window: Page, text: string) => window.getByRole('button').filter({ hasText: text })

async function daemonClient(): Promise<DaemonClient> {
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  return new DaemonClient(info)
}

const background = (window: Page) =>
  window.evaluate(() => getComputedStyle(document.body).backgroundColor)

const lightApp = 'rgb(250, 250, 248)'
const darkApp = 'rgb(22, 22, 21)'

function ted(...args: string[]) {
  return run(process.execPath, [cliPath, ...args], { env: env() })
}

async function daemonPid(): Promise<number> {
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  return info.pid
}

async function commandOf(pid: number): Promise<string> {
  const { stdout } = await run('ps', ['-o', 'command=', '-p', String(pid)])
  return stdout.trim()
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000
  while (isAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`pid ${pid} still running`)
    await sleep(50)
  }
}

describe('TED app', () => {
  test('launching the app starts the daemon through Electron when none is running', async () => {
    await launchApp()

    expect(await commandOf(await daemonPid())).toContain(electronPath)
  })

  test('a Task created from the CLI appears in the window within a second', async () => {
    const window = await launchApp()
    await openAllTasks(window)
    await window.getByText('No Tasks yet.').waitFor()

    await ted('task', 'create', 'Fix login')

    await taskRow(window, 'DEV-1').filter({ hasText: 'Fix login' }).waitFor({ timeout: 1_000 })
  })

  test('a Task Lead’s Comment and the move to Done show in the window as they happen', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await commitToOrigin(path.join(home, 'origin'), {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
    const steps = JSON.stringify({
      steps: [
        { run: ['ted', 'comment', 'Halfway there'] },
        { waitFor: path.join(home, 'go') },
        { everyMessage: [{ run: ['ted', 'outcome', 'advance'] }] },
        { run: ['ted', 'outcome', 'advance'] },
      ],
    })
    await ted('dev', 'factory', 'add', origin, '--key', 'NB')
    await ted('task', 'create', '--factory', 'NB', steps)
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByText('Backlog').waitFor()

    await ted('task', 'start', 'NB-1')

    await details.getByText('Intake', { exact: true }).waitFor()
    await window.getByRole('region', { name: 'Task thread' }).getByText('Halfway there').waitFor()
    await writeFile(path.join(home, 'go'), '')
    await details.getByText('Done', { exact: true }).waitFor()
  })

  test('the Task Lead field shows the agent, model and effort, and saves a change', async () => {
    await ted('task', 'create', 'Fix login')
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'DEV-1').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await expect.poll(() => details.getByLabel('Agent').inputValue()).toBe('claude')

    await details.getByLabel('Agent').selectOption('codex')
    await details.getByLabel('Model').fill('gpt-6-mini')
    await details.getByLabel('Effort').selectOption('low')
    await details.getByRole('button', { name: 'Save' }).click()

    await details.getByText('Codex · gpt-6-mini · low').waitFor()

    await ted('task', 'lead', 'DEV-1', 'claude', '--model', 'opus')
    await expect.poll(() => details.getByLabel('Model').inputValue()).toBe('opus')
    expect(await details.getByLabel('Agent').inputValue()).toBe('claude')
    expect(await details.getByLabel('Effort').inputValue()).toBe('')
  })

  test('a model the plan doesn’t include shows Model unavailable until the human picks the default', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await ted('dev', 'factory', 'add', origin, '--key', 'NB')
    await ted('task', 'create', '--factory', 'NB', JSON.stringify({ steps: [{ endTurn: true }] }))
    await ted('task', 'lead', 'NB-1', 'claude', '--model', 'unavailable-9')
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByText('Backlog').waitFor()

    await ted('task', 'start', 'NB-1')

    await details.getByText('Model unavailable').waitFor()
    await window
      .getByRole('region', { name: 'Task thread' })
      .getByText(/won’t switch models on its own/)
      .waitFor()
    await details.getByRole('button', { name: 'Use the default model' }).click()
    await details.getByText('Model unavailable').waitFor({ state: 'detached' })
  })

  test('the thread header shows the status, the live activity line and the Stage track', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    const go = (n: number) => path.join(home, `go-${n}`)
    const steps = JSON.stringify({
      steps: [
        { run: ['ted', 'comment', 'Read the brief'] },
        { run: ['ted', 'status', 'Running Checks · Tests (2 of 3)'] },
        { waitFor: go(1) },
        { hook: 'PermissionRequest' },
        { waitFor: go(2) },
        { run: ['ted', 'outcome', 'advance'] },
        { run: ['ted', 'comment', 'Asking the questions'] },
        { endTurn: true },
      ],
    })
    await ted('dev', 'factory', 'add', origin, '--key', 'NB')
    await ted('task', 'create', '--factory', 'NB', steps)
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    const header = thread.locator('header')
    await header.getByText('· Not started').waitFor()

    await ted('task', 'start', 'NB-1')

    await header.getByText('Working', { exact: true }).waitFor()
    await header.getByText('· Running Checks · Tests (2 of 3)').waitFor()
    await header.getByRole('img', { name: 'Claude Code, working' }).waitFor()
    await writeFile(go(1), '')
    await header.getByText('Waiting on you', { exact: true }).waitFor()
    await writeFile(go(2), '')
    await thread.getByText('Asking the questions', { exact: true }).waitFor()
    await header.getByText('Clarify', { exact: true }).waitFor()
    expect(await header.getByText('· Running Checks').count()).toBe(0)

    const intake = header.getByRole('button', { name: 'Intake, done' })
    await intake.click()
    expect(await intake.getAttribute('aria-pressed')).toBe('true')
    await thread.getByText('Asking the questions', { exact: true }).waitFor({ state: 'detached' })
    await thread.getByText('Read the brief', { exact: true }).waitFor()
    await header.getByRole('button', { name: 'Clarify, now' }).click()
    await thread.getByText('Read the brief', { exact: true }).waitFor({ state: 'detached' })
    await thread.getByText('Asking the questions', { exact: true }).waitFor()
    await header.getByRole('button', { name: 'Clarify, now' }).click()
    await thread.getByText('Read the brief', { exact: true }).waitFor()
    await thread.getByText('Asking the questions', { exact: true }).waitFor()
    expect(
      await header.getByRole('button', { name: 'Design, not yet' }).getAttribute('aria-pressed'),
    ).toBeNull()
  })

  test('Validate’s ✓ row shows each Check’s state, the Blocking findings box, and opens the output', async () => {
    const parent = path.join(home, 'origin')
    const origin = await makeOriginRepo(parent)
    const flag = path.join(home, 'failed-once')
    await commitToOrigin(parent, {
      '.gitignore': 'stub-*\n',
      '.ted/workflow.yaml': [
        'version: 1',
        'order: [intake, work, validate]',
        'stages:',
        '  validate:',
        '    checks:',
        '      - { name: Typecheck, run: "echo typed" }',
        `      - { name: Tests, run: "if [ -e '${flag}' ]; then echo ok; else touch '${flag}'; echo 'SearchPanel hangs'; exit 1; fi" }`,
        '      - { name: Lint, run: "echo linted" }',
        '',
      ].join('\n'),
    })
    const advance = { run: ['ted', 'outcome', 'advance'] }
    const steps = JSON.stringify({
      steps: [{ everyMessage: [{ run: ['sh', '-c', 'echo x > work.txt'] }, advance] }, advance],
    })
    await ted('dev', 'factory', 'add', origin, '--key', 'NB')
    await ted('task', 'create', '--factory', 'NB', steps)
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const thread = window.getByRole('region', { name: 'Task thread' })

    await ted('task', 'start', 'NB-1')

    const sentBack = thread.getByRole('listitem').filter({
      hasText: 'Validate sent this back to Work (round 1 of 5)',
    })
    await sentBack.waitFor({ timeout: 40_000 })
    const row = sentBack.getByRole('list', { name: 'Checks' })
    await row.getByRole('button', { name: '✓ Typecheck' }).waitFor()
    await row.getByRole('button', { name: '✗ Tests' }).waitFor()
    await row.getByRole('listitem').filter({ hasText: 'Lint · not run' }).waitFor()
    await sentBack
      .getByRole('region', { name: 'Blocking findings' })
      .getByText(/The Check “Tests”/)
      .waitFor()
    await thread.getByText('Checks passed at Validate').waitFor({ timeout: 40_000 })

    await row.getByRole('button', { name: '✗ Tests' }).click()
    const dialog = window.getByRole('dialog', { name: 'Tests output' })
    await dialog.getByText('SearchPanel hangs').waitFor()
    await dialog.getByRole('tab', { name: 'Typecheck' }).click()
    await window.getByRole('dialog', { name: 'Typecheck output' }).getByText('typed').waitFor()
    await window.getByRole('button', { name: 'Close' }).click()
    await dialog.waitFor({ state: 'detached' })
  }, 90_000)

  test('the Code section shows No worktree yet, then the branch and worktree path', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await ted('dev', 'factory', 'add', origin, '--key', 'NB')
    await ted('task', 'create', '--factory', 'NB', JSON.stringify({ steps: [{ endTurn: true }] }))
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const code = window
      .getByRole('complementary', { name: 'Task details' })
      .getByRole('region', { name: 'Code' })
    await code.getByText('No worktree yet').waitFor()

    await ted('task', 'start', 'NB-1')

    await code.getByText(/^ted\/nb-1/).waitFor()
    await code.getByText(path.join(home, 'worktrees', 'NB-1', 'widgets')).waitFor()
  })

  test('a missing local folder raises a Factory banner whose Locate picks a new folder', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    const folder = path.join(home, 'local')
    const moved = path.join(home, 'moved')
    await mkdir(folder)
    await ted('dev', 'factory', 'add', origin, '--key', 'NB', '--local-folder', folder)
    await rm(folder, { recursive: true })
    await mkdir(moved)

    const window = await launchApp()
    await pickFolderWith(moved)
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()

    const banners = window.getByRole('region', { name: 'widgets problems' })
    await banners.getByText('Local folder for widgets not found').waitFor()
    await banners.getByRole('button', { name: 'Locate' }).click()

    await window.getByText('Local folder for widgets not found').waitFor({ state: 'detached' })
    const [factory] = await (await daemonClient()).listFactories()
    expect(factory?.localFolder).toEqual({ path: moved, found: true })
  })

  test('quitting with nothing running ends the app and TED’s background process', async () => {
    await launchApp()
    const pid = await daemonPid()
    const electronPid = app?.process().pid ?? 0

    await app?.close()
    app = undefined

    await waitForExit(pid)
    expect(isAlive(electronPid)).toBe(false)
  })

  test('the app connects to a daemon that ted started instead of starting another', async () => {
    await ted('task', 'create', 'Fix login')
    const pid = await daemonPid()

    const window = await launchApp()

    await openAllTasks(window)
    await taskRow(window, 'DEV-1').waitFor()
    expect(await daemonPid()).toBe(pid)
  })

  test('the renderer has no Node, filesystem or store access, only the bridge', async () => {
    const window = await launchApp()

    const globals = await window.evaluate(() => ({
      require: typeof (globalThis as { require?: unknown }).require,
      process: typeof (globalThis as { process?: unknown }).process,
      bridge: Object.keys((globalThis as unknown as { ted: object }).ted).sort(),
    }))

    expect(globals).toEqual({
      require: 'undefined',
      process: 'undefined',
      bridge: ['onEvent', 'request'],
    })
  })

  test.runIf(process.platform === 'linux')(
    'the daemon the app starts shares no pipes or sockets with Electron',
    async () => {
      await launchApp()
      const electronPid = app?.process().pid
      if (electronPid === undefined) throw new Error('no Electron pid')

      const electron = new Set(await channelsOf(electronPid))
      const shared = (await channelsOf(await daemonPid())).filter((c) => electron.has(c))

      expect(shared).toEqual([])
    },
  )
})

describe('TED app frame', () => {
  test('the sidebar lists Factories; the current one opens its Board, List and other Views', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await ted('dev', 'factory', 'add', origin, '--key', 'NB')
    await ted('task', 'create', '--factory', 'NB', 'Offline editing')
    const window = await launchApp()
    const nav = sidebar(window)
    const factory = nav.getByRole('button', { name: 'widgets' })
    await factory.waitFor()
    expect(await factory.getAttribute('aria-expanded')).toBe('false')

    await factory.click()

    expect(await factory.getAttribute('aria-expanded')).toBe('true')
    const board = nav.getByRole('button', { name: 'Board', exact: true })
    expect(await board.getAttribute('aria-current')).toBe('page')
    await window.getByRole('region', { name: 'Backlog' }).getByText('Offline editing').waitFor()
    for (const view of ['List', 'Plans', 'Automations']) {
      await nav.getByRole('button', { name: view, exact: true }).waitFor()
    }

    await nav.getByRole('button', { name: 'All Tasks' }).click()
    expect(await factory.getAttribute('aria-expanded')).toBe('true')
  })

  test('a Factory added while the app is open appears in the sidebar', async () => {
    const window = await launchApp()
    const origin = await makeOriginRepo(path.join(home, 'origin'))

    await ted('dev', 'factory', 'add', origin, '--key', 'NB')

    await sidebar(window).getByRole('button', { name: 'widgets' }).waitFor()
  })

  test('opening a Task shows a back link to where it came from', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await ted('dev', 'factory', 'add', origin, '--key', 'NB')
    await ted('task', 'create', '--factory', 'NB', 'Offline editing')
    const window = await launchApp()
    const nav = sidebar(window)
    await nav.getByRole('button', { name: 'widgets' }).click()

    for (const [view, back] of [
      ['Board', '← Board'],
      ['List', '← List'],
      ['All Tasks', '← All Tasks'],
    ] as const) {
      await nav.getByRole('button', { name: view, exact: true }).click()
      await window.getByRole('main').getByText('Offline editing').click()
      await window.getByRole('heading', { name: 'Offline editing' }).waitFor()

      await window.getByRole('button', { name: back }).click()

      await window.getByRole('heading', { name: 'Offline editing' }).waitFor({ state: 'detached' })
    }
  })

  test('Blocked by in Task details adds and removes blockers, and refuses a cycle', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await ted('dev', 'factory', 'add', origin, '--key', 'NB')
    await ted('task', 'create', '--factory', 'NB', 'Crash when search is empty')
    await ted('task', 'create', '--factory', 'NB', 'Offline editing')
    const window = await launchApp()
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()
    await sidebar(window).getByRole('button', { name: 'List', exact: true }).click()
    await window.getByRole('main').getByText('Offline editing').click()
    const details = window.getByRole('complementary', { name: 'Task details' })

    await details.getByRole('button', { name: 'Add blocker' }).click()
    await details.getByLabel('Find a Task').fill('crash')
    await details.getByRole('option', { name: /NB-1/ }).click()

    await details.getByText('Crash when search is empty').waitFor()
    await window.getByRole('main').getByText('Blocked by').first().waitFor()
    await window.getByText('Starts when NB-1 merges').first().waitFor()

    await window.getByRole('button', { name: '← List' }).click()
    await window.getByRole('main').getByText('Crash when search is empty').click()
    await details.getByRole('button', { name: 'Add blocker' }).click()
    await details.getByLabel('Find a Task').fill('offline')
    await details.getByRole('option', { name: /NB-2/ }).click()
    await details
      .getByText('NB-2 can’t block NB-1: that makes a cycle, NB-1 → NB-2 → NB-1')
      .waitFor()

    await window.getByRole('button', { name: '← List' }).click()
    await window.getByRole('main').getByText('Offline editing').click()
    await details.getByRole('button', { name: 'Remove NB-1' }).click()
    await expect
      .poll(
        async () =>
          (await (await daemonClient()).listTasks()).find((t) => t.displayId === 'NB-2')?.blockedBy,
      )
      .toEqual([])
  })

  test('the theme follows the system appearance', async () => {
    const window = await launchApp()

    await window.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => background(window), { timeout: 5_000 }).toBe(darkApp)
    await window.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => background(window), { timeout: 5_000 }).toBe(lightApp)
  })

  test('the Appearance setting switches the theme at once, from the app or the daemon', async () => {
    const window = await launchApp()
    await openSettings(window)
    const appearance = window.getByRole('radiogroup', { name: 'Appearance' })

    await appearance.getByText('Dark').click()
    await expect.poll(() => background(window), { timeout: 5_000 }).toBe(darkApp)
    expect((await (await daemonClient()).getSettings()).appearance).toBe('dark')

    await (await daemonClient()).updateSettings({ appearance: 'light' })
    await expect.poll(() => background(window), { timeout: 5_000 }).toBe(lightApp)
    expect(await appearance.getByRole('radio', { name: 'Light' }).isChecked()).toBe(true)
  })

  test('the Appearance setting applies when the app starts', async () => {
    await ted('task', 'list')
    await (await daemonClient()).updateSettings({ appearance: 'dark' })

    const window = await launchApp()

    await expect.poll(() => background(window), { timeout: 5_000 }).toBe(darkApp)
  })

  test('a Help (?) shows its note in a tooltip on hover', async () => {
    const window = await launchApp()

    await window.getByRole('button', { name: 'Help' }).hover()

    await window
      .getByRole('tooltip')
      .getByText(/need your answer/)
      .waitFor()
  })

  test('fonts and styles load under the renderer’s content security policy', async () => {
    const violations: string[] = []
    app = await electron.launch({ executablePath: electronPath, args: [appDir], env: env() })
    const window = await app.firstWindow()
    window.on('console', (message) => {
      if (/Content Security Policy/i.test(message.text())) violations.push(message.text())
    })
    await sidebar(window).waitFor()

    const loaded = await window.evaluate(async () => {
      const faces = [
        ...(await document.fonts.load('14px "Geist Variable"')),
        ...(await document.fonts.load('12px "Geist Mono Variable"')),
      ]
      return faces.map((face) => `${face.family} ${face.status}`)
    })
    expect(loaded).toEqual(['Geist Variable loaded', 'Geist Mono Variable loaded'])
    expect(violations).toEqual([])
  })
})

describe('New Task dialog', () => {
  async function withFactory(): Promise<Page> {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await ted('dev', 'factory', 'add', origin, '--key', 'NB')
    const window = await launchApp()
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()
    return window
  }

  const dialog = (window: Page) => window.getByRole('dialog', { name: 'New Task' })

  const tasks = async () => (await daemonClient()).listTasks()

  const isFocused = (window: Page) =>
    dialog(window)
      .getByLabel('Description')
      .evaluate((el) => el === document.activeElement)

  test('⌘N and C open it with the current Factory selected and the description focused', async () => {
    const window = await withFactory()

    await window.keyboard.press('Meta+N')

    const open = dialog(window)
    await open.waitFor()
    const [factory] = await (await daemonClient()).listFactories()
    expect(await open.getByLabel('Factory').inputValue()).toBe(factory?.id)
    expect(await isFocused(window)).toBe(true)
    await window.keyboard.press('Escape')
    await open.waitFor({ state: 'detached' })

    await window.keyboard.press('c')
    await open.waitFor()
    expect(await open.getByLabel('Description').inputValue()).toBe('')
  })

  test('the sidebar + and the View header open it too', async () => {
    const window = await withFactory()

    await sidebar(window).getByRole('button', { name: 'New Task' }).click()
    await dialog(window).waitFor()
    await dialog(window).getByRole('button', { name: 'Close' }).click()
    await dialog(window).waitFor({ state: 'detached' })

    await window.getByRole('main').getByRole('button', { name: 'New Task' }).click()
    await dialog(window).waitFor()
  })

  test('Start now unchecked puts the Task in Backlog, titled from the description’s first line', async () => {
    const window = await withFactory()
    await window.keyboard.press('Meta+N')
    const open = dialog(window)

    await open.getByLabel('Description').fill('Search ignores accents\nTyping cafe finds Café.')
    await open.getByLabel('Priority').selectOption('high')
    await open.getByLabel('Start now').uncheck()
    await open.getByText('Waits in Backlog until you start it').waitFor()
    await window.keyboard.press('Meta+Enter')

    await open.waitFor({ state: 'detached' })
    await window
      .getByRole('region', { name: 'Backlog' })
      .getByText('Search ignores accents')
      .waitFor()
    expect(await tasks()).toMatchObject([
      {
        title: 'Search ignores accents',
        description: 'Search ignores accents\nTyping cafe finds Café.',
        priority: 'high',
        stage: 'backlog',
      },
    ])
  })

  test('Start now checked starts the Task at Intake', async () => {
    const window = await withFactory()
    await window.keyboard.press('Meta+N')
    const open = dialog(window)
    await open.getByText('Unchecked puts it in Backlog').waitFor()

    await open.getByLabel('Title').fill('Starts now')
    await open.getByLabel('Description').fill(JSON.stringify({ steps: [{ endTurn: true }] }))
    await open.getByRole('button', { name: 'Create', exact: true }).click()

    await window.getByRole('region', { name: 'Intake' }).getByText('Starts now').waitFor()
  })

  test('Create more keeps the dialog open and clears it', async () => {
    const window = await withFactory()
    await window.keyboard.press('Meta+N')
    const open = dialog(window)

    await open.getByLabel('Title').fill('First')
    await open.getByLabel('Description').fill('One')
    await open.getByLabel('Start now').uncheck()
    await open.getByRole('button', { name: 'Create more' }).click()

    await expect.poll(async () => (await tasks()).map((t) => t.title)).toEqual(['First'])
    expect(await open.isVisible()).toBe(true)
    await expect.poll(() => open.getByLabel('Title').inputValue()).toBe('')
    expect(await open.getByLabel('Description').inputValue()).toBe('')
    expect(await isFocused(window)).toBe(true)
  })

  test('attachments dropped or picked are stored and shown on the Task', async () => {
    const window = await withFactory()
    await window.keyboard.press('Meta+N')
    const open = dialog(window)

    const dropped = await window.evaluateHandle(() => {
      const data = new DataTransfer()
      data.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }))
      return data
    })
    await open
      .getByRole('button', { name: /Drop files here/ })
      .dispatchEvent('drop', { dataTransfer: dropped })
    await open.getByText('notes.txt').waitFor()
    await open.getByLabel('Attach files').setInputFiles({
      name: 'cafe.png',
      mimeType: 'image/png',
      buffer: Buffer.from('png'),
    })
    await open.getByText('cafe.png').waitFor()
    await open.getByLabel('Description').fill('With files')
    await open.getByLabel('Start now').uncheck()
    await open.getByRole('button', { name: 'Create', exact: true }).click()

    await window.getByRole('main').getByText('With files').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByText('notes.txt').waitFor()
    await details.getByText('cafe.png').waitFor()
    expect((await tasks())[0]?.attachments.map((a) => a.name)).toEqual(['notes.txt', 'cafe.png'])
  })

  test('a blocker from any Factory is stored and the footer says the Task waits for it', async () => {
    await ted('task', 'create', 'Crash when search is empty')
    const window = await withFactory()
    await window.keyboard.press('Meta+N')
    const open = dialog(window)

    await open.getByRole('button', { name: 'Add blocker' }).click()
    await open.getByLabel('Find a Task').fill('crash')
    await open.getByRole('option', { name: /DEV-1/ }).click()
    await open.getByText('Waits as Blocked until DEV-1 merges').waitFor()
    await open.getByLabel('Description').fill('After the crash fix')
    await open.getByRole('button', { name: 'Create', exact: true }).click()

    await open.waitFor({ state: 'detached' })
    const [blocker, task] = await tasks()
    expect(task).toMatchObject({ stage: 'backlog', blockedBy: [blocker?.id] })
  })

  test('More shows Clarify depth and the Task Lead from the Factory, and keeps changes', async () => {
    const window = await withFactory()
    await window.keyboard.press('Meta+N')
    const open = dialog(window)
    const more = open.getByRole('button', { name: /^More/ })
    await open.getByText('Clarify depth Auto · Task Lead Claude').waitFor()
    expect(await more.getAttribute('aria-expanded')).toBe('false')

    await more.click()
    await open.getByRole('radiogroup', { name: 'Clarify depth' }).getByText('Grill').click()
    await open.getByLabel('Agent').selectOption('codex')
    await open.getByLabel('Effort').selectOption('high')
    await more.click()
    await open.getByText('Clarify depth Grill · Task Lead Codex · high').waitFor()
    await open.getByLabel('Description').fill('Deep one')
    await open.getByLabel('Start now').uncheck()
    await open.getByRole('button', { name: 'Create', exact: true }).click()

    await open.waitFor({ state: 'detached' })
    expect((await tasks())[0]).toMatchObject({
      clarifyDepth: 'grilling',
      lead: { agent: 'codex', effort: 'high' },
    })
  })
})

describe('App Settings', () => {
  test('⌘, opens Settings over the whole window; Esc and ← Back return to where the human was', async () => {
    const window = await launchApp()
    await openAllTasks(window)
    await window.getByRole('heading', { name: 'All Tasks' }).waitFor()

    await window.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,')

    await settingsNav(window).waitFor()
    await window.getByRole('heading', { name: 'General', level: 1 }).waitFor()
    expect(await sidebar(window).count()).toBe(0)

    await window.keyboard.press('Escape')
    await window.getByRole('heading', { name: 'All Tasks' }).waitFor()
    expect(await settingsNav(window).count()).toBe(0)

    await openSettings(window)
    await settingsNav(window).getByRole('button', { name: /Back/ }).click()
    await window.getByRole('heading', { name: 'All Tasks' }).waitFor()
  })

  test('Settings lists the eight sections, then each Factory, which leaves for its settings page', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await ted('dev', 'factory', 'add', origin, '--key', 'NB')
    const window = await launchApp()
    await openSettings(window)
    const nav = settingsNav(window)

    const sections = [
      'General',
      'Notifications',
      'Agents',
      'Limits',
      'Integrations',
      'Library',
      'Storage',
      'Developer',
    ]
    for (const section of sections) {
      await nav.getByRole('button', { name: section, exact: true }).click()
      await window.getByRole('heading', { name: section, level: 1 }).waitFor()
      expect(
        await nav.getByRole('button', { name: section, exact: true }).getAttribute('aria-current'),
      ).toBe('page')
    }

    await nav.getByRole('button', { name: /widgets/ }).click()

    await window.getByRole('heading', { name: 'widgets · Factory settings' }).waitFor()
    expect(await settingsNav(window).count()).toBe(0)
  })

  test('the terminal font size saves on this machine and applies at once', async () => {
    const window = await launchApp()
    await openSettings(window)

    await window.getByRole('combobox', { name: 'Terminal font size' }).selectOption('16')

    await expect
      .poll(() =>
        window.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--terminal-font-size'),
        ),
      )
      .toBe('16px')
    expect((await (await daemonClient()).getSettings()).terminalFontSize).toBe(16)
  })

  test('the profile picture can be changed and removed; initials show without one', async () => {
    const picture = path.join(home, 'me.png')
    await writeFile(picture, Buffer.from(onePixelPng, 'base64'))
    const window = await launchApp()
    await app?.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, picture)
    await openSettings(window)
    const profile = window.getByRole('group', { name: 'Profile' })
    await profile.getByRole('img').and(profile.locator('span')).waitFor()

    await profile.getByRole('button', { name: 'Change…' }).click()

    await profile.locator('img').waitFor()
    await expect
      .poll(async () => (await (await daemonClient()).getSettings()).profilePicture)
      .toMatch(/^data:image\/png;base64,/)

    await profile.getByRole('button', { name: 'Remove' }).click()

    await profile.locator('img').waitFor({ state: 'detached' })
    expect((await (await daemonClient()).getSettings()).profilePicture).toBeNull()
  })

  test('run from source, the ted command row says only an installed copy can install it', async () => {
    const window = await launchApp()
    await openSettings(window)
    const commandLine = window.getByRole('group', { name: 'Command line' })

    await commandLine.getByText('Only an installed copy of TED can install it.').waitFor()
    expect(await commandLine.getByRole('button', { name: 'Install the ted command' }).count()).toBe(
      0,
    )
  })

  test('About shows the version, and Third-party licenses opens with agent-orchestrator’s NOTICE', async () => {
    const window = await launchApp()
    await openSettings(window)
    const about = window.getByRole('group', { name: 'About and updates' })
    await about.getByText(/^TED \d+\.\d+\.\d+$/).waitFor()

    await about.getByRole('button', { name: 'View' }).click()

    const licenses = window.getByRole('dialog', { name: 'Third-party licenses' })
    await licenses.getByText(/https:\/\/github\.com\/OrchestratorInc\/agent-orchestrator/).waitFor()
    await licenses.getByRole('button', { name: 'Close' }).click()
    await licenses.waitFor({ state: 'detached' })
  })

  test('Developer mode shows Diagnostics and the log viewer; off, they’re hidden', async () => {
    const window = await launchApp()
    await openSettings(window)
    await settingsNav(window).getByRole('button', { name: 'Developer', exact: true }).click()
    const diagnostics = window.getByRole('region', { name: 'Diagnostics' })
    const logs = window.getByRole('region', { name: 'Logs' })
    expect(await diagnostics.count()).toBe(0)
    expect(await logs.count()).toBe(0)

    await window.getByRole('switch', { name: 'Developer mode' }).click()

    await diagnostics.waitFor()
    await logs.waitFor()
    expect((await (await daemonClient()).getSettings()).developerMode).toBe(true)
    await logs.getByText(/TED daemon .* listening/).waitFor()

    await window.getByRole('switch', { name: 'Developer mode' }).click()
    await diagnostics.waitFor({ state: 'detached' })
    expect(await logs.count()).toBe(0)
  })

  test('the log viewer shows a Run’s raw output, and Diagnostics lists the Run', async () => {
    const window = await launchApp()
    const client = await daemonClient()
    await client.updateSettings({ developerMode: true })
    const run = await client.startDevRun({
      prompt: JSON.stringify({ steps: [{ say: 'from the stub' }, { endTurn: true }] }),
      cwd: home,
    })
    await openSettings(window)
    await settingsNav(window).getByRole('button', { name: 'Developer', exact: true }).click()

    await window
      .getByRole('region', { name: 'Diagnostics' })
      .getByRole('cell', { name: run.id.slice(0, 8), exact: true })
      .waitFor()
    const logs = window.getByRole('region', { name: 'Logs' })
    await logs.getByRole('combobox', { name: 'Log' }).selectOption(run.id)
    await logs.getByText(/from the stub/).waitFor()
  })

  test('Copy report puts the report on the clipboard, and Show in Finder opens TED’s folder', async () => {
    const window = await launchApp()
    await app?.evaluate(({ shell }) => {
      const opened: string[] = []
      Object.assign(globalThis, { opened })
      shell.openPath = async (folder: string) => {
        opened.push(folder)
        return ''
      }
    })
    await openSettings(window)
    await settingsNav(window).getByRole('button', { name: 'Developer', exact: true }).click()

    await window.getByRole('button', { name: 'Copy report' }).click()
    await window.getByText('Report copied.').waitFor()
    expect(await app?.evaluate(({ clipboard }) => clipboard.readText())).toMatch(/^TED \S+\n/)

    await window.getByRole('button', { name: /^Show in / }).click()
    await expect
      .poll(() => app?.evaluate(() => (globalThis as unknown as { opened: string[] }).opened))
      .toEqual([home])
  })
})

describe('Add Factory', () => {
  const dialog = (window: Page) => window.getByRole('dialog')

  async function openForm(window: Page) {
    await sidebar(window).getByRole('button', { name: 'Add Factory' }).click()
    await dialog(window).waitFor()
  }

  test('adding from owner/repo checks access, clones, and opens the new Board', async () => {
    await makeOriginRepo(path.join(home, 'origin'))
    await githubReady(['acme/widgets'])
    const window = await launchApp()
    await openForm(window)
    const form = dialog(window)
    await form.getByRole('heading', { name: 'Add your first Factory' }).waitFor()
    expect(await form.getByLabel('Show the tutorial').isChecked()).toBe(true)

    await form.getByLabel('GitHub URL or owner/repo').fill('acme/widgets')
    await form.getByLabel('GitHub URL or owner/repo').press('Enter')
    await form.getByText('Can push and open pull requests').waitFor()
    expect(await form.getByLabel('Name', { exact: true }).first().inputValue()).toBe('widgets')
    expect(await form.getByLabel('Key').inputValue()).toBe('WD')
    await form.getByText('TED clones the repo, then starts the setup Task WD-1.').waitFor()

    await form.getByRole('button', { name: 'Add Factory' }).click()
    await dialog(window).waitFor({ state: 'detached' })
    await sidebar(window).getByRole('button', { name: 'Widgets' }).waitFor()
    await window.getByRole('region', { name: 'Setting up Widgets' }).waitFor({ state: 'detached' })
    const [factory] = await (await daemonClient()).listFactories()
    expect(factory).toMatchObject({ key: 'WD', cloned: true, showTutorial: true })
  })

  test('access problems and a taken key show their messages and keep Add Factory disabled', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await githubReady(['acme/widgets'])
    await ted('dev', 'factory', 'add', origin, '--key', 'NB')
    const window = await launchApp()
    await openForm(window)
    const form = dialog(window)
    await form.getByRole('heading', { name: 'Add Factory' }).waitFor()

    await form.getByLabel('GitHub URL or owner/repo').fill('acme/nope')
    await form.getByLabel('GitHub URL or owner/repo').press('Enter')
    await form.getByText('Repository not found, or your GitHub account can’t see it.').waitFor()
    await form.getByRole('button', { name: 'Check again' }).waitFor()
    await form.getByRole('button', { name: 'GitHub settings' }).waitFor()

    await form.getByRole('button', { name: 'Clear the primary repo' }).click()
    await form.getByLabel('GitHub URL or owner/repo').fill('acme/widgets')
    await form.getByLabel('GitHub URL or owner/repo').press('Enter')
    await form.getByText(/is the primary repo of Factory widgets\./).waitFor()
    await form.getByRole('button', { name: 'Open widgets' }).waitFor()

    await form.getByLabel('Key').fill('NB')
    await form.getByText('NB is already the key of widgets.').waitFor()
    await form.getByText('Fix the 1 repo problem and the key to continue.').waitFor()
    expect(await form.getByRole('button', { name: 'Add Factory' }).isDisabled()).toBe(true)
  })

  test('Choose folder reads the folder’s GitHub remote', async () => {
    await makeOriginRepo(path.join(home, 'origin'))
    await githubReady(['acme/widgets'])
    const folder = path.join(home, 'code', 'widgets')
    await run('git', ['clone', path.join(home, 'origin', 'acme', 'widgets.git'), folder])
    await run('git', ['remote', 'set-url', 'origin', 'git@github.com:acme/widgets.git'], {
      cwd: folder,
    })
    const window = await launchApp()
    await pickFolderWith(folder)
    await openForm(window)
    const form = dialog(window)

    await form.getByRole('button', { name: 'Choose folder…' }).click()
    await form.getByText('acme/widgets').waitFor()
    await form.getByText('from a folder').waitFor()
    await form.getByText('Can push and open pull requests').waitFor()
  })

  test('a failed clone shows a red row and the banner; Retry recovers', async () => {
    await makeOriginRepo(path.join(home, 'origin'))
    await githubReady(['acme/widgets'])
    const origin = path.join(home, 'origin', 'acme', 'widgets.git')
    await rename(origin, `${origin}.hidden`)
    const window = await launchApp()
    await openForm(window)
    const form = dialog(window)
    await form.getByLabel('GitHub URL or owner/repo').fill('acme/widgets')
    await form.getByLabel('GitHub URL or owner/repo').press('Enter')
    await form.getByText('Can push and open pull requests').waitFor()
    await form.getByRole('button', { name: 'Add Factory' }).click()

    const panel = window.getByRole('region', { name: 'Setting up Widgets' })
    await panel.getByText(/Clone failed:/).waitFor()
    const banners = window.getByRole('region', { name: 'Widgets problems' })
    await banners
      .getByText('Couldn’t clone acme/widgets · Widgets can’t start Tasks until it’s cloned')
      .waitFor()
    await sidebar(window).getByRole('img', { name: 'A problem stops work' }).waitFor()

    await rename(`${origin}.hidden`, origin)
    await banners.getByRole('button', { name: 'Retry' }).click()
    await panel.waitFor({ state: 'detached' })
    await banners.getByText(/Couldn’t clone/).waitFor({ state: 'detached' })
  })
})

describe('banners', () => {
  const noChecks = 'No Checks set up · Validate relies on the agent alone'

  test('a Factory banner shows on that Factory’s pages only, and × hides a warning', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await ted('dev', 'factory', 'add', origin, '--key', 'NB')
    const window = await launchApp()
    const nav = sidebar(window)
    const factoryBanners = window.getByRole('region', { name: 'widgets problems' })

    await nav.getByRole('button', { name: 'widgets' }).click()
    await factoryBanners.getByText(noChecks).waitFor()
    await nav.getByRole('button', { name: 'List', exact: true }).click()
    await factoryBanners.getByText(noChecks).waitFor()
    expect(await nav.getByRole('img', { name: 'A problem stops work' }).count()).toBe(0)

    await nav.getByRole('button', { name: 'All Tasks' }).click()
    await window.getByRole('region', { name: 'All Tasks' }).waitFor()
    expect(await window.getByText(noChecks).count()).toBe(0)

    await nav.getByRole('button', { name: 'Board', exact: true }).click()
    await factoryBanners.getByRole('button', { name: 'Dismiss for 24 hours' }).click()
    await factoryBanners.waitFor({ state: 'detached' })
    const [banner] = await (await daemonClient()).listBanners()
    expect(banner?.dismissedUntil).toBeDefined()
  })

  test('a stops-work Factory banner marks the sidebar row, and Retry clears it', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await ted('dev', 'factory', 'add', origin, '--key', 'NB')
    await ted('task', 'create', '--factory', 'NB', 'Offline editing')
    const window = await launchApp()
    const nav = sidebar(window)
    await nav.getByRole('button', { name: 'widgets' }).click()
    const factoryBanners = window.getByRole('region', { name: 'widgets problems' })
    await factoryBanners.getByText(noChecks).waitFor()

    await rm(path.join(home, 'repos'), { recursive: true, force: true })
    await run('mv', [origin, `${origin}.hidden`])
    await expect(ted('task', 'start', 'NB-1')).rejects.toMatchObject({ code: 1 })

    const failed = factoryBanners.getByRole('alert')
    await failed.getByText('Couldn’t clone acme/widgets').waitFor()
    expect(await factoryBanners.locator('[role=alert], [role=status]').allTextContents()).toEqual([
      expect.stringContaining('Couldn’t clone'),
      expect.stringContaining('No Checks'),
    ])
    expect(await failed.getByRole('button', { name: 'Dismiss for 24 hours' }).count()).toBe(0)
    await nav.getByRole('img', { name: 'A problem stops work' }).waitFor()

    await run('mv', [`${origin}.hidden`, origin])
    await failed.getByRole('button', { name: 'Retry' }).click()

    await failed.waitFor({ state: 'detached' })
    await nav.getByRole('img', { name: 'A problem stops work' }).waitFor({ state: 'detached' })
  })
})

describe('agent health', () => {
  test('a signed-out agent pauses its Task, shows a Fix banner and a red Agents card', async () => {
    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: false }))
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await ted('dev', 'factory', 'add', origin, '--key', 'NB')
    await ted('task', 'create', '--factory', 'NB', 'Offline editing')
    await ted('task', 'start', 'NB-1')
    const window = await launchApp()

    const problems = window.getByRole('region', { name: 'Problems' })
    const banner = problems.getByRole('alert').filter({ hasText: 'Claude Code is signed out' })
    await banner.getByRole('button', { name: 'Fix' }).waitFor()
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()
    await window.getByText('Paused · Claude Code is signed out').waitFor()

    await openSettings(window)
    await settingsNav(window).getByRole('button', { name: 'Agents', exact: true }).click()
    const card = window.getByRole('region', { name: 'Claude Code' })
    await card.getByText(/^Signed out/).waitFor()
    await card.getByText('Not signed in.').waitFor()
    await card.getByRole('button', { name: 'Sign in' }).waitFor()
    await card.getByRole('button', { name: 'Copy command' }).waitFor()
    expect(await card.getAttribute('data-state')).toBe('signed-out')

    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: true }))
    await card.getByRole('button', { name: 'Check again' }).click()
    await card.getByText('Ready').waitFor()
    await banner.waitFor({ state: 'detached' })
  })
})

describe('Working Runs', () => {
  const forever = () => JSON.stringify({ steps: [{ waitFor: path.join(home, 'never') }] })

  async function twoTasksOneSlot(): Promise<Page> {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await ted('dev', 'factory', 'add', origin, '--key', 'NB')
    await ted('task', 'create', '--factory', 'NB', forever())
    await ted('task', 'create', '--factory', 'NB', 'Second Task')
    const window = await launchApp()
    await (await daemonClient()).updateSettings({ maxWorkingRuns: 1 })
    return window
  }

  test('the sidebar footer counts working and queued Runs live and opens the popover', async () => {
    const window = await twoTasksOneSlot()
    const footer = sidebar(window).locator('footer')
    await footer.getByText('Nothing running').waitFor()

    await ted('task', 'start', 'NB-1')
    await ted('task', 'start', 'NB-2')
    await footer.getByRole('button', { name: '1 of 1 Runs working · 1 queued' }).click()

    const popover = window.getByRole('dialog', { name: 'Working Runs' })
    await popover.getByText('1 of 1 slots on this Mac').waitFor()
    const working = popover.getByRole('region', { name: 'Working' })
    await working.getByText('NB-1', { exact: true }).waitFor()
    await working.getByText('widgets · Task Lead').waitFor()
    await working.getByText('1 Run', { exact: true }).waitFor()
    const queued = popover.getByRole('region', { name: 'Queued' })
    await queued.getByText('1st', { exact: true }).waitFor()
    await queued.getByText('NB-2 · Second Task').waitFor()
    await queued.getByText('widgets · None').waitFor()

    await popover.getByRole('button', { name: 'Open in List →' }).click()
    await window.getByRole('heading', { name: 'All Tasks', level: 1 }).waitFor()
    expect(await popover.count()).toBe(0)
  })

  test('with nothing working the popover says so', async () => {
    const window = await launchApp()
    await sidebar(window).getByRole('button', { name: 'Nothing running' }).click()
    const popover = window.getByRole('dialog', { name: 'Working Runs' })
    await popover.getByText('No Runs working. Nothing queued.').waitFor()
    await window.keyboard.press('Escape')
    await popover.waitFor({ state: 'detached' })
  })

  test('S starts the open Backlog Task, and Move to Backlog takes a queued one back', async () => {
    const window = await twoTasksOneSlot()
    await ted('task', 'start', 'NB-1')
    await openAllTasks(window)
    await taskRow(window, 'NB-2').click()
    const header = window.getByRole('region', { name: 'Task thread' }).locator('header')
    await header.getByText('· Not started').waitFor()

    await window.keyboard.press('s')
    await header.getByText('Queued · 1st', { exact: true }).waitFor()

    await header.getByRole('button', { name: 'Move to Backlog' }).click()
    await header.getByText('· Not started').waitFor()
    expect((await (await daemonClient()).getSlots()).queued).toBe(0)
  })

  test('a Factory at its cap shows it in the Board and List header', async () => {
    const parent = path.join(home, 'origin')
    const origin = await makeOriginRepo(parent)
    await commitToOrigin(parent, { '.ted/workflow.yaml': 'version: 1\nmax_working_runs: 1\n' })
    await ted('dev', 'factory', 'add', origin, '--key', 'NB')
    await ted('task', 'create', '--factory', 'NB', forever())
    const window = await launchApp()
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()
    const board = window.getByRole('region', { name: 'widgets' })
    await board.getByRole('heading', { name: 'widgets', level: 1 }).waitFor()
    expect(await board.getByText('1 of 1 working').count()).toBe(0)

    await ted('task', 'start', 'NB-1')

    await board.getByText('1 of 1 working').waitFor()
    await sidebar(window).getByRole('button', { name: 'List' }).click()
    await window.getByRole('region', { name: 'widgets' }).getByText('1 of 1 working').waitFor()
  })

  test('Settings · Limits changes the limit and shows what is working now', async () => {
    const window = await twoTasksOneSlot()
    await ted('task', 'start', 'NB-1')
    await ted('task', 'start', 'NB-2')
    await openSettings(window)
    await settingsNav(window).getByRole('button', { name: 'Limits', exact: true }).click()
    await window.getByText('Now: 1 of 1 Runs working · 1 queued').waitFor()

    await window.getByRole('button', { name: 'More working Runs' }).click()

    await window.getByText('Now: 2 of 2 Runs working').waitFor()
    expect((await (await daemonClient()).getSettings()).maxWorkingRuns).toBe(2)
  })
})

describe('daemon crashes', () => {
  const reconnecting = (window: Page) =>
    window.getByRole('status', { name: 'Reconnecting to TED…' })

  async function killDaemon(): Promise<number> {
    const pid = await daemonPid()
    process.kill(pid, 'SIGKILL')
    await waitForExit(pid)
    return pid
  }

  async function waitForNewDaemon(old: number): Promise<number> {
    await expect
      .poll(
        async () => {
          const info = await readDaemonInfo(home)
          return info !== undefined && info.pid !== old && isAlive(info.pid)
        },
        { timeout: 20_000 },
      )
      .toBe(true)
    return daemonPid()
  }

  test('killing the daemon shows the Reconnecting bar and turns actions off while the Run keeps going; the restarted daemon picks the Run back up', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await commitToOrigin(path.join(home, 'origin'), {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
    const steps = JSON.stringify({
      steps: [
        { waitFor: path.join(home, 'go') },
        { everyMessage: [{ run: ['ted', 'outcome', 'advance'] }] },
        { run: ['ted', 'outcome', 'advance'] },
      ],
    })
    await ted('dev', 'factory', 'add', origin, '--key', 'NB')
    await ted('task', 'create', '--factory', 'NB', steps)
    const window = await launchApp({ TED_RESTART_DELAYS_MS: '1500,0,0' })
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await ted('task', 'start', 'NB-1')
    await details.getByText('Intake', { exact: true }).waitFor()
    await expect.poll(async () => (await runHostPids()).length).toBe(2)
    const hosts = await runHostPids()

    const old = await killDaemon()

    await reconnecting(window).waitFor()
    await reconnecting(window)
      .getByText('Runs keep going. Actions are off until TED is back.')
      .waitFor()
    expect(await sidebar(window).getByRole('button', { name: 'All Tasks' }).isDisabled()).toBe(true)
    expect(hosts.every(isAlive)).toBe(true)

    await waitForNewDaemon(old)
    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    expect(await sidebar(window).getByRole('button', { name: 'All Tasks' }).isDisabled()).toBe(
      false,
    )
    await writeFile(path.join(home, 'go'), '')
    await details.getByText('Done', { exact: true }).waitFor({ timeout: 20_000 })
  })

  test('after reconnecting, the sidebar shows slots that changed while the app was away', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await ted('dev', 'factory', 'add', origin, '--key', 'NB')
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      JSON.stringify({ steps: [{ waitFor: path.join(home, 'never') }] }),
    )
    const window = await launchApp({ TED_RESTART_DELAYS_MS: '6000,0,0' })
    await ted('task', 'start', 'NB-1')
    const footer = sidebar(window).locator('footer')
    await footer.getByRole('button', { name: /^1 of \d+ Runs working$/ }).waitFor()

    await killDaemon()
    await reconnecting(window).waitFor()
    await ted('task', 'list')
    await (await daemonClient()).updateSettings({ maxWorkingRuns: 7 })

    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    await footer.getByRole('button', { name: '1 of 7 Runs working' }).waitFor()
  })

  test('after reconnecting, the Inbox shows a request raised while the app was away', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    const briefFile = path.join(home, 'brief.md')
    await writeFile(
      briefFile,
      [
        '## Goal\n\nLet notes be edited offline.',
        '## Decisions so far\n\n- Keep both edits on a clash.',
        '## Current state\n\nThe approach is written up.',
        '## Open questions\n\nNone.',
        '## Next step\n\nBuild it.\n',
      ].join('\n\n'),
    )
    const gate = [
      { run: ['ted', 'brief', 'write', '--file', briefFile] },
      { run: ['ted', 'outcome', 'advance'] },
      { endTurn: true },
    ]
    await ted('dev', 'factory', 'add', origin, '--key', 'NB')
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      JSON.stringify({ steps: [{ everyMessage: gate }, ...gate] }),
    )
    const window = await launchApp({ TED_RESTART_DELAYS_MS: '8000,0,0' })
    const inbox = window.getByRole('region', { name: 'Inbox' })
    await inbox.waitFor()

    await killDaemon()
    await reconnecting(window).waitFor()
    await ted('task', 'start', 'NB-1')
    await expect
      .poll(async () => (await (await daemonClient()).listInbox()).length, { timeout: 20_000 })
      .toBe(1)

    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    await inbox.getByRole('button').filter({ hasText: 'Design review' }).waitFor()
  })

  test('three crashes in ten minutes stop restarts and raise the banner; its menu copies a report and restarts TED', async () => {
    const window = await launchApp({ TED_RESTART_DELAYS_MS: '0,0,0' })
    await app?.evaluate(({ clipboard }) => {
      const record = globalThis as unknown as { copied: string[] }
      record.copied = []
      clipboard.writeText = async (text: string) => {
        record.copied.push(text)
      }
    })
    const recorded = () => app?.evaluate(() => globalThis as unknown as { copied: string[] })

    await waitForNewDaemon(await killDaemon())
    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    await waitForNewDaemon(await killDaemon())
    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    const last = await killDaemon()

    const banner = window.getByRole('region', { name: 'Problems' }).getByRole('alert')
    await banner.getByText('TED’s background process keeps stopping').waitFor()
    expect(await reconnecting(window).count()).toBe(0)
    expect(await sidebar(window).getByRole('button', { name: 'All Tasks' }).isDisabled()).toBe(true)
    await sleep(500)
    expect(await daemonPid()).toBe(last)

    await banner.getByRole('button', { name: 'Restart' }).click()
    await window.getByRole('menuitem', { name: 'Copy report' }).click()
    await expect.poll(async () => (await recorded())?.copied.length).toBe(1)
    const [report] = (await recorded())?.copied ?? []
    expect(report).toContain('crash report')
    expect(report).toMatch(/TED daemon .* listening on/)
    expect(report).toContain('starting TED’s daemon')

    await banner.getByRole('button', { name: 'Restart' }).click()
    await window.getByRole('menuitem', { name: 'Restart TED in the background' }).click()

    await banner.waitFor({ state: 'detached', timeout: 20_000 })
    await waitForNewDaemon(last)
    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    expect(await sidebar(window).getByRole('button', { name: 'All Tasks' }).isDisabled()).toBe(
      false,
    )
  })
})

async function runHostPids(): Promise<number[]> {
  const pids: number[] = []
  for (const id of await readdir(path.join(home, 'runs')).catch(() => [])) {
    const start = (await hostRecords(home, id)).find((r) => r.t === 'start')
    for (const pid of [start?.agentPid, start?.hostPid]) if (typeof pid === 'number') pids.push(pid)
  }
  return pids
}

describe('running in the background', () => {
  async function startRun(steps: unknown[]): Promise<string> {
    const client = await daemonClient()
    const { id } = await client.startDevRun({ prompt: JSON.stringify({ steps }), cwd: home })
    await expect.poll(async () => (await client.getActivity()).runs.active).toBe(1)
    return id
  }

  const never = () => ({ waitFor: path.join(home, 'never') })

  const menuLabels = () =>
    (app as ElectronApplication).evaluate(({ Menu }) => {
      const walk = (menu: Electron.Menu): string[] =>
        menu.items.flatMap((item) => [item.label, ...(item.submenu ? walk(item.submenu) : [])])
      const menu = Menu.getApplicationMenu()
      return menu ? walk(menu) : []
    })

  test('closing the window keeps TED running, and the window still gets updates', async () => {
    const window = await launchApp()
    await openAllTasks(window)

    await app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
    await ted('task', 'create', 'Fix login')

    expect(await app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    await taskRow(window, 'DEV-1').waitFor()
  })

  test('with Keep running remembered, Quit leaves the Run going; with Stop it, Quit ends it all', async () => {
    await launchApp()
    const client = await daemonClient()
    const pid = await daemonPid()
    const electronPid = app?.process().pid ?? 0
    await client.updateSettings({ quitWithWorkRunning: 'keep-running' })
    const runId = await startRun([never()])
    await sleep(300)

    await app?.evaluate(({ app }) => app.quit())
    await sleep(1_000)

    expect(isAlive(electronPid)).toBe(true)
    expect((await client.getRun(runId)).run.state).not.toBe('finished')

    await client.updateSettings({ quitWithWorkRunning: 'stop' })
    await sleep(300)
    await app?.close()
    app = undefined

    await waitForExit(pid)
    expect(isAlive(electronPid)).toBe(false)
    expect((await hostRecords(home, runId)).some((r) => r.t === 'exit')).toBe(true)
  })

  test('the app menu shows what’s waiting and running, and its items open the right place', async () => {
    const window = await launchApp()
    await startRun([{ hook: 'PermissionRequest:Bash' }, never()])

    await expect
      .poll(menuLabels, { timeout: 10_000 })
      .toEqual(
        expect.arrayContaining([
          '1 waiting on you',
          '0 of 1 Run working',
          'Open TED',
          'New Task…',
          'Settings…',
          'Quit TED completely',
        ]),
      )
    if (process.platform === 'linux') expect(await window.title()).toBe('TED (1)')

    await app?.evaluate(({ Menu }) => {
      const find = (menu: Electron.Menu): Electron.MenuItem | undefined => {
        for (const item of menu.items) {
          const found = item.label === 'Settings…' ? item : item.submenu && find(item.submenu)
          if (found) return found
        }
        return undefined
      }
      const menu = Menu.getApplicationMenu()
      const settings = menu && find(menu)
      settings?.click()
    })

    await window.getByRole('radiogroup', { name: 'Appearance' }).waitFor()
  })

  test('the quit choice is a setting in the app', async () => {
    const window = await launchApp()
    await sidebar(window)
      .getByRole('button', { name: /^Settings/ })
      .last()
      .click()

    await window
      .getByLabel('When you quit with work running')
      .selectOption({ label: 'Keep running in the background' })

    await expect
      .poll(async () => (await daemonClient()).getSettings())
      .toMatchObject({ quitWithWorkRunning: 'keep-running' })
  })

  test('opening TED again while it runs hands over to the running app', async () => {
    await launchApp()
    const electronPid = app?.process().pid ?? 0

    await run(electronPath, [appDir], { env: env(), timeout: 20_000 })

    expect(isAlive(electronPid)).toBe(true)
  })
})

async function pickFolderWith(folder: string): Promise<void> {
  await app?.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [chosen] })) as never
  }, folder)
}

async function githubReady(repos: string[], extra: Record<string, unknown> = {}): Promise<void> {
  const paths: Record<string, unknown> = {}
  for (const repo of repos) {
    paths[`repos/${repo}`] = {
      body: { full_name: repo, default_branch: 'main', permissions: { push: true } },
    }
    paths[`repos/${repo}/commits?per_page=1`] = { body: [] }
  }
  const state = path.join(home, 'gh.json')
  await writeFile(state, JSON.stringify({ paths: { ...paths, ...extra } }))
  extraEnv = {
    ...extraEnv,
    TED_STUB_GH: state,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.file://${path.join(home, 'origin')}/.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/',
  }
}

async function channelsOf(pid: number): Promise<string[]> {
  const dir = `/proc/${pid}/fd`
  const targets = await Promise.all(
    (await readdir(dir)).map((fd) => readlink(path.join(dir, fd)).catch(() => '')),
  )
  return targets.filter((target) => /^(pipe|socket):/.test(target))
}

describe('Inbox and Gates', () => {
  test('a design review waits in the Inbox; Request changes keeps the Stage and Approve moves on', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    const briefFile = path.join(home, 'brief.md')
    await writeFile(
      briefFile,
      [
        '## Goal\n\nLet notes be edited offline.',
        '## Decisions so far\n\n- Keep both edits on a clash.',
        '## Current state\n\nThe approach is written up.',
        '## Open questions\n\nNone.',
        '## Next step\n\nBuild it.\n',
      ].join('\n\n'),
    )
    const gate = [
      { run: ['ted', 'brief', 'write', '--file', briefFile] },
      { run: ['ted', 'outcome', 'advance'] },
      { endTurn: true },
    ]
    await ted('dev', 'factory', 'add', origin, '--key', 'NB')
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      JSON.stringify({ steps: [{ everyMessage: gate }, ...gate] }),
    )
    const window = await launchApp()
    await ted('task', 'start', 'NB-1')

    const inbox = window.getByRole('region', { name: 'Inbox' })
    const row = inbox.getByRole('button').filter({ hasText: 'Design review' })
    await row.waitFor()
    expect(await row.textContent()).toContain('Let notes be edited offline.')
    await sidebar(window)
      .getByRole('button', { name: /^Inbox/ })
      .getByText('1')
      .waitFor()
    await row.click()

    const thread = window.getByRole('region', { name: 'Task thread' })
    const card = thread.getByRole('region', { name: 'Design review', exact: true })
    await card.getByText('Let notes be edited offline.', { exact: true }).waitFor()
    await thread.getByText('Waiting on you', { exact: true }).waitFor()
    expect(await card.getByRole('button', { name: 'Request changes' }).isDisabled()).toBe(true)
    await card.getByRole('textbox', { name: 'Your answer' }).fill('Split the sync step in two.')
    await card.getByRole('button', { name: 'Request changes' }).click()

    const answered = thread.getByRole('region', { name: 'Design review, answered' }).first()
    await answered.getByText('You requested changes').waitFor()
    await answered.getByText('“Split the sync step in two.”').waitFor()
    await card.getByRole('button', { name: 'Approve' }).click()

    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByText('Review', { exact: true }).waitFor()
    const signoff = inbox.getByRole('button').filter({ hasText: 'Sign-off' })
    await signoff.waitFor()
    await signoff.click()
    await thread
      .getByRole('region', { name: 'Sign-off', exact: true })
      .getByRole('button', { name: 'Approve and merge' })
      .waitFor()
  })
})
