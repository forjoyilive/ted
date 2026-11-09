import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readlink, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { readDaemonInfo } from '@ted/protocol'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { build } from 'vite'
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const cliPath = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url))
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
  await rm(home, { recursive: true, force: true })
})

const env = () => ({ ...process.env, TED_HOME: home, TED_IDLE_EXIT_MS: '30000' })

async function launchApp(): Promise<Page> {
  app = await electron.launch({ executablePath: electronPath, args: [appDir], env: env() })
  return app.firstWindow()
}

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
    const window = await launchApp()

    await window.getByText('No Tasks yet.').waitFor()
    expect(await commandOf(await daemonPid())).toContain(electronPath)
  })

  test('a Task created from the CLI appears in the window within a second', async () => {
    const window = await launchApp()
    await window.getByText('No Tasks yet.').waitFor()

    await ted('task', 'create', 'Fix login')

    await window.getByText('DEV-1 Fix login').waitFor({ timeout: 1_000 })
  })

  test('closing the app leaves the daemon running, and reopening reconnects to it', async () => {
    await launchApp()
    await app?.firstWindow().then((w) => w.getByText('No Tasks yet.').waitFor())
    const pid = await daemonPid()

    await app?.close()
    app = undefined
    expect(isAlive(pid)).toBe(true)

    await ted('task', 'create', 'Fix login')
    const window = await launchApp()
    await window.getByText('DEV-1 Fix login').waitFor()
    expect(await daemonPid()).toBe(pid)
  })

  test('the app connects to a daemon that ted started instead of starting another', async () => {
    await ted('task', 'create', 'Fix login')
    const pid = await daemonPid()

    const window = await launchApp()

    await window.getByText('DEV-1 Fix login').waitFor()
    expect(await daemonPid()).toBe(pid)
  })

  test('the renderer has no Node, filesystem or store access, only the bridge', async () => {
    const window = await launchApp()
    await window.getByText('No Tasks yet.').waitFor()

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
      await (await launchApp()).getByText('No Tasks yet.').waitFor()
      const electronPid = app?.process().pid
      if (electronPid === undefined) throw new Error('no Electron pid')

      const electron = new Set(await channelsOf(electronPid))
      const shared = (await channelsOf(await daemonPid())).filter((c) => electron.has(c))

      expect(shared).toEqual([])
    },
  )
})

async function channelsOf(pid: number): Promise<string[]> {
  const dir = `/proc/${pid}/fd`
  const targets = await Promise.all(
    (await readdir(dir)).map((fd) => readlink(path.join(dir, fd)).catch(() => '')),
  )
  return targets.filter((target) => /^(pipe|socket):/.test(target))
}
