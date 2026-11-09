import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readlink, rm, writeFile } from 'node:fs/promises'
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
import { hostRecords, killRunHosts, makeOriginRepo } from '../../daemon/test/helpers.ts'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const cliPath = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url))
const stubClaudePath = fileURLToPath(
  new URL('../../daemon/test/fixtures/stub-claude.ts', import.meta.url),
)
const electronPath = createRequire(import.meta.url)('electron') as string
const run = promisify(execFile)

let home: string
let app: ElectronApplication | undefined

beforeAll(async () => {
  await build({ configFile: path.join(appDir, 'vite.config.ts'), logLevel: 'warn' })
})

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-app-'))
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
})

async function launchApp(): Promise<Page> {
  app = await electron.launch({ executablePath: electronPath, args: [appDir], env: env() })
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

  test('a missing local folder raises a Factory banner with Locate', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    const folder = path.join(home, 'local')
    await mkdir(folder)
    await ted('dev', 'factory', 'add', origin, '--key', 'NB', '--local-folder', folder)
    await rm(folder, { recursive: true })

    const window = await launchApp()

    const banner = window.getByRole('alert')
    await banner.getByText('Local folder for widgets not found').waitFor()
    await banner.getByRole('button', { name: 'Locate' }).waitFor()
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

async function channelsOf(pid: number): Promise<string[]> {
  const dir = `/proc/${pid}/fd`
  const targets = await Promise.all(
    (await readdir(dir)).map((fd) => readlink(path.join(dir, fd)).catch(() => '')),
  )
  return targets.filter((target) => /^(pipe|socket):/.test(target))
}
