import { randomUUID } from 'node:crypto'
import { readdir, rename, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { executionIds } from '@ted/protocol'
import type { ExecutionCommands } from '../../src/execution/commands.ts'
import { startDaemon } from '../../src/index.ts'
import type { TedStore } from '../../src/store/index.ts'
import { openStore } from '../../src/store/index.ts'
import { createTaskExecution } from '../../src/tasks/execution.ts'
import { stubClaudePath, stubCodexPath } from '../helpers.ts'
import type { ExchangeCounts, FixtureCommand } from '../support/execution-wire.ts'

const fixtureHome = process.env.TED_HOME
if (!fixtureHome || !process.send)
  throw new Error('execution-machine requires an owned home and IPC')
const home = fixtureHome
const directory = path.join(home, 'ownership-store')
const mode = process.argv[2]
let store = mode === 'store' ? await openStore({ directory }) : undefined
let executionClockOffsetMs = 0
let freeBytes = 500e9
let load = 0
let online = true
let execution: { commands: ExecutionCommands; store: TedStore } | undefined
const daemon =
  mode === 'store'
    ? undefined
    : await startDaemon({
        home,
        execution: {
          now: () => Date.now() + executionClockOffsetMs,
          ready(api) {
            execution = api
          },
        },
        version: '9.9.9',
        claudeBin: stubClaudePath,
        codexBin: stubCodexPath,
        appToken: randomUUID(),
        checkAgentsOnStart: true,
        healthIntervalMs: 50,
        disk: {
          freeBytes: async () => freeBytes,
          checkEveryMs: 20,
          excludeFromBackups: async () => {},
        },
        load: { ratio: () => load, checkEveryMs: 20 },
        online: { isOnline: async () => online, onlineEveryMs: 20, offlineEveryMs: 20 },
        integrations: { checkOnStart: true, loginShell: false, checkEveryMs: 50 },
      })
const counts: ExchangeCounts = { executed: 0, acknowledged: 0, dropped: 0, held: 0 }
let nextAck: 'hold' | 'drop' | undefined
const sockets = new Set<net.Socket>()
const held: (() => void)[] = []
const server = net.createServer((socket) => {
  sockets.add(socket)
  socket.on('error', () => {})
  socket.once('close', () => sockets.delete(socket))
  let text = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    text += chunk
    if (text.length > 8192) return socket.destroy()
    for (;;) {
      const end = text.indexOf('\n')
      if (end < 0) break
      const line = text.slice(0, end)
      text = text.slice(end + 1)
      counts.executed++
      const acknowledge = () => {
        if (!socket.destroyed) {
          socket.write(`${line}\n`)
          counts.acknowledged++
        }
      }
      const policy = nextAck
      nextAck = undefined
      if (policy === 'hold') {
        counts.held++
        held.push(() => {
          counts.held--
          acknowledge()
        })
      } else if (policy === 'drop') counts.dropped++
      else acknowledge()
    }
  })
})
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('no fixture socket')
process.send({
  ready: {
    port: daemon?.port ?? 0,
    exchangePort: address.port,
    appToken: daemon?.appToken ?? '',
    machineId: store?.execution.localMachineId ?? `fixture-${randomUUID()}`,
  },
})

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  for (const release of held.splice(0)) release()
  for (const socket of sockets) socket.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await daemon?.stop()
  await store?.close()
}

async function execute(command: FixtureCommand): Promise<unknown> {
  if (command.action === 'stop') {
    await stop()
    return true
  }
  if (command.action === 'counts') return counts
  if (command.action === 'control') {
    const c = command.changes
    if (c.executionClockOffsetMs !== undefined) executionClockOffsetMs = c.executionClockOffsetMs
    if (c.freeBytes !== undefined) freeBytes = c.freeBytes
    if (c.load !== undefined) load = c.load
    if (c.online !== undefined) online = c.online
    if (c.signedIn !== undefined) {
      for (const agent of ['claude', 'codex']) {
        await writeFile(
          path.join(home, `stub-${agent}.json.tmp`),
          JSON.stringify({ signedIn: c.signedIn }),
        )
        await rename(
          path.join(home, `stub-${agent}.json.tmp`),
          path.join(home, `stub-${agent}.json`),
        )
      }
    }
    if (c.acknowledgment === 'release') for (const release of held.splice(0)) release()
    else if (c.acknowledgment) nextAck = c.acknowledgment
    return counts
  }
  if (
    command.action === 'assign-remote' ||
    command.action === 'issue' ||
    command.action === 'inject' ||
    command.action === 'stop-operation' ||
    command.action === 'operation' ||
    command.action === 'operations'
  ) {
    if (!execution) throw new Error('execution commands require daemon mode')
    if (command.action === 'assign-remote') {
      const receipt = createTaskExecution(execution.store).assign({
        taskId: command.taskId,
        machineId: executionIds.machine(command.machineId),
        assignmentId: executionIds.assignment(randomUUID()),
        reservationId: executionIds.reservation(randomUUID()),
        operationId: executionIds.operation(randomUUID()),
        expectedGeneration: 0,
      })
      await execution.store.persisted()
      return receipt
    }
    if (command.action === 'issue') return execution.commands.issue(command.input)
    if (command.action === 'inject') {
      execution.store.operations.issue(command.command)
      await execution.store.persisted()
      return true
    }
    if (command.action === 'stop-operation') {
      await execution.commands.stop(command.id)
      return true
    }
    if (command.action === 'operation') return execution.commands.operation(command.id) ?? null
    return execution.store.operations.forTask(command.taskId)
  }
  if (!store) throw new Error('ownership commands require store mode')
  if (command.action === 'create') return store.createTask({ title: 'Synthetic ownership fixture' })
  if (command.action === 'assign') {
    const receipt = createTaskExecution(store).assign(command.input)
    await store.persisted()
    return receipt
  }
  if (command.action === 'local') return createTaskExecution(store).local(command.taskId)
  if (command.action === 'require') return createTaskExecution(store).require(command.assignment)
  await store.persisted()
  await store.close()
  for (const name of await readdir(path.join(directory, 'ted'))) {
    if (name.startsWith('state')) await rm(path.join(directory, 'ted', name), { force: true })
  }
  store = await openStore({ directory })
  return { machineId: store.execution.localMachineId }
}

let queue = Promise.resolve()
process.on('message', (message: { id: number; command: FixtureCommand }) => {
  queue = queue.then(async () => {
    try {
      const value = await execute(message.command)
      process.send?.({ id: message.id, value }, () => {
        if (message.command.action === 'stop') process.exit(0)
      })
    } catch (error) {
      process.send?.({ id: message.id, error: String(error) })
    }
  })
})
process.on('disconnect', () => {
  void stop().finally(() => process.exit(0))
})
process.on('SIGTERM', () => {
  void stop().finally(() => process.exit(0))
})
