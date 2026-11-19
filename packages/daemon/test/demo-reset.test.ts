import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { portFree } from '../src/apps/apps.ts'
import { parseAppRecords } from '../src/apps/host-files.ts'
import { demoEnvironment, prepareDemo, until } from '../src/dev/demo.ts'
import { demoVersion, markDemo } from '../src/dev/home.ts'
import { superviseDaemon } from '../src/launch.ts'
import { isAlive, killAppHosts, killRunHosts, stopDaemonIn } from './helpers.ts'
import { approveAppsOutsideSandbox } from './support/outside-sandbox-approvals.ts'

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

async function newDemoHome(): Promise<string> {
  const parent = path.resolve('node_modules/.cache/ted-home')
  await mkdir(parent, { recursive: true })
  home = await mkdtemp(path.join(parent, 'demo-reset-'))
  const env = demoEnvironment(home)
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
  return home
}

test('reset stops detached Apps before deleting their worktrees', async () => {
  home = await newDemoHome()
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
    await approveAppsOutsideSandbox(supervisor.client, task)
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

test('reset recovers a failed agent start with a null PID', async () => {
  home = await newDemoHome()
  await markDemo(home, { version: demoVersion, complete: false })
  const dir = path.join(home, 'runs', '00000000-0000-4000-8000-000000000001')
  await mkdir(dir, { recursive: true })
  const hostPid = 2_147_483_647
  expect(isAlive(hostPid)).toBe(false)
  await writeFile(
    path.join(dir, 'host.log'),
    `${JSON.stringify({
      t: 'start',
      v: 1,
      hostPid,
      agentPid: null,
    })}\n`,
  )
  expect((await prepareDemo(home, true)).complete).toBe(false)
}, 30_000)

test.each([-1, 0, 1, 1.5])('reset still rejects invalid agent PID %s', async (agentPid) => {
  home = await newDemoHome()
  await markDemo(home, { version: demoVersion, complete: false })
  const dir = path.join(home, 'runs', '00000000-0000-4000-8000-000000000001')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'host.log'), `${JSON.stringify({ t: 'start', agentPid })}\n`)
  await expect(prepareDemo(home, true)).rejects.toThrow('Unexpected demo host pid')
})
