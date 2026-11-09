import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDaemonInfo } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  hostRecords,
  killRunHosts,
  makeTempHome,
  stubClaudePath,
  tokenFor,
  waitUntil,
} from './helpers.ts'

const mainPath = fileURLToPath(new URL('../src/main.ts', import.meta.url))

let home: string
let cleanup: () => Promise<void>
let parent: ChildProcess | undefined
let daemon: ChildProcess | undefined
let inProcess: RunningDaemon | undefined
const savedExitWith = process.env.TED_EXIT_WITH_PID

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
})

afterEach(async () => {
  if (savedExitWith === undefined) delete process.env.TED_EXIT_WITH_PID
  else process.env.TED_EXIT_WITH_PID = savedExitWith
  for (const child of [parent, daemon]) {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  }
  parent = daemon = undefined
  await inProcess?.stop()
  inProcess = undefined
  await killRunHosts(home)
  await cleanup()
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function killParent(): Promise<void> {
  parent?.kill('SIGKILL')
  if (parent) await once(parent, 'exit')
}

test('a daemon exits once the process named by TED_EXIT_WITH_PID dies', async () => {
  daemon = spawn(process.execPath, [mainPath], {
    env: { ...process.env, TED_HOME: home, TED_EXIT_WITH_PID: String(parent?.pid) },
    stdio: 'ignore',
  })
  const exited = once(daemon, 'exit')
  await waitUntil(() => readDaemonInfo(home), 'the daemon to start', 20_000)
  expect(daemon.exitCode).toBeNull()

  await killParent()
  const [code] = await exited
  expect(code).toBe(0)
})

test('a Run host stops its agent and exits once that process dies', async () => {
  process.env.TED_EXIT_WITH_PID = String(parent?.pid)
  inProcess = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(inProcess.port, await tokenFor(home))
  const cwd = await mkdtemp(path.join(tmpdir(), 'ted-run-cwd-'))
  try {
    const run = await client.startRun([{ waitFor: path.join(cwd, 'never') }], cwd)
    const start = await waitUntil(
      async () => (await hostRecords(home, run.id)).find((r) => r.t === 'start'),
      'the Run host to start',
    )
    const pids = [start.hostPid, start.agentPid] as number[]
    expect(pids.every(alive)).toBe(true)

    await killParent()
    await waitUntil(() => pids.every((pid) => !alive(pid)), 'the host and agent to exit')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
