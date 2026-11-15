import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Banner, CheckRun, Factory, Task } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { filesClone } from '../src/tasks/cache-seeds.ts'
import {
  api,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

import { observe } from './support/execution-observations.ts'
import { insideTedSandbox, skipInsideTedSandbox } from './support/ted-sandbox.ts'

let home: string
let cleanup: () => Promise<void>
let origin: string
let daemon: RunningDaemon | undefined
const savedSandbox = process.env.TED_SANDBOX_BIN

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  origin = await makeOriginRepo(home)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  if (savedSandbox === undefined) delete process.env.TED_SANDBOX_BIN
  else process.env.TED_SANDBOX_BIN = savedSandbox
})

async function start(
  setup: string,
  teardown: string,
  permissions = 'auto',
  checks = false,
  consent = permissions === 'bypass',
) {
  await commitToOrigin(home, {
    '.gitignore': 'stub-*\n',
    '.ted/workflow.yaml': [
      'version: 1',
      `permissions: ${permissions}`,
      'order: [intake, work, merge]',
      'repos:',
      '  - name: widgets',
      '    worktree:',
      `      setup: ${JSON.stringify(setup)}`,
      `      teardown: ${JSON.stringify(teardown)}`,
      'stages:',
      '  validate:',
      '    checks:',
      '      - name: Cache',
      '        run: cat "$npm_config_cache/from-setup"',
      '',
    ].join('\n'),
    'cleanup.sh': 'echo original\n',
  })
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const connection = api(daemon.port, { appKey: daemon.appToken })
  const client = {
    ...connection,
    async ok<T>(method: string, route: string, body?: unknown): Promise<T> {
      const res = await connection.call(method, route, body)
      if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
      return res.body
    },
  }
  const factory = await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  if (consent)
    await client.ok('PUT', `/factories/${factory.id}/permissions`, {
      mode: 'bypass',
      confirmBypass: true,
    })
  const task = await client.ok<Task>('POST', '/tasks', {
    factory: 'NB',
    title: JSON.stringify({
      steps: [...(checks ? [{ run: ['ted', 'checks'] }] : []), { endTurn: true }],
    }),
  })
  await client.ok('POST', `/tasks/${task.id}/start`)
  const current = await waitUntil(async () => {
    const tasks = await client.ok<Task[]>('GET', '/tasks')
    const current = tasks.find((t) => t.id === task.id)
    return current?.leadRunId ? current : undefined
  }, 'the Task Lead after setup')
  return { client, task: current, worktree: current.repos[0]?.worktree ?? '' }
}

type Client = Awaited<ReturnType<typeof start>>['client']

async function archive(client: Client, task: Task) {
  await client.ok('POST', `/tasks/${task.id}/archive`, {})
  return waitUntil(async () => {
    const tasks = await client.ok<Task[]>('GET', '/tasks')
    const current = tasks.find((t) => t.id === task.id)
    return current?.repos[0]?.removed ? current : undefined
  }, 'teardown and worktree removal')
}

const log = (kind: string) =>
  readFile(path.join(home, 'logs', 'worktrees', `NB-1-widgets-${kind}.log`), 'utf8')

test.runIf(process.platform === 'darwin')(
  'setup and agent-edited teardown use private caches and cannot read or write the rest of TED_HOME',
  async (context) => {
    skipInsideTedSandbox(context)
    process.env.TED_SANDBOX_BIN = '/usr/bin/sandbox-exec'
    const outside = path.join(home, 'escaped')
    const secret = path.join(home, 'private-secret')
    await writeFile(secret, 'secret')
    const attack = [
      `if echo escaped > '${outside}'; then exit 90; fi`,
      `if cat '${secret}'; then exit 91; fi`,
      `if cat '${path.join(home, 'daemon.json')}'; then exit 92; fi`,
    ].join('; ')
    const { client, task, worktree } = await start(
      [
        attack,
        'echo changed >> README.md',
        'mkdir -p "$npm_config_cache"',
        'echo installed > "$npm_config_cache/from-setup"',
        'echo temporary > "$TMPDIR/stub-temp"',
        'printf "%s\\n%s\\n" "$npm_config_cache" "$TMPDIR" > stub-paths',
      ].join('; '),
      'sh cleanup.sh',
      'auto',
      true,
    )
    expect(task.repos[0]?.setup?.state).toBe('passed')
    const [cache = '', tmp = ''] = (await readFile(path.join(worktree, 'stub-paths'), 'utf8'))
      .trim()
      .split('\n')
    expect(cache).toContain('/sandbox/NB-1/cache/npm')
    await expect(readFile(path.join(tmp, 'stub-temp'))).rejects.toThrow()
    const report = await waitUntil(async () => {
      const runs = await client.ok<CheckRun[]>('GET', `/tasks/${task.id}/check-runs`)
      return runs.find((r) => r.finishedAt !== undefined)
    }, 'Checks to reuse the setup cache')
    expect(report.outcome).toBe('passed')
    expect(report.checks[0]?.state).toBe('passed')
    expect(await readFile(path.join(cache, 'from-setup'), 'utf8')).toBe('installed\n')

    await writeFile(
      path.join(worktree, 'cleanup.sh'),
      `${attack}; cat "$npm_config_cache/from-setup"\n`,
    )
    const archived = await archive(client, task)
    expect(await log('teardown')).toContain('installed')
    expect(archived?.repos[0]?.removed?.teardown?.outcome).toBe('passed')
    await expect(readFile(outside)).rejects.toThrow()
    expect(await readFile(secret, 'utf8')).toBe('secret')
    await expect(readdir(path.join(home, 'sandbox', 'NB-1'))).rejects.toThrow()
    await observe('lifecycle-native-sandbox', {
      platform: process.platform,
      nativeProgram: '/usr/bin/sandbox-exec',
      setupAndTeardown: 'passed',
      outOfRootWriteRefused: true,
      privateReadRefused: true,
      worktreeAndCacheWritesAllowed: true,
    })
  },
)

test('a new Task’s cache starts as a clone of the Factory’s seed, which the Task can’t change', async (context) => {
  context.skip(
    !(await filesClone([path.join(home, 'seeds'), path.join(home, 'sandbox')])),
    'this file system can’t clone files, so TED keeps no seed',
  )
  const realSandbox = process.platform === 'darwin' && !insideTedSandbox
  const seeds = path.join(home, 'seeds')
  const tamper = realSandbox
    ? `if [ -n "$TED_TASK" ]; then for f in '${seeds}'/*/seed/stub-package; do if echo tampered >> "$f"; then exit 93; fi; done; fi; `
    : ''
  const setup = [
    tamper,
    'if [ -f "$XDG_CACHE_HOME/stub-package" ]; then echo "reused package"; ',
    'else echo "downloaded package"; echo from-setup > "$XDG_CACHE_HOME/stub-package"; fi; ',
    'if [ -n "$TED_TASK" ]; then echo "$TED_TASK" >> "$XDG_CACHE_HOME/stub-package"; fi',
  ].join('')
  const { client, task } = await start(setup, 'true')
  expect(task.repos[0]?.setup?.state).toBe('passed')
  expect(await log('setup')).toContain('downloaded package')
  const seed = path.join(seeds, task.factoryId, 'seed', 'stub-package')
  await waitUntil(
    () => readFile(path.join(seeds, task.factoryId, 'seed.json'), 'utf8').catch(() => undefined),
    'the seed cache',
  )
  expect(await readFile(seed, 'utf8')).toBe('from-setup\n')

  const second = await client.ok<Task>('POST', '/tasks', {
    factory: 'NB',
    title: JSON.stringify({ steps: [{ endTurn: true }] }),
  })
  await client.ok('POST', `/tasks/${second.id}/start`)
  const started = await waitUntil(async () => {
    const tasks = await client.ok<Task[]>('GET', '/tasks')
    const current = tasks.find((t) => t.id === second.id)
    return current?.leadRunId ? current : undefined
  }, 'the second Task Lead after setup')
  expect(started.repos[0]?.setup?.state).toBe('passed')
  const secondLog = await readFile(
    path.join(home, 'logs', 'worktrees', 'NB-2-widgets-setup.log'),
    'utf8',
  )
  expect(secondLog).toContain('reused package')
  expect(await readFile(path.join(home, 'sandbox', 'NB-2', 'cache', 'stub-package'), 'utf8')).toBe(
    'from-setup\nNB-2\n',
  )
  expect(await readFile(seed, 'utf8')).toBe('from-setup\n')

  await client.ok('POST', `/factories/${task.factoryId}/remove`, {
    key: 'NB',
    closePullRequests: false,
  })
  await expect(readdir(path.join(seeds, task.factoryId))).rejects.toThrow()
})

test('missing sandbox fails setup with a report, still starts the Task Lead and skips teardown safely', async () => {
  process.env.TED_SANDBOX_BIN = path.join(home, 'no-such-sandbox')
  const { client, task, worktree } = await start('touch stub-setup', 'touch stub-teardown')
  expect(task.repos[0]?.setup?.state).toBe('failed')
  await expect(readFile(path.join(worktree, 'stub-setup'))).rejects.toThrow()
  expect(await log('setup')).toContain('TED didn’t run setup:')
  expect(await log('setup')).toContain('no-such-sandbox')
  const banners = await client.ok<Banner[]>('GET', '/banners')
  expect(banners.some((b) => b.problem === 'sandbox-unavailable')).toBe(true)
  const conversation = await waitUntil(async () => {
    const run = await client.getRun(task.leadRunId ?? '')
    return run.conversation.length > 0 ? run.conversation : undefined
  }, 'the setup failure report')
  expect(conversation[0]?.line).toContain('# Setup failed')
  expect(await readdir(path.join(home, 'sandbox', 'NB-1'))).toEqual([])
  const archived = await archive(client, task)
  expect(archived?.repos[0]?.removed?.teardown?.outcome).toBe('failed')
  expect(await log('teardown')).toContain('TED didn’t run teardown:')
  await expect(readdir(worktree)).rejects.toThrow()
})

test.each([false, true])(
  'temp preparation failure reports failed setup and starts the Task Lead (unwritable log: %s)',
  async (unwritableLog) => {
    await mkdir(path.join(home, 'sandbox'), { recursive: true })
    await writeFile(path.join(home, 'sandbox', 'NB-1'), 'not a directory')
    if (unwritableLog) {
      await mkdir(path.join(home, 'logs', 'worktrees', 'NB-1-widgets-setup.log'), {
        recursive: true,
      })
    }
    const { client, task, worktree } = await start('touch stub-setup', 'touch stub-teardown')
    expect(task.repos[0]?.setup?.state).toBe('failed')
    await expect(readFile(path.join(worktree, 'stub-setup'))).rejects.toThrow()
    const conversation = await waitUntil(async () => {
      const run = await client.getRun(task.leadRunId ?? '')
      return run.conversation.length > 0 ? run.conversation : undefined
    }, 'the preparation failure report')
    expect(conversation[0]?.line).toContain('# Setup failed')
    expect(conversation[0]?.line).toContain('TED didn’t run setup:')
    expect(conversation[0]?.line).toContain('EEXIST')
    if (!unwritableLog) expect(await log('setup')).toContain('TED didn’t run setup:')
    const archived = await archive(client, task)
    expect(archived.repos[0]?.removed?.teardown?.outcome).toBe('failed')
    expect(await log('teardown')).toContain('TED didn’t run teardown:')
    await expect(readdir(worktree)).rejects.toThrow()
  },
)

test('confirmed local Bypass keeps lifecycle commands unsandboxed even when no sandbox is available', async () => {
  process.env.TED_SANDBOX_BIN = path.join(home, 'no-such-sandbox')
  const marker = path.join(home, 'outside-worktree')
  const { client, task } = await start(
    `echo setup > '${marker}'`,
    `echo teardown >> '${marker}'`,
    'bypass',
  )
  expect(task.repos[0]?.setup?.state).toBe('passed')
  await archive(client, task)
  expect(await readFile(marker, 'utf8')).toBe('setup\nteardown\n')
  const banners = await client.ok<Banner[]>('GET', '/banners')
  expect(banners.some((b) => b.problem === 'sandbox-unavailable')).toBe(false)
})

test('repo Bypass cannot remove the lifecycle sandbox without local consent', async () => {
  process.env.TED_SANDBOX_BIN = path.join(home, 'no-such-sandbox')
  const marker = path.join(home, 'outside-worktree')
  const { client, task } = await start(
    `echo escaped > '${marker}'`,
    `echo escaped > '${marker}'`,
    'bypass',
    false,
    false,
  )
  expect(task.repos[0]?.setup?.state).toBe('failed')
  const archived = await archive(client, task)
  expect(archived.repos[0]?.removed?.teardown?.outcome).toBe('failed')
  await expect(readFile(marker)).rejects.toThrow()
})

test('revoking local Bypass requires a sandbox for the next lifecycle command', async () => {
  process.env.TED_SANDBOX_BIN = path.join(home, 'no-such-sandbox')
  const marker = path.join(home, 'outside-worktree')
  const { client, task } = await start(
    `echo setup > '${marker}'`,
    `echo teardown >> '${marker}'`,
    'bypass',
  )
  expect(task.repos[0]?.setup?.state).toBe('passed')
  await client.ok('PUT', `/factories/${task.factoryId}/permissions`, { mode: 'auto' })
  const archived = await archive(client, task)
  expect(archived.repos[0]?.removed?.teardown?.outcome).toBe('failed')
  expect(await readFile(marker, 'utf8')).toBe('setup\n')
})

test.runIf(process.platform === 'darwin')(
  'a missing teardown worktree is refused before the command runs',
  async () => {
    const { client, task, worktree } = await start('true', 'echo unsafe')
    await rm(worktree, { recursive: true })
    const archived = await archive(client, task)
    expect(archived?.repos[0]?.removed?.teardown?.outcome).toBe('failed')
    expect(await log('teardown')).toContain('isn’t a plain folder')
  },
)
