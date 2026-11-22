import { type SpawnOptions, spawn } from 'node:child_process'
import { type EventEmitter, once } from 'node:events'
import type { Readable } from 'node:stream'
import type { DemoManifest } from '@ted/daemon/demo'

export interface SampleDataLauncher {
  home: string
  executable: string
  appArgs: string[]
  seedScript: string
  checkHome: (home: string) => Promise<DemoManifest | undefined>
  environment: (home: string) => NodeJS.ProcessEnv
  run?: (command: string, args: string[], options: SpawnOptions) => StartedProcess
}

export interface StartedProcess extends EventEmitter {
  stderr: Readable | null
  unref: () => void
}

// Prepares the sample data in a process of its own when it isn’t ready, then opens it as a
// second Ted with its own home, window and daemon, so the person’s own Ted is never touched.
export async function openSampleData(launcher: SampleDataLauncher): Promise<void> {
  const run = launcher.run ?? spawn
  const environment = launcher.environment(launcher.home)
  const known = await launcher.checkHome(launcher.home)
  if (!known?.complete) {
    const seed = run(launcher.executable, [launcher.seedScript, ...(known ? ['--reset'] : [])], {
      env: { ...environment, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const errors: Buffer[] = []
    seed.stderr?.on('data', (chunk: Buffer) => errors.push(chunk))
    const [code] = await once(seed, 'exit')
    if (code !== 0) {
      const detail = Buffer.concat(errors).toString('utf8').trim().split('\n').at(-1)
      throw new Error(`Couldn’t prepare the sample data${detail ? `: ${detail}` : '.'}`)
    }
  }
  const opened = run(launcher.executable, launcher.appArgs, {
    env: environment,
    detached: true,
    stdio: 'ignore',
  })
  opened.unref()
}
