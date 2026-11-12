import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { type CheckRun, readDaemonInfo } from '@ted/protocol'
import { afterEach, expect, test } from 'vitest'
import { demoEnvironment, seedDemoFromCli, until } from '../src/dev/demo.ts'
import { demoCheckProblem, verifyDemo } from '../src/dev/scenarios.ts'
import { superviseDaemon } from '../src/launch.ts'
import { killAppHosts, killRunHosts, stopDaemonIn } from './helpers.ts'

const original = { ...process.env }
let home: string

afterEach(async () => {
  if (home) {
    await stopDaemonIn(home)
    await killAppHosts(home)
    await killRunHosts(home)
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, original)
})

test('seeding names a Check run TED could not finish', () => {
  const run = (id: string, outcome?: CheckRun['outcome']): CheckRun => ({
    id,
    taskId: 'task',
    trigger: 'hand-off',
    stage: 'work',
    startedAt: '2025-01-02T12:00:00.000Z',
    checks: [],
    ...(outcome && { outcome }),
  })
  expect(demoCheckProblem([run('a', 'passed'), run('b')])).toBeUndefined()
  expect(demoCheckProblem([run('a', 'passed'), run('b', 'interrupted')])).toContain(
    'Check run b was interrupted',
  )
  expect(demoCheckProblem([run('a', 'failed')])).toContain('Demo Check failed')
})

test('seeds a complete demo using public flows', async () => {
  const parent = path.resolve('node_modules/.cache/ted-home')
  await mkdir(parent, { recursive: true })
  home = await mkdtemp(path.join(parent, 'demo-'))
  const env = demoEnvironment(home)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  const manifest = await seedDemoFromCli(home)
  expect(manifest.complete).toBe(true)
  const supervisor = await superviseDaemon(home, {
    app: true,
    onEvent: () => {},
    onConnection: () => {},
  })
  try {
    const snapshot = () =>
      supervisor.client
        .listTasks()
        .then((tasks) =>
          tasks.map((task) => [task.displayId, task.title, task.stage, task.status?.kind]),
        )
    const before = await snapshot()
    await sleep(1_500)
    await verifyDemo(supervisor.client)
    expect(await snapshot()).toEqual(before)
    const reused = await seedDemoFromCli(home)
    expect(reused.tasks).toEqual(manifest.tasks)
    expect(await snapshot()).toEqual(before)
  } finally {
    supervisor.close()
    await supervisor.client.shutdown({ keepRuns: true })
    await until(async () => !(await readDaemonInfo(home)), 'test daemon shutdown')
  }
  const reset = await seedDemoFromCli(home, true)
  expect(reset.tasks).toEqual(manifest.tasks)
}, 240_000)
