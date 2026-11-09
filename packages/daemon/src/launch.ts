import { type ChildProcess, spawn } from 'node:child_process'
import { appendFile, mkdir, open } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  DaemonClient,
  type DaemonEvent,
  DaemonUnreachableError,
  readDaemonInfo,
  type Subscription,
  tedPaths,
} from '@ted/protocol'
import { inheritedFdsEnv } from './inherited-fds.ts'
import { rollLog, tedLogLimits } from './logs.ts'

export { crashReport } from './logs.ts'

const startTimeoutMs = 2 * 60_000
const retryDelayMs = 100

export class DaemonDidNotStartError extends Error {}

export async function withDaemon<T>(
  home: string,
  call: (client: DaemonClient) => Promise<T>,
  options: { startTimeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.startTimeoutMs ?? startTimeoutMs
  const deadline = Date.now() + timeoutMs
  let child: ChildProcess | undefined
  for (;;) {
    const info = await readDaemonInfo(home)
    if (info) {
      try {
        return await call(new DaemonClient(info, process.env.TED_RUN_TOKEN || info.token))
      } catch (error) {
        if (!(error instanceof DaemonUnreachableError)) throw error
      }
    }
    if (!child) child = await startDaemon(home)
    else if (exited(child) && !(await anotherDaemonStarting(home))) {
      throw new DaemonDidNotStartError(
        `TED's daemon stopped as it started; see ${tedPaths(home).daemonOutput}`,
      )
    }
    if (Date.now() > deadline) {
      throw new DaemonDidNotStartError(
        `TED's daemon didn't start within ${Math.round(timeoutMs / 1000)} seconds; see ${tedPaths(home).daemonLog}`,
      )
    }
    await sleep(retryDelayMs)
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

async function startDaemon(home: string): Promise<ChildProcess> {
  const paths = tedPaths(home)
  await mkdir(paths.home, { recursive: true, mode: 0o700 })
  await mkdir(paths.logs, { recursive: true, mode: 0o700 })
  await rollLog(paths.daemonOutput, tedLogLimits)
  await appendFile(paths.daemonOutput, `${new Date().toISOString()} starting TED’s daemon\n`, {
    mode: 0o600,
  })
  const output = await open(paths.daemonOutput, 'a')
  const daemonMain = fileURLToPath(new URL('./main.ts', import.meta.url))
  // Under Electron, process.execPath is the Electron binary; plain Node ignores the variable.
  const child = spawn(process.execPath, [daemonMain, '--exit-when-idle'], {
    detached: true,
    stdio: ['ignore', output.fd, output.fd],
    env: { ...process.env, TED_HOME: home, ELECTRON_RUN_AS_NODE: '1', ...inheritedFdsEnv() },
  })
  child.unref()
  await output.close()
  return child
}

export type DaemonConnection =
  | { state: 'connected' }
  | { state: 'reconnecting' }
  | { state: 'stopped'; crashes: string[] }

export interface DaemonSupervisor {
  readonly client: DaemonClient
  readonly connection: DaemonConnection
  restart(): Promise<void>
  close(): void
}

export interface SuperviseOptions {
  onEvent: (event: DaemonEvent) => void
  onConnection: (connection: DaemonConnection) => void
  app?: boolean
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
    restartDelaysMs = daemonRestartDelaysMs,
    crashWindowMs = 10 * 60_000,
    crashLimit = 3,
    restartTimeoutMs = 30_000,
  }: SuperviseOptions,
): Promise<DaemonSupervisor> {
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
      timeoutMs === undefined ? {} : { startTimeoutMs: timeoutMs },
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
    close() {
      closed = true
      subscription.close()
    },
  }
}
