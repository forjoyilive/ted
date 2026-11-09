import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readlink, rm, writeFile } from 'node:fs/promises'
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
import { killRunHosts, makeOriginRepo } from '../../daemon/test/helpers.ts'

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
})

const env = () => ({
  ...process.env,
  TED_HOME: home,
  TED_IDLE_EXIT_MS: '30000',
  TED_CLAUDE_BIN: stubClaudePath,
})

async function launchApp(): Promise<Page> {
  app = await electron.launch({ executablePath: electronPath, args: [appDir], env: env() })
  const window = await app.firstWindow()
  await window.emulateMedia({ colorScheme: null })
  await sidebar(window).waitFor()
  return window
}

const sidebar = (window: Page) => window.getByRole('navigation', { name: 'Sidebar' })

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

  test('closing the app leaves the daemon running, and reopening reconnects to it', async () => {
    await launchApp()
    const pid = await daemonPid()

    await app?.close()
    app = undefined
    expect(isAlive(pid)).toBe(true)

    await ted('task', 'create', 'Fix login')
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'DEV-1').waitFor()
    expect(await daemonPid()).toBe(pid)
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
    await sidebar(window)
      .getByRole('button', { name: /^Settings/ })
      .last()
      .click()
    const appearance = window.getByRole('radiogroup', { name: 'Appearance' })

    await appearance.getByText('Dark').click()
    await expect.poll(() => background(window), { timeout: 5_000 }).toBe(darkApp)
    expect(await (await daemonClient()).getSettings()).toEqual({ appearance: 'dark' })

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

async function channelsOf(pid: number): Promise<string[]> {
  const dir = `/proc/${pid}/fd`
  const targets = await Promise.all(
    (await readdir(dir)).map((fd) => readlink(path.join(dir, fd)).catch(() => '')),
  )
  return targets.filter((target) => /^(pipe|socket):/.test(target))
}
