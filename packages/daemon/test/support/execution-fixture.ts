import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { appendFile, lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DaemonClient } from '@ted/protocol'
import { nodeEntry } from '../../src/node-entry.ts'
import { redactSecrets } from '../../src/redact.ts'
import { fixtureEnvironment, makeOriginRepo, waitUntil } from '../helpers.ts'
import { eventWait } from './event-wait.ts'
import { ExecutionDiagnostics } from './execution-diagnostics.ts'
import { createGhFixture } from './execution-gh.ts'
import type {
  ExchangeCounts,
  FixtureCommand,
  FixtureControl,
  FixtureReady,
} from './execution-wire.ts'
import { findMarked, killMarked } from './processes.ts'

export async function removeFixtureRoot(root: string): Promise<void> {
  const stat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (!stat) return
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(root)) !== root ||
    !path.basename(root).startsWith('ted-execution-')
  ) {
    throw new Error('refusing to remove an unowned fixture root')
  }
  await rm(root, { recursive: true, force: true })
}

export async function createExecutionFixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'ted-execution-')))
  const machines: FixtureMachine[] = []
  let closed = false
  return {
    root,
    async machine(
      name: 'controller' | 'executor',
      mode: 'daemon' | 'store' = 'daemon',
      timeoutMs = 30_000,
    ) {
      if (closed) throw new Error('fixture closed')
      const machine = new FixtureMachine(
        await realpath(await mkdtemp(path.join(root, 'ted-execution-'))),
        name,
        mode,
      )
      machines.push(machine)
      try {
        await machine.prepare()
        await machine.start(timeoutMs)
        return machine
      } catch (error) {
        await machine.close()
        throw error
      }
    },
    async close() {
      closed = true
      const results = await Promise.allSettled(machines.map((m) => m.close()))
      const failed = results.find((r) => r.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      await removeFixtureRoot(root)
    },
  }
}

export class FixtureMachine {
  readonly root: string
  readonly home: string
  readonly name: string
  readonly mode: 'daemon' | 'store'
  origin = ''
  ready: FixtureReady | undefined
  child: ChildProcess | undefined
  #diagnostics = new ExecutionDiagnostics()
  get diagnostic() {
    return this.#diagnostics.text
  }
  gh: Awaited<ReturnType<typeof createGhFixture>> | undefined
  #events = new EventEmitter()
  #next = 0
  #closed = false
  #links: FixtureExchange[] = []
  #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()

  constructor(root: string, name: string, mode: 'daemon' | 'store') {
    this.root = root
    this.home = path.join(root, 'home')
    this.name = name
    this.mode = mode
  }
  get pid() {
    return this.child?.pid
  }
  get port() {
    return this.ready?.port
  }
  get client() {
    if (!this.ready) throw new Error('machine not ready')
    return new DaemonClient(
      { port: this.ready.port, token: '', pid: this.pid ?? 0, version: '9.9.9' },
      '',
      { appKey: this.ready.appToken, idleTimeoutMs: 10_000 },
    )
  }
  async prepare() {
    await mkdir(this.home)
    this.gh = await createGhFixture(this.home)
    this.origin = await makeOriginRepo(this.root, fixtureEnvironment(this.home))
  }
  async start(timeoutMs = 30_000) {
    if (this.#closed) throw new Error('machine closed')
    if (this.child) throw new Error('machine already started')
    this.ready = undefined
    const env = fixtureEnvironment(this.home)
    const entry = nodeEntry(
      fileURLToPath(new URL('../fixtures/execution-machine.ts', import.meta.url)),
      [this.mode],
      env,
    )
    const child = spawn(entry.command, entry.args, {
      cwd: this.root,
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.#diagnostics.push(chunk))
    child.stderr?.on('data', (chunk: string) => this.#diagnostics.push(chunk))
    child.on(
      'message',
      (message: { ready?: FixtureReady; id?: number; value?: unknown; error?: string }) => {
        if (message.ready) {
          this.ready = message.ready
          this.#events.emit('changed')
        }
        if (message.id !== undefined) {
          const pending = this.#pending.get(message.id)
          if (!pending) return
          this.#pending.delete(message.id)
          clearTimeout(pending.timer)
          if (message.error) pending.reject(new Error(redactSecrets(message.error)))
          else pending.resolve(message.value)
        }
      },
    )
    let failure: Error | undefined
    child.on('error', (error) => {
      failure = error
      this.#events.emit('changed')
    })
    child.once('exit', () => {
      failure = new Error(`fixture process exited: ${redactSecrets(this.diagnostic)}`)
      for (const p of this.#pending.values()) {
        clearTimeout(p.timer)
        p.reject(failure)
      }
      this.#pending.clear()
      this.ready = undefined
      this.#events.emit('changed')
    })
    try {
      await eventWait(
        (changed) => {
          this.#events.on('changed', changed)
          return () => this.#events.off('changed', changed)
        },
        () => {
          if (failure) throw failure
          return this.ready
        },
        'fixture readiness',
        timeoutMs,
      )
    } catch (error) {
      await this.kill()
      throw error
    }
  }
  rpc<T = unknown>(command: FixtureCommand, timeoutMs = 20_000): Promise<T> {
    const child = this.child
    if (!child?.connected) return Promise.reject(new Error('machine disconnected'))
    return new Promise<T>((resolve, reject) => {
      const id = ++this.#next
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`timed out: ${command.action}`))
      }, timeoutMs)
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      child.send({ id, command }, (error) => {
        if (error) {
          clearTimeout(timer)
          this.#pending.delete(id)
          reject(error)
        }
      })
    })
  }
  async control(changes: FixtureControl) {
    const result = await this.rpc<ExchangeCounts>({ action: 'control', changes })
    if (changes.signedIn !== undefined && this.mode === 'daemon')
      await this.client.checkAgentHealth()
    return result
  }
  barrier(expected: Partial<ExchangeCounts>, timeoutMs = 20_000) {
    return waitUntil(
      async () => {
        const counts = await this.rpc<ExchangeCounts>(
          { action: 'counts' },
          Math.min(timeoutMs, 1000),
        )
        return Object.entries(expected).every(
          ([key, value]) => counts[key as keyof ExchangeCounts] === value,
        )
          ? counts
          : undefined
      },
      `exchange counts ${JSON.stringify(expected)}`,
      timeoutMs,
    )
  }
  async exchange() {
    if (!this.ready) throw new Error('machine not ready')
    const link = new FixtureExchange(this.ready.exchangePort)
    this.#links.push(link)
    await link.connect()
    return link
  }
  async agentStarts(): Promise<number> {
    const { glob } = await import('node:fs/promises')
    let count = 0
    for await (const file of glob('worktrees/**/stub-starts.jsonl', { cwd: this.home })) {
      count += (await readFile(path.join(this.home, file), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean).length
    }
    return count
  }
  async kill() {
    const child = this.child
    if (!child) return
    if (child.pid === undefined) {
      this.child = undefined
      this.ready = undefined
      return
    }
    const exited = child.exitCode !== null || child.signalCode !== null
    if (!exited) {
      await eventWait(
        (changed) => {
          child.once('exit', changed)
          return () => child.off('exit', changed)
        },
        () => {
          child.kill('SIGKILL')
          return child.exitCode !== null || child.signalCode !== null
        },
        'fixture process exit',
        10_000,
      )
    }
    this.child = undefined
    this.ready = undefined
  }
  async close() {
    if (this.#closed) return
    for (const link of this.#links) await link.disconnect()
    if (this.child?.connected) await this.rpc({ action: 'stop' }, 5000).catch(() => undefined)
    await this.kill()
    await killMarked('TED_HOME', this.home)
    if ((await findMarked('TED_HOME', this.home)).length)
      throw new Error('owned fixture processes remain after cleanup')
    const evidence = process.env.TED_VALIDATION_DIAGNOSTICS
    if (evidence)
      await appendFile(
        evidence,
        `${this.name} (${this.mode})
${this.diagnostic}
`,
      )
    await removeFixtureRoot(this.root)
    this.#closed = true
  }
}

class FixtureExchange {
  readonly port: number
  received = 0
  #socket: net.Socket | undefined
  #pending = new Map<
    string,
    { resolve: (value: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  constructor(port: number) {
    this.port = port
  }
  async connect() {
    if (this.#socket) throw new Error('exchange already connected')
    const socket = net.createConnection({ host: '127.0.0.1', port: this.port })
    this.#socket = socket
    let text = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      text += chunk
      for (;;) {
        const end = text.indexOf('\n')
        if (end < 0) break
        const line = text.slice(0, end)
        text = text.slice(end + 1)
        const [id, value] = JSON.parse(line) as [string, string]
        const pending = this.#pending.get(id)
        if (pending) {
          clearTimeout(pending.timer)
          this.#pending.delete(id)
          this.received++
          pending.resolve(value)
        }
      }
    })
    const disconnected = () => {
      for (const p of this.#pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('exchange disconnected'))
      }
      this.#pending.clear()
    }
    socket.on('error', disconnected)
    socket.on('close', disconnected)
    await eventWait(
      (changed) => {
        socket.on('connect', changed)
        socket.on('error', changed)
        return () => {
          socket.off('connect', changed)
          socket.off('error', changed)
        }
      },
      () => {
        if (socket.destroyed) throw new Error('exchange connection failed')
        return !socket.connecting
      },
      'loopback connection',
      5000,
    )
  }
  send(value: string, timeoutMs = 5000): Promise<string> {
    const socket = this.#socket
    if (!socket || socket.destroyed) return Promise.reject(new Error('exchange disconnected'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error('acknowledgment timed out'))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      socket.write(`${JSON.stringify([id, value])}\n`)
    })
  }
  async disconnect() {
    const socket = this.#socket
    this.#socket = undefined
    if (!socket) return
    await eventWait(
      (changed) => {
        socket.once('close', changed)
        return () => socket.off('close', changed)
      },
      () => {
        socket.destroy()
        return socket.closed
      },
      'exchange disconnect',
      5000,
    )
  }
}
