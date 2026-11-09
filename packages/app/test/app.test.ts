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
})

const env = () => ({
  ...process.env,
  TED_HOME: home,
  TED_IDLE_EXIT_MS: '30000',
  TED_CLAUDE_BIN: stubClaudePath,
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

  test('three crashes in ten minutes stop restarts and raise one banner and one notification; its menu copies a report and restarts TED', async () => {
    const window = await launchApp({ TED_RESTART_DELAYS_MS: '0,0,0' })
    await app?.evaluate(({ clipboard, Notification }) => {
      const record = globalThis as unknown as { shown: string[]; copied: string[] }
      record.shown = []
      record.copied = []
      Notification.prototype.show = function (this: Electron.Notification) {
        record.shown.push(this.body)
      }
      clipboard.writeText = async (text: string) => {
        record.copied.push(text)
      }
    })
    const recorded = () =>
      app?.evaluate(() => globalThis as unknown as { shown: string[]; copied: string[] })

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
    expect((await recorded())?.shown).toEqual(['TED’s background process keeps stopping'])

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

async function channelsOf(pid: number): Promise<string[]> {
  const dir = `/proc/${pid}/fd`
  const targets = await Promise.all(
    (await readdir(dir)).map((fd) => readlink(path.join(dir, fd)).catch(() => '')),
  )
  return targets.filter((target) => /^(pipe|socket):/.test(target))
}
