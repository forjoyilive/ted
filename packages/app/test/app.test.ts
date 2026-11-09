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

async function channelsOf(pid: number): Promise<string[]> {
  const dir = `/proc/${pid}/fd`
  const targets = await Promise.all(
    (await readdir(dir)).map((fd) => readlink(path.join(dir, fd)).catch(() => '')),
  )
  return targets.filter((target) => /^(pipe|socket):/.test(target))
}
