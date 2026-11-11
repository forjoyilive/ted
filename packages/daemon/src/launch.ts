import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, open, rm } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  DaemonClient,
  type DaemonEvent,
  type DaemonInfo,
  DaemonRequestError,
  DaemonUnreachableError,
  filterTedEnv,
  readDaemonInfo,
  runTokenFrom,
  type Subscription,
  tedPaths,
  type UpdateWork,
} from '@ted/protocol'
import { inheritedFdsEnv } from './inherited-fds.ts'
import { rollLog, tedLogLimits } from './logs.ts'
import { nodeEntry } from './node-entry.ts'

export { watchExitWith } from './exit-with.ts'
export { crashReport } from './logs.ts'

const startTimeoutMs = 2 * 60_000
const retryDelayMs = 100

export const daemonAlreadyRunningExitCode = 75

export class DaemonDidNotStartError extends Error {}

export async function withDaemon<T>(
  home: string,
  call: (client: DaemonClient) => Promise<T>,
  options: { startTimeoutMs?: number; appToken?: string } = {},
): Promise<T> {
  const timeoutMs = options.startTimeoutMs ?? startTimeoutMs
  const deadline = Date.now() + timeoutMs
  const { appToken } = options
  let child: ChildProcess | undefined
  for (;;) {
    const info = await readDaemonInfo(home)
    if (info) {
      try {
        if (appToken === undefined) {
          return await call(new DaemonClient(info, runTokenFrom(process.env) ?? info.token))
        }
        const client = new DaemonClient(info, '', { appKey: appToken })
        if (await provesApp(client)) return await call(client)
        await handOver(home, info, deadline)
        child = undefined
        continue
      } catch (error) {
        if (!(error instanceof DaemonUnreachableError)) throw error
      }
    }
    if (!child) child = await startDaemon(home, appToken)
    else if (exited(child)) {
      if (child.exitCode === daemonAlreadyRunningExitCode) child = undefined
      else if (!(await anotherDaemonStarting(home)))
        throw new DaemonDidNotStartError(
          `TED’s daemon stopped as it started; see ${tedPaths(home).daemonOutput}`,
        )
    }
    if (Date.now() > deadline) {
      throw new DaemonDidNotStartError(
        `TED’s daemon didn’t start within ${Math.round(timeoutMs / 1000)} seconds; see ${tedPaths(home).daemonLog}`,
      )
    }
    await sleep(retryDelayMs)
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null

async function anotherDaemonStarting(home: string): Promise<boolean> {
  try {
    const { isLockHeld } = await import('./lock.ts')
    return isLockHeld(tedPaths(home).daemonLock)
  } catch {
    return false
  }
}

async function provesApp(client: DaemonClient): Promise<boolean> {
  try {
    return await client.provesAppKey()
  } catch (error) {
    if (error instanceof DaemonRequestError) return false
    throw error
  }
}

async function shutdownKeepsRuns(info: DaemonInfo): Promise<boolean> {
  try {
    await new DaemonClient(info).caller()
    return true
  } catch (error) {
    if (error instanceof DaemonRequestError && error.status === 404) return false
    return true
  }
}

async function askToStop(home: string, info: DaemonInfo): Promise<boolean> {
  if (!(await shutdownKeepsRuns(info))) return terminateLockHolder(home, info.pid)
  return new DaemonClient(info).shutdown({ keepRuns: true }).then(
    () => true,
    (error: unknown) => {
      if (error instanceof DaemonUnreachableError) return true
      if (error instanceof DaemonRequestError) return false
      throw error
    },
  )
}

async function terminateLockHolder(home: string, pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false
  const { lockHolders } = await import('./lock.ts')
  if (!(await lockHolders(tedPaths(home).daemonLock)).includes(pid)) return false
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    return false
  }
}

async function handOver(home: string, info: DaemonInfo, deadline: number): Promise<void> {
  const asked = await askToStop(home, info)
  do {
    if (Date.now() > deadline) {
      throw new DaemonDidNotStartError('TED’s daemon didn’t stop to hand over to the app')
    }
    await sleep(retryDelayMs)
  } while (asked && (await anotherDaemonStarting(home)))
  if (!(await anotherDaemonStarting(home))) await removeIfUnchanged(home, info)
}

async function removeIfUnchanged(home: string, info: DaemonInfo): Promise<void> {
  const now = await readDaemonInfo(home).catch(() => undefined)
  if (now?.port === info.port && now.pid === info.pid && now.token === info.token) {
    await rm(tedPaths(home).daemonInfo, { force: true })
  }
}

async function startDaemon(home: string, appToken?: string): Promise<ChildProcess> {
  const paths = tedPaths(home)
  await mkdir(paths.home, { recursive: true, mode: 0o700 })
  await mkdir(paths.logs, { recursive: true, mode: 0o700 })
  await rollLog(paths.daemonOutput, tedLogLimits)
  await appendFile(paths.daemonOutput, `${new Date().toISOString()} starting TED’s daemon\n`, {
    mode: 0o600,
  })
  const output = await open(paths.daemonOutput, 'a')
  const daemonMain = fileURLToPath(new URL('./main.ts', import.meta.url))
  const daemon = nodeEntry(daemonMain, [
    '--exit-when-idle',
    ...(appToken === undefined ? [] : ['--app-token-stdin']),
  ])
  // Under Electron, process.execPath is the Electron binary; plain Node ignores the variable.
  const child = spawn(daemon.command, daemon.args, {
    detached: true,
    stdio: [appToken === undefined ? 'ignore' : 'pipe', output.fd, output.fd],
    env: {
      ...filterTedEnv(process.env),
      TED_HOME: home,
      ELECTRON_RUN_AS_NODE: '1',
      ...inheritedFdsEnv(),
    },
  })
  child.stdin?.on('error', () => undefined)
  child.stdin?.end(`${appToken}\n`)
  child.unref()
  await output.close()
  return child
}

export type DaemonConnection =
  | { state: 'connected' }
  | { state: 'reconnecting' }
  | { state: 'stopped'; crashes: string[] }

export interface HandOverOptions {
  onWork?: (work: UpdateWork) => void
  maxWaitMs?: number
  pollMs?: number
}

export interface DaemonSupervisor {
  readonly client: DaemonClient
  readonly connection: DaemonConnection
  restart(): Promise<void>
  handOver(options?: HandOverOptions): Promise<void>
  resume(): Promise<void>
  close(): void
}

export const updateWaitMs = 10 * 60_000
const handOverExitMs = 30_000

export async function finishWork({
  read,
  onWork,
  maxWaitMs = updateWaitMs,
  pollMs = 1_000,
}: {
  read: () => Promise<UpdateWork>
  onWork: (work: UpdateWork) => void
  maxWaitMs?: number
  pollMs?: number
}): Promise<'finished' | 'timed-out'> {
  const deadline = Date.now() + maxWaitMs
  for (;;) {
    const work = await read()
    onWork(work)
    if (work.checks === 0 && work.merges === 0) return 'finished'
    if (Date.now() + pollMs > deadline) return 'timed-out'
    await sleep(pollMs)
  }
}

export interface SuperviseOptions {
  onEvent: (event: DaemonEvent) => void
  onConnection: (connection: DaemonConnection) => void
  app?: boolean
  appToken?: string
  restartDelaysMs?: readonly number[]
  crashWindowMs?: number
  crashLimit?: number
  restartTimeoutMs?: number
}

export const daemonRestartDelaysMs = [0, 5_000, 30_000] as const

export async function superviseDaemon(
  home: string,
  {
    onEvent,
    onConnection,
    app = false,
    appToken: givenAppToken,
    restartDelaysMs = daemonRestartDelaysMs,
    crashWindowMs = 10 * 60_000,
    crashLimit = 3,
    restartTimeoutMs = 30_000,
  }: SuperviseOptions,
): Promise<DaemonSupervisor> {
  const appToken = app ? (givenAppToken ?? randomBytes(32).toString('hex')) : undefined
  let connection: DaemonConnection = { state: 'connected' }
  let crashes: number[] = []
  let closed = false
  let client: DaemonClient
  let subscription: Subscription

  const set = (next: DaemonConnection) => {
    connection = next
    if (!closed) onConnection(next)
  }

  const stop = () =>
    set({ state: 'stopped', crashes: crashes.map((t) => new Date(t).toISOString()) })

  async function connect(timeoutMs?: number): Promise<void> {
    ;[client, subscription] = await withDaemon(
      home,
      async (c) => [c, await c.subscribe(onEvent, { app, onClose: onCrash })] as const,
      {
        ...(timeoutMs !== undefined && { startTimeoutMs: timeoutMs }),
        ...(appToken !== undefined && { appToken }),
      },
    )
  }

  async function reconnect(): Promise<void> {
    set({ state: 'reconnecting' })
    for (const delay of restartDelaysMs) {
      await sleep(delay)
      if (closed) return
      try {
        await connect(restartTimeoutMs)
        if (closed) {
          subscription.close()
          return
        }
        set({ state: 'connected' })
        return
      } catch (error) {
        console.error('couldn’t restart TED’s daemon:', error)
      }
    }
    stop()
  }

  function onCrash(): void {
    if (closed) return
    const now = Date.now()
    crashes = [...crashes.filter((t) => now - t < crashWindowMs), now]
    if (crashes.length >= crashLimit) stop()
    else void reconnect()
  }

  await connect()

  return {
    get client() {
      return client
    },
    get connection() {
      return connection
    },
    async restart() {
      if (connection.state !== 'stopped') return
      crashes = []
      await reconnect()
    },
    async handOver({ onWork = () => undefined, maxWaitMs, pollMs } = {}) {
      if (connection.state === 'connected') {
        await finishWork({
          read: () => client.updateWork(),
          onWork,
          ...(maxWaitMs !== undefined && { maxWaitMs }),
          ...(pollMs !== undefined && { pollMs }),
        })
      }
      closed = true
      subscription.close()
      const info = await readDaemonInfo(home)
      if (!info) return
      await client.shutdown({ keepRuns: true }).catch((error: unknown) => {
        if (!(error instanceof DaemonUnreachableError)) throw error
      })
      const deadline = Date.now() + handOverExitMs
      while ((await anotherDaemonStarting(home)) || running(info.pid)) {
        if (Date.now() > deadline) throw new Error('TED’s daemon didn’t stop for the update')
        await sleep(retryDelayMs)
      }
      await removeIfUnchanged(home, info)
    },
    async resume() {
      if (!closed) return
      closed = false
      crashes = []
      await reconnect()
    },
    close() {
      closed = true
      subscription.close()
    },
  }
}
