import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DaemonClient, type DaemonEvent, readDaemonInfo, tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  type DaemonConnection,
  type DaemonSupervisor,
  finishWork,
  superviseDaemon,
  withDaemon,
} from '../src/launch.ts'
import { tryLock } from '../src/lock.ts'
import {
  api,
  assistantTexts,
  hostRecords,
  isAlive,
  killRunHosts,
  makeTempHome,
  stubClaudePath,
  testAppToken,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let supervisor: DaemonSupervisor | undefined
let states: DaemonConnection['state'][]
let events: DaemonEvent[]
let fakes: ChildProcess[] = []

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  states = []
  events = []
})

afterEach(async () => {
  for (const fake of fakes) fake.kill('SIGKILL')
  fakes = []
  supervisor?.close()
  supervisor = undefined
  const info = await readDaemonInfo(home)
  if (info && isAlive(info.pid)) {
    process.kill(info.pid, 'SIGKILL')
    await waitUntil(() => !isAlive(info.pid), 'the daemon to exit')
  }
  await cleanup()
})

async function supervise(options: Partial<Parameters<typeof superviseDaemon>[1]> = {}) {
  supervisor = await superviseDaemon(home, {
    onEvent: (event) => events.push(event),
    onConnection: (connection) => states.push(connection.state),
    restartDelaysMs: [0, 50, 100],
    ...options,
  })
  return supervisor
}

async function crash(): Promise<number> {
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  await new DaemonClient(info).listTasks()
  process.kill(info.pid, 'SIGKILL')
  await waitUntil(() => !isAlive(info.pid), 'the daemon to die')
  return info.pid
}

const connectedAgain = (count: number) =>
  waitUntil(
    () => states.filter((s) => s === 'connected').length >= count,
    'the supervisor to reconnect',
    20_000,
  )

test('startup retries when the previous daemon releases its shutdown lock', async () => {
  const lock = tryLock(tedPaths(home).daemonLock)
  if (!lock) throw new Error('Could not hold the shutdown lock')
  const result = withDaemon(home, (client) => client.listTasks(), { startTimeoutMs: 10_000 }).then(
    (tasks) => ({ tasks }),
    (error: Error) => ({ error: error.message }),
  )
  try {
    await waitUntil(async () => {
      const log = await readFile(tedPaths(home).daemonLog, 'utf8').catch(() => '')
      return log.includes('TED’s daemon is already running')
    }, 'the new daemon to encounter the shutdown lock')
  } finally {
    lock.release()
  }
  expect(await result).toEqual({ tasks: [] })
})

test('a crashed daemon is restarted at once, and the new one serves requests and events', async () => {
  const supervised = await supervise()
  expect(supervised.connection.state).toBe('connected')

  const old = await crash()
  await connectedAgain(1)

  expect(states).toEqual(['reconnecting', 'connected'])
  const info = await readDaemonInfo(home)
  expect(info?.pid).not.toBe(old)
  await supervised.client.createTask({ title: 'Fix login' })
  await waitUntil(() => events.some((e) => e.type === 'task-created'), 'a task-created event')
})

test('after three crashes in ten minutes the supervisor stops restarting until asked', async () => {
  const supervised = await supervise()

  await crash()
  await connectedAgain(1)
  await crash()
  await connectedAgain(2)
  const last = await crash()
  await waitUntil(() => supervised.connection.state === 'stopped', 'the supervisor to stop')
  await sleep(500)

  expect(states).toEqual(['reconnecting', 'connected', 'reconnecting', 'connected', 'stopped'])
  expect((await readDaemonInfo(home))?.pid).toBe(last)
  const stopped = supervised.connection
  expect(stopped.state === 'stopped' && stopped.crashes).toHaveLength(3)

  await supervised.restart()

  expect(supervised.connection.state).toBe('connected')
  expect(await supervised.client.listTasks()).toEqual([])
})

test('crashes older than the window don’t count toward stopping', async () => {
  const supervised = await supervise({ crashWindowMs: 300 })

  for (let i = 1; i <= 3; i++) {
    await sleep(350)
    await crash()
    await connectedAgain(i)
  }

  expect(supervised.connection.state).toBe('connected')
})

test('a daemon that won’t start is tried at once, then after each delay, then given up on', async () => {
  const supervised = await supervise()
  await crash()
  await rm(tedPaths(home).daemonLock, { force: true })
  await mkdir(tedPaths(home).daemonLock)

  await waitUntil(() => supervised.connection.state === 'stopped', 'the supervisor to stop', 20_000)

  expect(states).toEqual(['reconnecting', 'stopped'])
  const output = await readFile(tedPaths(home).daemonOutput, 'utf8')
  expect(output.match(/starting TED’s daemon/g)).toHaveLength(4)
})

const fileTokenClient = async () => {
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  return new DaemonClient(info)
}

test('the app’s token lives only in its memory; daemon.json’s token can’t change settings', async () => {
  const supervised = await supervise({ app: true })

  expect(await supervised.client.caller()).toMatchObject({ kind: 'app' })
  await supervised.client.updateSettings({ maxWorkingRuns: 3 })
  const file = await fileTokenClient()
  expect(await file.caller()).toEqual({ kind: 'file' })
  await expect(file.updateSettings({ maxWorkingRuns: 99 })).rejects.toMatchObject({
    status: 403,
    message: 'only the TED app can do this',
  })
})

test('a daemon the supervisor restarts after a crash still knows the app', async () => {
  const supervised = await supervise({ app: true })

  await crash()
  await connectedAgain(1)

  expect(await supervised.client.caller()).toMatchObject({ kind: 'app' })
  await supervised.client.updateSettings({ maxWorkingRuns: 4 })
})

test('the app takes over a daemon it didn’t start, and the new daemon knows only the app', async () => {
  const cliDaemon = await withDaemon(home, async (client) => {
    expect(await client.caller()).toEqual({ kind: 'file' })
    return readDaemonInfo(home)
  })

  const supervised = await supervise({ app: true })

  expect((await readDaemonInfo(home))?.pid).not.toBe(cliDaemon?.pid)
  await waitUntil(() => !isAlive(cliDaemon?.pid ?? 0), 'the old daemon to exit')
  expect(await supervised.client.caller()).toMatchObject({ kind: 'app' })
  expect(await (await fileTokenClient()).caller()).toEqual({ kind: 'file' })
  expect(states).toEqual([])
})

async function fakeDaemon(status: number, body: unknown, holdLock: boolean) {
  const fake = spawn(
    process.execPath,
    [
      '-e',
      `const http = require('node:http')
      const { DatabaseSync } = require('node:sqlite')
      if (${holdLock}) new DatabaseSync(${JSON.stringify(tedPaths(home).daemonLock)}).exec('BEGIN EXCLUSIVE')
      const server = http.createServer((req, res) => {
        console.log(JSON.stringify([req.method, req.url, req.headers.authorization]))
        res.writeHead(${status}, { 'content-type': 'application/json' })
        res.end(${JSON.stringify(JSON.stringify(body))})
      })
      server.listen(0, '127.0.0.1', () => console.log(server.address().port))
      process.on('SIGTERM', () => process.exit(0))`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  fakes.push(fake)
  const lines: string[] = []
  fake.stdout.setEncoding('utf8').on('data', (chunk: string) => lines.push(...chunk.split('\n')))
  const port = Number(await waitUntil(() => lines.find((l) => /^\d+$/.test(l)), 'the fake daemon'))
  const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  fakes.push(decoy)
  const pid = holdLock ? (fake.pid ?? 0) : (decoy.pid ?? 0)
  await mkdir(home, { recursive: true })
  await writeFile(
    tedPaths(home).daemonInfo,
    JSON.stringify({ port, token: 'file-token', pid, version: '0.0.1' }),
  )
  const requests = () =>
    lines.flatMap((l) => (l.startsWith('[') ? [JSON.parse(l) as [string, string, string]] : []))
  return { fake, decoy, requests }
}

test('a daemon too old to keep Runs on /shutdown is stopped with SIGTERM instead', async () => {
  const { fake, requests } = await fakeDaemon(404, { error: 'not found' }, true)
  const exited = once(fake, 'exit')

  const supervised = await supervise({ app: true })

  expect(await exited).toEqual([0, null])
  expect(requests().some(([method, url]) => method === 'POST' && url === '/shutdown')).toBe(false)
  expect(await supervised.client.caller()).toMatchObject({ kind: 'app' })
})

test('the app never sends its key to a server that only claims to be the daemon', async () => {
  const appToken = 'a'.repeat(64)
  const { decoy, requests } = await fakeDaemon(200, { kind: 'app' }, false)

  const supervised = await supervise({ app: true, appToken })

  expect(await supervised.client.caller()).toMatchObject({ kind: 'app' })
  expect(requests().length).toBeGreaterThan(0)
  expect(requests().some(([, , auth]) => auth?.includes(appToken))).toBe(false)
  expect(isAlive(decoy.pid ?? 0)).toBe(true)
})

test('a server that answers 404 is not signalled unless it holds the daemon lock', async () => {
  const { decoy } = await fakeDaemon(404, { error: 'not found' }, false)

  const supervised = await supervise({ app: true })

  expect(await supervised.client.caller()).toMatchObject({ kind: 'app' })
  expect(isAlive(decoy.pid ?? 0)).toBe(true)
})

test('handing over for an update stops the daemon without a crash, and a Run keeps going into the next daemon', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'ted-update-cwd-'))
  const before = process.env.TED_CLAUDE_BIN
  process.env.TED_CLAUDE_BIN = stubClaudePath
  try {
    const release = path.join(cwd, 'release')
    const supervised = await supervise({ app: true, appToken: testAppToken })
    const info = await waitUntil(() => readDaemonInfo(home), 'daemon.json')
    let client = api(info.port, { appKey: testAppToken })
    const run = await client.startRun(
      [
        { lines: 20, everyMs: 50 },
        { waitFor: release },
        { say: 'after update' },
        { endTurn: true },
      ],
      cwd,
    )
    await waitUntil(
      async () =>
        assistantTexts((await client.getRun(run.id)).conversation).length >= 3 || undefined,
      'some output',
    )

    const seen: { checks: number; merges: number }[] = []
    await supervised.handOver({ onWork: (work) => seen.push(work) })

    expect(isAlive(info.pid)).toBe(false)
    expect(states).toEqual([])
    expect(seen).toEqual([{ checks: 0, merges: 0 }])
    const host = (await hostRecords(home, run.id)).find((r) => r.t === 'start')
    expect(isAlive(Number(host?.hostPid))).toBe(true)

    supervisor = await supervise({ app: true, appToken: testAppToken })
    const next = await waitUntil(() => readDaemonInfo(home), 'the new daemon.json')
    expect(next.pid).not.toBe(info.pid)
    client = api(next.port, { appKey: testAppToken })
    await writeFile(release, '')
    const done = await waitUntil(async () => {
      const r = await client.getRun(run.id)
      return r.run.state === 'idle' ? r : undefined
    }, 'the Run to go idle in the new daemon')
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
    expect(assistantTexts(done.conversation)).toEqual([...lines, 'after update'])
    expect((await hostRecords(home, run.id)).filter((r) => r.t === 'start')).toHaveLength(1)
  } finally {
    if (before === undefined) delete process.env.TED_CLAUDE_BIN
    else process.env.TED_CLAUDE_BIN = before
    await killRunHosts(home)
    await rm(cwd, { recursive: true, force: true })
  }
})

test('after a hand-over whose install failed, the supervisor starts a daemon again', async () => {
  const supervised = await supervise({ app: true })
  const old = await readDaemonInfo(home)
  await supervised.handOver()
  expect(isAlive(old?.pid ?? 0)).toBe(false)

  await supervised.resume()

  expect(supervised.connection.state).toBe('connected')
  expect(states).toEqual(['reconnecting', 'connected'])
  expect(await supervised.client.caller()).toMatchObject({ kind: 'app' })
  expect((await readDaemonInfo(home))?.pid).not.toBe(old?.pid)
})

test('waiting before an update reports the work left and stops at the limit', async () => {
  const reads = [
    { checks: 2, merges: 1 },
    { checks: 1, merges: 0 },
    { checks: 0, merges: 0 },
  ]
  const seen: unknown[] = []
  expect(
    await finishWork({
      read: async () => reads.shift() ?? { checks: 0, merges: 0 },
      onWork: (work) => seen.push(work),
      pollMs: 1,
      maxWaitMs: 10_000,
    }),
  ).toBe('finished')
  expect(seen).toEqual([
    { checks: 2, merges: 1 },
    { checks: 1, merges: 0 },
    { checks: 0, merges: 0 },
  ])

  expect(
    await finishWork({
      read: async () => ({ checks: 1, merges: 0 }),
      onWork: () => undefined,
      pollMs: 5,
      maxWaitMs: 30,
    }),
  ).toBe('timed-out')
})

test('the daemon writes its log to TED’s logs folder', async () => {
  await supervise()

  await waitUntil(
    async () =>
      /info TED daemon .* listening on 127\.0\.0\.1:\d+/.test(
        await readFile(tedPaths(home).daemonLog, 'utf8'),
      ),
    'the listening line in daemon.log',
  )
})
