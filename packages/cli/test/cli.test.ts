import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { readDaemonInfo } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

const cliPath = fileURLToPath(new URL('../src/main.ts', import.meta.url))
const run = promisify(execFile)

let home: string

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-cli-'))
})

afterEach(async () => {
  const info = await readDaemonInfo(home)
  if (info) {
    process.kill(info.pid, 'SIGTERM')
    await waitForExit(info.pid)
  }
  await rm(home, { recursive: true, force: true })
})

function ted(args: string[], idleExitMs = 30_000) {
  return run(process.execPath, [cliPath, ...args], {
    env: { ...process.env, TED_HOME: home, TED_IDLE_EXIT_MS: String(idleExitMs) },
  })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (isAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`pid ${pid} still running`)
    await sleep(50)
  }
}

async function daemonPid(): Promise<number> {
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  return info.pid
}

describe('ted task', () => {
  test('create starts the daemon when it is not running, and list shows the Task', async () => {
    expect(await readDaemonInfo(home)).toBeUndefined()

    const created = await ted(['task', 'create', 'Fix login'])
    expect(created.stdout.trim()).toBe('Created DEV-1  Fix login')
    expect(isAlive(await daemonPid())).toBe(true)

    const listed = await ted(['task', 'list'])
    expect(listed.stdout.trim()).toBe('DEV-1  Fix login')
  })

  test('Tasks are still there after the daemon restarts', async () => {
    await ted(['task', 'create', 'Fix login'])
    await ted(['task', 'create', 'Add dark mode'])
    const firstPid = await daemonPid()
    process.kill(firstPid, 'SIGTERM')
    await waitForExit(firstPid)

    const listed = await ted(['task', 'list'])

    expect(await daemonPid()).not.toBe(firstPid)
    expect(listed.stdout.trim().split('\n')).toEqual(['DEV-1  Fix login', 'DEV-2  Add dark mode'])
  })

  test('ted recovers when the daemon was killed and left daemon.json behind', async () => {
    await ted(['task', 'create', 'Fix login'])
    const firstPid = await daemonPid()
    process.kill(firstPid, 'SIGKILL')
    await waitForExit(firstPid)

    const listed = await ted(['task', 'list'])

    expect(listed.stdout.trim()).toBe('DEV-1  Fix login')
  })

  test('a daemon that ted started exits once idle', async () => {
    await ted(['task', 'list'], 1_000)
    const pid = await daemonPid()

    await waitForExit(pid, 5_000)

    expect(await readDaemonInfo(home)).toBeUndefined()
  })

  test('list says so when there are no Tasks', async () => {
    const listed = await ted(['task', 'list'])
    expect(listed.stdout.trim()).toBe('No Tasks yet.')
  })

  test('an unknown command prints usage and fails', async () => {
    await expect(ted(['nonsense'])).rejects.toMatchObject({ code: 2 })
  })
})
