import { spawn } from 'node:child_process'
import { mkdir, open } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { DaemonClient, DaemonUnreachableError, readDaemonInfo, tedPaths } from '@ted/protocol'

const startTimeoutMs = 2 * 60_000
const retryDelayMs = 100

export async function withDaemon<T>(
  home: string,
  call: (client: DaemonClient) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + startTimeoutMs
  let started = false
  for (;;) {
    const info = await readDaemonInfo(home)
    if (info) {
      try {
        return await call(new DaemonClient(info))
      } catch (error) {
        if (!(error instanceof DaemonUnreachableError)) throw error
      }
    }
    if (!started) {
      await startDaemon(home)
      started = true
    }
    if (Date.now() > deadline) {
      throw new Error(`TED's daemon didn't start within 2 minutes; see ${tedPaths(home).daemonLog}`)
    }
    await sleep(retryDelayMs)
  }
}

async function startDaemon(home: string): Promise<void> {
  const paths = tedPaths(home)
  await mkdir(paths.home, { recursive: true, mode: 0o700 })
  await mkdir(paths.logs, { recursive: true })
  const log = await open(paths.daemonLog, 'a')
  const daemonMain = fileURLToPath(new URL('./main.ts', import.meta.url))
  // Under Electron, process.execPath is the Electron binary; plain Node ignores the variable.
  const child = spawn(process.execPath, [daemonMain, '--exit-when-idle'], {
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
    env: { ...process.env, TED_HOME: home, ELECTRON_RUN_AS_NODE: '1' },
  })
  child.unref()
  await log.close()
}
