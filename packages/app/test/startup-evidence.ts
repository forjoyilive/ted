import { execFile } from 'node:child_process'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { DaemonClient, readDaemonInfo } from '@ted/protocol'
import type { ElectronApplication } from 'playwright'
import { redactSecrets } from '../../daemon/src/redact.ts'

const execute = promisify(execFile)
const maxText = 16_384
const launches = new WeakMap<
  ElectronApplication,
  {
    home: string
    started: number
    events: { ms: number; event: string }[]
    stderr: string
    snapshot?: Promise<string | undefined>
  }
>()

async function bounded<T>(work: Promise<T>): Promise<T | 'unavailable'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<'unavailable'>((resolve) => {
        timer = setTimeout(() => resolve('unavailable'), 1500)
      }),
    ])
  } catch {
    return 'unavailable'
  } finally {
    clearTimeout(timer)
  }
}

async function tail(file: string): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const data = Buffer.alloc(Math.min(size, maxText))
    await handle.read(data, 0, data.length, Math.max(0, size - data.length))
    return redactSecrets(data.toString('utf8'))
  } finally {
    await handle.close()
  }
}

export function observeStartup(app: ElectronApplication, home: string): void {
  const state = { home, started: performance.now(), events: [], stderr: '' }
  launches.set(app, state)
  const child = app.process()
  const event = (name: string) => {
    const launch = launches.get(app)
    if (launch && launch.events.length < 32)
      launch.events.push({ ms: performance.now() - launch.started, event: name })
  }
  event('launch-resolved')
  const stderr = (data: Buffer) => {
    state.stderr = (state.stderr + data.toString('utf8')).slice(-maxText)
  }
  child.stderr?.on('data', stderr)
  child.once('exit', () => event('process-exit'))
  app.on('window', () => event('playwright-window'))
  app.once('close', () => {
    event('transport-closed')
    child.stderr?.off('data', stderr)
  })
}

export const startupHome = (app: ElectronApplication): string | undefined => launches.get(app)?.home

export async function captureStartup(app: ElectronApplication): Promise<string | undefined> {
  const state = launches.get(app)
  if (!state) return undefined
  state.snapshot ??= (async () => {
    const child = app.process()
    const info = await bounded(readDaemonInfo(state.home))
    const daemon = info === 'unavailable' ? undefined : info
    const pids = [child.pid, daemon?.pid].filter((pid) => pid !== undefined)
    const window = app.windows()[0]
    const [processes, native, data, milestones, renderer] = await Promise.all([
      bounded(
        execute('ps', ['-o', 'pid,ppid,stat,pcpu,time', '-p', pids.join(',')], {
          timeout: 1000,
          maxBuffer: maxText,
        }).then(({ stdout }) => stdout),
      ),
      bounded(
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((window) => ({
            id: window.id,
            loading: window.webContents.isLoading(),
            destroyed: window.isDestroyed(),
          })),
        ),
      ),
      daemon
        ? bounded(
            new DaemonClient(daemon, daemon.token, { idleTimeoutMs: 1000 })
              .getDataStatus()
              .then(({ state }) => state),
          )
        : Promise.resolve('no-daemon-info'),
      bounded(tail(path.join(state.home, 'logs', 'app-startup.log'))),
      window
        ? bounded(window.locator('[data-loaded]').getAttribute('data-loaded', { timeout: 1000 }))
        : Promise.resolve('no-playwright-window'),
    ])
    const file = path.join(state.home, 'logs', 'test-startup.json')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(
      file,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          elapsedSinceLaunchResolvedMs: performance.now() - state.started,
          electron: { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode },
          daemon: {
            infoRead: info === 'unavailable' ? 'unavailable' : daemon ? 'present' : 'absent',
            infoPresent: daemon !== undefined,
            pid: daemon?.pid,
            data,
          },
          machine: {
            logicalCpus: availableParallelism(),
            loadavg: loadavg(),
            freemem: freemem(),
            totalmem: totalmem(),
          },
          processes,
          native,
          playwrightWindows: app.windows().length,
          rendererLoaded: renderer,
          events: state.events,
          milestones,
          stderr: redactSecrets(state.stderr),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    return file
  })().catch(() => undefined)
  return state.snapshot
}
