import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { portFree } from '../src/apps/apps.ts'
import { parseAppRecords } from '../src/apps/host-files.ts'
import { demoEnvironment, prepareDemo, until } from '../src/dev/demo.ts'
import { superviseDaemon } from '../src/launch.ts'
import { isAlive, killAppHosts, killRunHosts, stopDaemonIn } from './helpers.ts'

const original = { ...process.env }
let home: string | undefined
let appPids: number[] = []

afterEach(async () => {
  if (home) {
    await stopDaemonIn(home)
    await killAppHosts(home)
    await killRunHosts(home)
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  for (const pid of appPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  appPids = []
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, original)
})

test('reset stops detached Apps before deleting their worktrees', async () => {
  const parent = path.resolve('node_modules/.cache/ted-home')
  await mkdir(parent, { recursive: true })
  home = await mkdtemp(path.join(parent, 'demo-reset-'))
  const env = demoEnvironment(home)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  await prepareDemo(home)
  const supervisor = await superviseDaemon(home, {
    app: true,
    onEvent: () => {},
    onConnection: () => {},
  })
  let port: number | undefined
  let hostPid: number | undefined
  try {
    await supervisor.client.createFactory({
      name: 'Garden',
      key: 'GD',
      showTutorial: false,
      repos: [
        { name: 'web', source: { remote: 'https://github.com/demo/garden' } },
        { name: 'api', source: { remote: 'https://github.com/demo/garden-api' } },
      ],
    })
    await until(
      async () => (await supervisor.client.listFactories()).every((f) => f.cloned),
      'Factory clone',
    )
    const task = await supervisor.client.createTask({
      factory: 'GD',
      title: 'Try the demo Web App',
      start: true,
    })
    await until(
      async () => (await supervisor.client.listTasks()).find((t) => t.id === task.id)?.leadRunId,
      'Task worktree',
    )
    const app = await supervisor.client.startApp(task.id, { repo: 'web', name: 'Web' })
    port = app.port
    expect(port).toBeDefined()
    await until(
      () =>
        fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1_000) }).then(
          (r) => r.ok,
          () => false,
        ),
      'Web App readiness',
    )
    const records = parseAppRecords(
      await readFile(path.join(home, 'apps', task.id, 'web', 'web', 'host.jsonl'), 'utf8'),
    )
    const started = records.find((r) => r.t === 'start')
    if (started?.t !== 'start') throw new Error('Missing App host start')
    hostPid = started.hostPid
    appPids = [started.hostPid, ...(started.pid === null ? [] : [-started.pid])]
    await supervisor.handOver({ maxWaitMs: 0 })
  } finally {
    supervisor.close()
  }
  await prepareDemo(home, true)
  expect(port).toBeDefined()
  if (port !== undefined) expect(await portFree(port)).toBe(true)
  expect(hostPid).toBeDefined()
  if (hostPid !== undefined) expect(isAlive(hostPid)).toBe(false)
  appPids = []
}, 60_000)
