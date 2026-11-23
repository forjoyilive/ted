import type { SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { DemoManifest } from '@ted/daemon/demo'
import { expect, test } from 'vitest'
import { openSampleData, type SampleDataLauncher } from '../src/sample-data.ts'

interface Started {
  command: string
  args: string[]
  options: SpawnOptions
  unref: boolean
}

function launcher(manifest: DemoManifest | undefined, seedExit = 0, stderr = '') {
  const started: Started[] = []
  const run = ((command: string, args: string[], options: SpawnOptions) => {
    const child = Object.assign(new EventEmitter(), {
      stderr: new PassThrough(),
      unref: () => {
        entry.unref = true
      },
    })
    const entry: Started = { command, args, options, unref: false }
    started.push(entry)
    if (args[0] === '/app/seed-sample.js')
      setImmediate(() => {
        child.stderr.end(stderr)
        child.emit('exit', seedExit)
      })
    return child
  }) satisfies NonNullable<SampleDataLauncher['run']>
  const given: SampleDataLauncher = {
    home: '/home/me/.ted-sample',
    executable: '/Applications/Ted.app/Contents/MacOS/Ted',
    appArgs: [],
    seedScript: '/app/seed-sample.js',
    checkHome: async () => manifest,
    environment: (home) => ({ TED_HOME: home, PATH: '/usr/bin' }),
    run,
  }
  return { given, started }
}

test('a ready sample opens straight away as a separate Ted on the sample home', async () => {
  const { given, started } = launcher({ version: 1, complete: true })
  await openSampleData(given)
  expect(started).toEqual([
    {
      command: '/Applications/Ted.app/Contents/MacOS/Ted',
      args: [],
      options: {
        env: { TED_HOME: '/home/me/.ted-sample', PATH: '/usr/bin' },
        detached: true,
        stdio: 'ignore',
      },
      unref: true,
    },
  ])
})

test('a missing sample is seeded first, and an incomplete one is reset, on Ted’s own runtime', async () => {
  for (const [manifest, args] of [
    [undefined, ['/app/seed-sample.js']],
    [{ version: 1, complete: false }, ['/app/seed-sample.js', '--reset']],
  ] as const) {
    const { given, started } = launcher(manifest)
    await openSampleData(given)
    expect(started.map((s) => s.args)).toEqual([args, []])
    expect(started[0]?.options.env).toMatchObject({
      TED_HOME: '/home/me/.ted-sample',
      ELECTRON_RUN_AS_NODE: '1',
    })
    expect(started[1]?.options.env?.ELECTRON_RUN_AS_NODE).toBeUndefined()
  }
})

test('a failed seed opens nothing and names the seeder’s last error', async () => {
  const { given, started } = launcher(undefined, 1, 'slow request\nError: git: not found\n')
  await expect(openSampleData(given)).rejects.toThrow(
    'Couldn’t prepare the sample data: Error: git: not found',
  )
  expect(started).toHaveLength(1)
})
