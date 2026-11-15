import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, open, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type {
  Banner,
  Factory,
  FactoryLayout,
  FactoryRemoval,
  FactorySettingsView,
  RepoRemoval,
  Run,
  SettingsPreview,
  Task,
} from '@ted/protocol'
import { settingsInput } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  commitToOrigin,
  hostRecords,
  isAlive,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  tokenFor,
  waitForExit,
  waitUntil,
} from './helpers.ts'

const execFileAsync = promisify(execFile)
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined
const savedEnv = { ...process.env }

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'ted-factory-removal-')))
  origin = await makeOriginRepo(scratch)
  await makeSecondOrigin('api')
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = `url.file://${scratch}/.insteadOf`
  process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/'
  const info = (repo: string) => ({
    body: { full_name: repo, default_branch: 'main', permissions: { push: true } },
  })
  const ghState = path.join(scratch, 'gh.json')
  await writeFile(
    ghState,
    JSON.stringify({
      merge: { origin, updateBase: true },
      paths: {
        'repos/acme/api': info('acme/api'),
        'repos/acme/api/commits?per_page=1': { body: [] },
      },
    }),
  )
  process.env.TED_STUB_GH = ghState
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home, { waitForStart: true })
  process.env = { ...savedEnv }
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function makeSecondOrigin(name: string): Promise<void> {
  const bare = path.join(scratch, 'acme', `${name}.git`)
  const seed = path.join(scratch, `${name}-seed`)
  await mkdir(bare, { recursive: true })
  await execFileAsync('git', ['init', '--bare', '--initial-branch=main'], { cwd: bare })
  await mkdir(seed)
  await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: seed })
  await writeFile(path.join(seed, 'README.md'), `# ${name}\n`)
  await execFileAsync('git', ['add', '-A'], { cwd: seed, env: gitEnv })
  await execFileAsync('git', ['commit', '-m', 'first'], { cwd: seed, env: gitEnv })
  await execFileAsync('git', ['push', bare, 'main'], { cwd: seed, env: gitEnv })
}

const torn = () => path.join(home, 'logs', 'worktrees', 'NB-1-widgets-teardown.log')

const twoRepos = () =>
  commitToOrigin(scratch, {
    '.ted/workflow.yaml': [
      'version: 1',
      'order: [intake, work, merge]',
      'repos:',
      '  - name: widgets',
      '    worktree:',
      '      teardown: echo torn-down',
      '  - name: api',
      '    remote: https://github.com/acme/api.git',
      'stages:',
      '  validate:',
      '    checks:',
      '      - { name: API tests, run: npm test, repo: api }',
      '',
    ].join('\n'),
  })

async function start() {
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  return { ...client, ok }
}

type Client = Awaited<ReturnType<typeof start>>

async function addNotebook(client: Client): Promise<Factory> {
  const added = await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  for (const banner of await client.ok<Banner[]>('GET', '/banners')) {
    if (banner.problem !== 'repo-in-workflow') continue
    await client.ok('POST', `/banners/${encodeURIComponent(banner.id)}/action`, {})
  }
  await waitUntil(
    () => exists(path.join(home, 'repos', 'acme', 'api', '.git')),
    'the api repo to be cloned',
  )
  return added
}

const addApi = (client: Client) =>
  client.ok<Factory>('POST', '/dev/factories', {
    repo: path.join(scratch, 'acme', 'api.git'),
    key: 'AP',
  })

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  )

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })
const never = () => steps({ waitFor: path.join(scratch, 'never') })

const getTasks = (client: Client) => client.ok<Task[]>('GET', '/tasks')

describe('Factory order', () => {
  test('is kept on this machine and lists every Factory once', async () => {
    const client = await start()
    const notebook = await client.ok<Factory>('POST', '/dev/factories', {
      repo: origin,
      key: 'NB',
    })
    const apiFactory = await addApi(client)
    expect((await client.ok<Factory[]>('GET', '/factories')).map((f) => f.key)).toEqual([
      'NB',
      'AP',
    ])

    expect(await client.ok<FactoryLayout>('GET', '/factories/layout')).toEqual({
      items: [{ factoryId: notebook.id }, { factoryId: apiFactory.id }],
    })

    const grouped: FactoryLayout = {
      items: [
        { group: { id: 'empty', name: 'Personal', factoryIds: [] } },
        { group: { id: 'acme', name: 'Acme', factoryIds: [apiFactory.id] } },
        { factoryId: notebook.id },
      ],
    }
    expect(await client.ok<FactoryLayout>('PUT', '/factories/layout', grouped)).toEqual(grouped)
    const listed = await client.ok<Factory[]>('GET', '/factories')
    expect(listed.map((f) => [f.key, f.position])).toEqual([
      ['AP', 0],
      ['NB', 1],
    ])

    const missing = await client.call('PUT', '/factories/layout', {
      items: [{ factoryId: notebook.id }],
    })
    expect(missing).toEqual({ status: 400, body: { error: 'list every Factory once' } })
    const twice = await client.call('PUT', '/factories/layout', {
      items: [
        { factoryId: notebook.id },
        { group: { id: 'acme', name: 'Acme', factoryIds: [notebook.id, apiFactory.id] } },
      ],
    })
    expect(twice.status).toBe(400)
    const sameGroup = await client.call('PUT', '/factories/layout', {
      items: [
        { group: { id: 'acme', name: 'Acme', factoryIds: [notebook.id] } },
        { group: { id: 'acme', name: 'Other', factoryIds: [apiFactory.id] } },
      ],
    })
    expect(sameGroup).toEqual({ status: 400, body: { error: 'each group needs its own id' } })

    await client.ok('POST', `/factories/${apiFactory.id}/remove`, {
      key: 'AP',
      closePullRequests: true,
    })
    expect(await client.ok<FactoryLayout>('GET', '/factories/layout')).toEqual({
      items: [
        { group: { id: 'empty', name: 'Personal', factoryIds: [] } },
        { group: { id: 'acme', name: 'Acme', factoryIds: [] } },
        { factoryId: notebook.id },
      ],
    })
  })

  test('renaming keeps the key and every Task ID', async () => {
    const client = await start()
    const factory = await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
    const task = await client.ok<Task>('POST', '/tasks', { title: 'Sync', factory: 'NB' })
    const renamed = await client.ok<Factory>('PUT', `/factories/${factory.id}/name`, {
      name: 'Notebook',
    })
    expect(renamed).toMatchObject({ id: factory.id, key: 'NB', name: 'Notebook' })
    expect((await getTasks(client)).find((t) => t.id === task.id)?.displayId).toBe('NB-1')
  })
})

describe('Remove Factory', () => {
  test('needs the typed key, and only the TED app can do it', async () => {
    const client = await start()
    const factory = await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
    const wrong = await client.call('POST', `/factories/${factory.id}/remove`, {
      key: 'nb',
      closePullRequests: true,
    })
    expect(wrong).toEqual({ status: 400, body: { error: 'Type NB to confirm' } })
    const fileToken = api(daemon?.port ?? 0, await tokenFor(home))
    const refused = { status: 403, body: { error: 'only the TED app can do this' } }
    expect(
      await fileToken.call('POST', `/factories/${factory.id}/remove`, {
        key: 'NB',
        closePullRequests: true,
      }),
    ).toEqual(refused)
    expect(
      await fileToken.call('PUT', '/factories/layout', { items: [{ factoryId: factory.id }] }),
    ).toEqual(refused)
    expect((await client.ok<Factory[]>('GET', '/factories')).map((f) => f.key)).toEqual(['NB'])
  })

  test('stops its Runs, deletes its Tasks, worktrees and the clones no other Factory uses', async () => {
    await twoRepos()
    const client = await start()
    const factory = await addNotebook(client)
    const other = await addApi(client)
    const working = await client.ok<Task>('POST', '/tasks', {
      title: never(),
      factory: 'NB',
      start: true,
    })
    await client.ok<Task>('POST', '/tasks', { title: 'Waiting in Backlog', factory: 'NB' })
    const run = await waitUntil(async () => {
      const current = (await getTasks(client)).find((t) => t.id === working.id)
      return current?.leadRunId
        ? (await client.getRun(current.leadRunId)).run
        : (undefined as Run | undefined)
    }, 'the Task Lead Run')
    const [hostStart] = await waitUntil(async () => {
      const records = await hostRecords(home, run.id)
      return records.some((r) => r.t === 'start') ? records : undefined
    }, 'the Run host to start')
    const agentPid = Number((hostStart as { hostPid?: number } | undefined)?.hostPid)
    await waitUntil(() => exists(path.join(home, 'worktrees', 'NB-1', 'widgets')), 'the worktree')
    const localFolder = path.join(scratch, 'my-widgets')
    await mkdir(localFolder)
    await client.ok('PUT', `/factories/${factory.id}/repos/widgets/local-folder`, {
      path: localFolder,
    })

    const summary = await client.ok<FactoryRemoval>('GET', `/factories/${factory.id}/removal`)
    expect(summary).toMatchObject({
      key: 'NB',
      tasks: 2,
      runs: 1,
      worktrees: 1,
      openPullRequests: 0,
      clones: ['acme/widgets'],
      sharedClones: ['acme/api'],
    })

    await mkdir(path.dirname(torn()), { recursive: true })
    const teardownLog = await open(torn(), 'w+')
    try {
      await client.ok('POST', `/factories/${factory.id}/remove`, {
        key: 'NB',
        closePullRequests: true,
      })
      expect(await teardownLog.readFile('utf8')).toBe('torn-down\n')
    } finally {
      await teardownLog.close()
    }

    expect((await client.ok<Factory[]>('GET', '/factories')).map((f) => f.id)).toEqual([other.id])
    expect((await getTasks(client)).filter((t) => t.factoryId === factory.id)).toEqual([])
    expect(await exists(path.join(home, 'worktrees', 'NB-1'))).toBe(false)
    expect(await exists(path.join(home, 'repos', 'acme', 'widgets'))).toBe(false)
    expect(await exists(path.join(home, 'repos', 'acme', 'api', '.git'))).toBe(true)
    expect(await exists(localFolder)).toBe(true)
    if (Number.isInteger(agentPid) && agentPid > 0) await waitForExit(agentPid)
    expect(Number.isInteger(agentPid) && agentPid > 0 && isAlive(agentPid)).toBe(false)
    const banners = await client.ok<Banner[]>('GET', '/banners')
    expect(banners.filter((b) => b.factoryId === factory.id)).toEqual([])
    expect((await client.call('GET', `/factories/${factory.id}/removal`)).status).toBe(404)

    const again = await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
    expect(again.id).not.toBe(factory.id)
    expect(again.repos[0]?.localFolder).toBeUndefined()
    const fresh = await client.ok<Task>('POST', '/tasks', { title: 'Again', factory: 'NB' })
    expect(fresh.displayId).toBe('NB-1')
  })
})

describe('Remove a secondary repo', () => {
  test('is refused while an open Task has it in its Repos field', async () => {
    await twoRepos()
    const client = await start()
    const factory = await addNotebook(client)
    const task = await client.ok<Task>('POST', '/tasks', { title: 'Both', factory: 'NB' })
    await client.ok('PUT', `/tasks/${task.id}/repos`, { set: ['widgets', 'api'] })

    const check = await client.ok<RepoRemoval>('GET', `/factories/${factory.id}/repos/api/removal`)
    expect(check).toEqual({
      repo: 'acme/api',
      name: 'api',
      openTasks: [{ id: task.id, displayId: 'NB-1', title: 'Both' }],
    })
    const view = await client.ok<FactorySettingsView>('GET', `/factories/${factory.id}/settings`)
    const changes = { repos: view.repos.filter((r) => r.name !== 'api').map(settingsInput) }
    const preview = await client.ok<SettingsPreview>(
      'POST',
      `/factories/${factory.id}/settings/preview`,
      changes,
    )
    expect(preview.valid).toBe(false)
    expect(preview.problems.map((p) => p.message)).toEqual([
      'acme/api is in the Repos field of open Tasks NB-1. Remove it from them, or finish or archive them, first.',
    ])
    const saved = await client.call('POST', `/factories/${factory.id}/settings/save`, {
      changes,
      mode: 'merge',
      version: view.version,
    })
    expect(saved.status).toBe(400)

    await client.ok('POST', `/tasks/${task.id}/archive`)
    expect(
      (await client.ok<RepoRemoval>('GET', `/factories/${factory.id}/repos/api/removal`)).openTasks,
    ).toEqual([])
  })

  test('removes its Apps and the Checks pointing at it on Save, and deletes its unused clone', async () => {
    await twoRepos()
    const client = await start()
    const factory = await addNotebook(client)
    const view = await client.ok<FactorySettingsView>('GET', `/factories/${factory.id}/settings`)
    const changes = {
      repos: view.repos.filter((r) => r.name !== 'api').map(settingsInput),
      checks: view.checks.map(({ was, name, run, repo }) => ({
        was,
        name,
        run,
        ...(repo !== undefined && { repo }),
      })),
    }
    const preview = await client.ok<SettingsPreview>(
      'POST',
      `/factories/${factory.id}/settings/preview`,
      changes,
    )
    expect(preview.sideEffects).toContain(
      'acme/api leaves the Factory with its Apps and Checks. Its clone is deleted once no Factory uses it.',
    )
    const after = preview.files.find((f) => f.path === '.ted/workflow.yaml')
    const gone = after?.lines.filter((l) => l.kind === 'removed').map((l) => l.text) ?? []
    expect(gone.join('\n')).toContain('API tests')
    expect(gone.join('\n')).toContain('acme/api.git')

    await client.ok('POST', `/factories/${factory.id}/settings/save`, {
      changes,
      mode: 'merge',
      version: view.version,
    })
    await waitUntil(
      async () =>
        (await client.ok<Factory[]>('GET', '/factories'))[0]?.repos.length === 1 &&
        !(await exists(path.join(home, 'repos', 'acme', 'api'))),
      'the api repo and its clone to go',
    )
  })
})
