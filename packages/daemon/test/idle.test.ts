import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { DaemonClient, readDaemonInfo } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  api,
  appHeaders,
  hostRecords,
  isAlive,
  killRunHosts,
  makeTempHome,
  rawRequest,
  spawnDaemonProcess,
  stubClaudePath,
  testAppToken,
  waitUntil,
} from './helpers.ts'

const mainPath = fileURLToPath(new URL('../src/main.ts', import.meta.url))

let home: string
let cleanup: () => Promise<void>
let child: ChildProcess | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
})

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill()
    await once(child, 'exit')
  }
  child = undefined
  await cleanup()
})

function startDaemonProcess(args: string[], idleExitMs: number): ChildProcess {
  return spawn(process.execPath, [mainPath, ...args], {
    env: { ...process.env, TED_HOME: home, TED_IDLE_EXIT_MS: String(idleExitMs) },
    stdio: 'ignore',
  })
}

async function waitForPort(): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const info = await readDaemonInfo(home)
    if (info) return info.port
    await sleep(25)
  }
  throw new Error('daemon did not write daemon.json')
}

test('a daemon started with --exit-when-idle exits once no request arrives for the idle time', async () => {
  child = startDaemonProcess(['--exit-when-idle'], 800)
  const exited = once(child, 'exit')
  const port = await waitForPort()

  for (let i = 0; i < 8; i++) {
    await sleep(200)
    expect((await rawRequest(port, { path: '/healthz' })).status).toBe(200)
  }
  expect(child.exitCode).toBeNull()

  const [code] = await exited
  expect(code).toBe(0)
  expect(await readDaemonInfo(home)).toBeUndefined()
})

test('a daemon started without --exit-when-idle keeps running', async () => {
  child = startDaemonProcess([], 200)
  await waitForPort()

  await sleep(800)

  expect(child.exitCode).toBeNull()
})

test('an open event stream keeps a daemon started with --exit-when-idle running', async () => {
  child = startDaemonProcess(['--exit-when-idle'], 300)
  const exited = once(child, 'exit')
  await waitForPort()
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  const subscription = await new DaemonClient(info).subscribe(() => {})

  await sleep(900)
  expect(child.exitCode).toBeNull()

  subscription.close()
  const [code] = await exited
  expect(code).toBe(0)
})

test('a request still in flight keeps a daemon started with --exit-when-idle running', async () => {
  child = spawnDaemonProcess(['--exit-when-idle'], {
    ...process.env,
    TED_HOME: home,
    TED_IDLE_EXIT_MS: '300',
  })
  const exited = once(child, 'exit')
  const port = await waitForPort()
  const body = JSON.stringify({ prompt: '' })
  const response = new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/dev/runs',
        headers: {
          ...appHeaders(testAppToken, 'POST', '/dev/runs', body),
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on('error', reject)
    req.flushHeaders()
    setTimeout(() => req.end(body), 900)
  })

  expect(await response).toBe(400)
  expect(child.exitCode).toBeNull()

  const [code] = await exited
  expect(code).toBe(0)
})

test('a live Run keeps an idle daemon up, and an unattended daemon stops its Runs and exits', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ted-run-cwd-'))
  try {
    child = spawnDaemonProcess(['--exit-when-idle'], {
      ...process.env,
      TED_HOME: home,
      TED_IDLE_EXIT_MS: '300',
      TED_UNATTENDED_EXIT_MS: '3000',
      TED_CLAUDE_BIN: stubClaudePath,
    })
    const exited = once(child, 'exit')
    const port = await waitForPort()
    const client = api(port, { appKey: testAppToken })
    const finish = path.join(cwd, 'finish')
    await client.startRun([{ waitFor: finish }, { exit: 0 }], cwd)
    const waiting = await client.startRun([{ waitFor: finish }, { endTurn: true }], cwd)

    await sleep(1_500)
    expect(child.exitCode).toBeNull()

    await writeFile(finish, '')
    await sleep(1_000)
    expect(child.exitCode).toBeNull()

    const [code] = await exited
    expect(code).toBe(0)
    const pids = (await hostRecords(home, waiting.id))
      .filter((record) => record.t === 'start')
      .flatMap((start) => [start.hostPid, start.agentPid])
    expect(pids.length).toBeGreaterThan(0)
    await waitUntil(() => pids.every((pid) => !isAlive(Number(pid))), 'the idle Run’s host to stop')
  } finally {
    await killRunHosts(home)
    await rm(cwd, { recursive: true, force: true })
  }
})
