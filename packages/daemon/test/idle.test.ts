import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { DaemonClient, readDaemonInfo } from '@ted/protocol'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/daemon.ts'
import {
  api,
  appHeaders,
  hostRecords,
  isAlive,
  killRunHosts,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'
import { ManualClock } from './support/manual-clock.ts'

const mainPath = fileURLToPath(new URL('../src/main.ts', import.meta.url))

let home: string
let cleanup: () => Promise<void>
let child: ChildProcess | undefined
let daemon: RunningDaemon | undefined
const idleMs = 4_321
const unattendedMs = 98_765

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
})

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill()
    await once(child, 'exit')
  }
  child = undefined
  await daemon?.stop()
  daemon = undefined
  await cleanup()
})

async function startIdle(onExit?: (stoppedRuns: number) => void) {
  const time = new ManualClock()
  const onIdle = vi.fn()
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    clock: time,
    idleExit: {
      afterMs: idleMs,
      onIdle,
      ...(onExit && { unattended: { afterMs: unattendedMs, onExit } }),
    },
  })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  return { time, onIdle, info, appToken: daemon.appToken }
}

async function idleCountdown(time: ManualClock): Promise<void> {
  await waitUntil(() => time.pending.includes(idleMs), 'the idle time to start again')
}

function startDaemonProcess(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [mainPath, ...args], {
    env: { ...process.env, TED_HOME: home, ...env },
    stdio: 'ignore',
  })
}

test('a daemon started with --exit-when-idle exits once no request arrives for the idle time', async () => {
  child = startDaemonProcess(['--exit-when-idle'], { TED_IDLE_EXIT_MS: '300' })

  const [code] = await once(child, 'exit')
  expect(code).toBe(0)
  expect(await readDaemonInfo(home)).toBeUndefined()
}, 90_000)

test('a daemon started with --exit-when-idle exits once nothing has used it for the unattended time', async () => {
  child = startDaemonProcess(['--exit-when-idle'], {
    TED_IDLE_EXIT_MS: '3600000',
    TED_UNATTENDED_EXIT_MS: '300',
  })

  const [code] = await once(child, 'exit')
  expect(code).toBe(0)
  expect(await readDaemonInfo(home)).toBeUndefined()
}, 90_000)

test('a daemon started without --exit-when-idle keeps running', async () => {
  child = startDaemonProcess([], { TED_IDLE_EXIT_MS: '200' })
  const running = child
  await waitUntil(
    async () => {
      if (running.exitCode !== null) throw new Error('the daemon exited')
      return await readDaemonInfo(home)
    },
    'daemon.json',
    60_000,
  )

  await sleep(800)

  expect(child.exitCode).toBeNull()
}, 90_000)

test('an open event stream keeps a daemon with an idle exit running until it closes', async () => {
  const { time, onIdle, info } = await startIdle()
  const subscription = await new DaemonClient(info).subscribe(() => {})

  time.advance(idleMs * 3)
  expect(onIdle).not.toHaveBeenCalled()

  subscription.close()
  await idleCountdown(time)
  time.advance(idleMs)
  expect(onIdle).toHaveBeenCalledTimes(1)
})

test('a request still in flight keeps a daemon with an idle exit running, and its end starts the full idle time again', async () => {
  const { time, onIdle, info, appToken } = await startIdle()
  const body = JSON.stringify({ prompt: '' })
  let send: () => void = () => undefined
  const response = new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: info.port,
        method: 'POST',
        path: '/dev/runs',
        headers: {
          ...appHeaders(appToken, 'POST', '/dev/runs', body),
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
    send = () => req.end(body)
  })
  await waitUntil(() => !time.pending.includes(idleMs), 'the request to arrive')
  time.advance(idleMs * 3)
  expect(onIdle).not.toHaveBeenCalled()

  send()
  expect(await response).toBe(400)
  await idleCountdown(time)
  time.advance(idleMs - 1)
  expect(onIdle).not.toHaveBeenCalled()
  time.advance(1)
  expect(onIdle).toHaveBeenCalledTimes(1)
})

test('a live Run keeps an idle daemon up, and an unattended daemon stops its Runs', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ted-run-cwd-'))
  try {
    const onExit = vi.fn()
    const { time, onIdle, info, appToken } = await startIdle(onExit)
    const client = api(info.port, { appKey: appToken })
    const finish = path.join(cwd, 'finish')
    const ending = await client.startRun([{ waitFor: finish }, { exit: 0 }], cwd)
    const waiting = await client.startRun([{ waitFor: finish }, { endTurn: true }], cwd)

    time.advance(idleMs * 3)
    expect(onIdle).not.toHaveBeenCalled()

    await writeFile(finish, '')
    await waitUntil(
      async () =>
        (await client.getRun(ending.id)).run.state === 'finished' &&
        (await client.getRun(waiting.id)).run.state === 'idle',
      'one Run to end and the other to go idle',
      60_000,
    )
    await waitUntil(() => time.pending.includes(unattendedMs), 'the unattended time to start again')
    time.advance(idleMs * 3)
    expect(onIdle).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()

    time.advance(unattendedMs)
    await waitUntil(() => onExit.mock.calls.length > 0, 'the unattended daemon to stop its Runs')
    expect(onExit).toHaveBeenCalledWith(1)
    const pids = (await hostRecords(home, waiting.id))
      .filter((record) => record.t === 'start')
      .flatMap((start) => [start.hostPid, start.agentPid])
    expect(pids.length).toBeGreaterThan(0)
    await waitUntil(() => pids.every((pid) => !isAlive(Number(pid))), 'the idle Run’s host to stop')
  } finally {
    await killRunHosts(home)
    await rm(cwd, { recursive: true, force: true })
  }
}, 90_000)
