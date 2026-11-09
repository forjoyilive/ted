import { mkdir, readFile, rm } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { DaemonClient, type DaemonEvent, readDaemonInfo, tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type DaemonConnection, type DaemonSupervisor, superviseDaemon } from '../src/launch.ts'
import { isAlive, makeTempHome, waitUntil } from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let supervisor: DaemonSupervisor | undefined
let states: DaemonConnection['state'][]
let events: DaemonEvent[]

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  states = []
  events = []
})

afterEach(async () => {
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
