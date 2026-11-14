import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { stopDaemonIn } from '../../daemon/test/helpers.ts'
import { buildRenderer } from '../test/build-renderer.ts'
import { closeApp } from '../test/close-app.ts'
import { loadedWindow } from '../test/first-window.ts'
import { prepareElectron } from '../test/support/electron-installation.ts'
import { sandboxRefusal } from './sandbox-refusal.ts'

export interface WithAppOptions {
  home: string
  env?: NodeJS.ProcessEnv
  build?: boolean
}

export async function withApp<T>(
  options: WithAppOptions,
  use: (app: ElectronApplication, window: Page) => Promise<T>,
): Promise<T> {
  const refusal = sandboxRefusal()
  if (refusal) throw new Error(refusal)
  const home = path.resolve(options.home)
  await mkdir(home, { recursive: true })
  if (options.build !== false) await buildRenderer()
  const app = await electron.launch({
    executablePath: await prepareElectron(),
    args: [fileURLToPath(new URL('..', import.meta.url))],
    env: { ...process.env, TED_HOME: home, TED_HIDDEN_WINDOW: '1', ...options.env },
    timeout: 120_000,
  })
  const pid = app.process().pid
  const killNow = () => {
    if (pid === undefined) return
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL')
      } catch {}
    }
  }
  const interrupted = (signal: NodeJS.Signals) => {
    killNow()
    process.kill(process.pid, signal)
  }
  process.once('exit', killNow)
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  try {
    return await use(app, await loadedWindow(app))
  } finally {
    await closeApp(app)
    await stopDaemonIn(home)
    process.off('exit', killNow)
    process.off('SIGINT', interrupted)
    process.off('SIGTERM', interrupted)
  }
}
