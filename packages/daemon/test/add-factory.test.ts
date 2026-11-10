import { execFile } from 'node:child_process'
import { mkdtemp, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Activity, Banner, Factory, RepoCheck, RunSlots, Task } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { githubRepo } from '../src/factory-setup.ts'
import { parseProgress } from '../src/git.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

const execFileAsync = promisify(execFile)
const stubGh = fileURLToPath(new URL('./fixtures/stub-gh.ts', import.meta.url))

let home: string
let cleanup: () => Promise<void>
let scratch: string
let ghState: string
let daemon: RunningDaemon | undefined
const savedEnv = { ...process.env }

const repoInfo = (repo: string, push = true) => ({
  body: { full_name: repo, default_branch: 'main', permissions: { push } },
})

const readyPaths = (repo: string) => ({
  [`repos/${repo}`]: repoInfo(repo),
  [`repos/${repo}/commits?per_page=1`]: { body: [] },
})

async function setGh(paths: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  await writeFile(ghState, JSON.stringify({ paths, ...extra }))
}

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'ted-add-factory-')))
  await makeOriginRepo(scratch)
  ghState = path.join(scratch, 'gh.json')
  await setGh(readyPaths('acme/widgets'))
  process.env.TED_STUB_GH = ghState
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = `url.file://${scratch}/.insteadOf`
  process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/'
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  process.env = { ...savedEnv }
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function start() {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    integrations: { ghBin: stubGh },
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  return { ...client, ok }
}

type Client = Awaited<ReturnType<typeof start>>

const check = (client: Client, source: unknown, primary = true) =>
  client.ok<RepoCheck>('POST', '/factories/check-repo', { source, primary })

async function userFolder(remote = 'https://github.com/acme/widgets.git'): Promise<string> {
  const folder = path.join(scratch, 'mine', 'widgets')
  await execFileAsync('git', ['clone', path.join(scratch, 'acme', 'widgets.git'), folder])
  await execFileAsync('git', ['remote', 'set-url', 'origin', remote], { cwd: folder })
  return folder
}

async function untilCloned(client: Client, id: string): Promise<Factory> {
  let factory: Factory | undefined
  await waitUntil(async () => {
    factory = (await client.ok<Factory[]>('GET', '/factories')).find((f) => f.id === id)
    return factory?.cloned === true
  }, 'the Factory to finish cloning')
  return factory as Factory
}

describe('access check', () => {
  test('a pushable repo with commits passes', async () => {
    const client = await start()
    const result = await check(client, { remote: 'acme/widgets' })
    expect(result).toEqual({
      repo: 'acme/widgets',
      name: 'widgets',
      defaultBranch: 'main',
      ok: true,
      notes: [],
    })
  })

  test('a GitHub URL in any form names the same repo', () => {
    for (const given of [
      'acme/widgets',
      'https://github.com/acme/widgets',
      'https://github.com/acme/widgets.git',
      'git@github.com:acme/widgets.git',
      'ssh://git@github.com/acme/widgets.git',
    ]) {
      expect(githubRepo(given)).toBe('acme/widgets')
    }
    expect(githubRepo('https://gitlab.com/acme/widgets')).toBeUndefined()
    expect(githubRepo('acme/../x')).toBeUndefined()
  })

  test('each problem has its message and fixes', async () => {
    const client = await start()
    await setGh({
      ...readyPaths('acme/widgets'),
      'repos/acme/readonly': repoInfo('acme/readonly', false),
      'repos/acme/empty': repoInfo('acme/empty'),
      'repos/acme/empty/commits?per_page=1': { status: 409, message: 'Git Repository is empty.' },
    })

    const readOnly = await check(client, { remote: 'acme/readonly' })
    expect(readOnly.problem).toMatchObject({
      kind: 'read-only',
      text: 'You can read acme/readonly but not push to it.',
      fixes: [{ kind: 'check-again' }],
    })
    expect(readOnly.problem?.detail).toContain('the GitHub account TED uses')

    const missing = await check(client, { remote: 'acme/nope' })
    expect(missing.problem).toMatchObject({
      kind: 'not-found',
      text: 'Repository not found, or your GitHub account can’t see it.',
      fixes: [{ kind: 'check-again' }, { kind: 'github-settings' }],
    })

    const empty = await check(client, { remote: 'acme/empty' })
    expect(empty.problem).toMatchObject({
      kind: 'empty',
      text: 'This repo has no commits yet.',
      fixes: [{ kind: 'check-again' }],
    })

    const invalid = await check(client, { remote: 'not a repo' })
    expect(invalid.problem?.kind).toBe('invalid')

    const plain = await mkdtemp(path.join(scratch, 'plain-'))
    const noRemote = await check(client, { folder: plain })
    expect(noRemote.problem).toMatchObject({
      kind: 'no-remote',
      text: 'This folder has no GitHub remote.',
      fixes: [{ kind: 'choose-folder' }],
    })
  })

  test('a signed-out GitHub CLI shows as a GitHub problem', async () => {
    const client = await start()
    await setGh({}, { api: { result: 'auth' } })
    await writeFile(ghState, JSON.stringify({ api: { result: 'auth' } }))
    const result = await check(client, { remote: 'acme/widgets' })
    expect(result.problem).toMatchObject({ kind: 'github', fixes: [{ kind: 'github-settings' }] })
  })

  test('a folder reads its GitHub remote, and existing .ted/ adds a note', async () => {
    const client = await start()
    await setGh({
      ...readyPaths('acme/widgets'),
      'repos/acme/widgets/contents/.ted?ref=main': { body: [] },
    })
    const folder = await userFolder('git@github.com:acme/widgets.git')
    const result = await check(client, { folder })
    expect(result).toMatchObject({ ok: true, repo: 'acme/widgets', folder })
    expect(result.notes).toEqual([
      'Has TED settings already. They’ll be used, and the setup Task will wait in Backlog.',
    ])
  })

  test('another Factory’s primary repo is refused as primary, noted as secondary', async () => {
    const client = await start()
    const first = await client.ok<Factory>('POST', '/factories', {
      name: 'Widgets',
      key: 'WI',
      repos: [{ source: { remote: 'acme/widgets' }, name: 'widgets' }],
      showTutorial: true,
    })
    await untilCloned(client, first.id)

    const asPrimary = await check(client, { remote: 'acme/widgets' }, true)
    expect(asPrimary.problem).toMatchObject({
      kind: 'primary-elsewhere',
      text: 'acme/widgets is the primary repo of Factory Widgets.',
      fixes: [{ kind: 'open-factory', factoryId: first.id, factoryName: 'Widgets' }],
    })
    const asSecond = await check(client, { remote: 'acme/widgets' }, false)
    expect(asSecond).toMatchObject({
      ok: true,
      notes: ['Also used by Factory Widgets. TED shares one clone between them.'],
    })
  })
})

describe('adding a Factory', () => {
  test('from a folder: clones into TED’s repos and never writes to the folder', async () => {
    const client = await start()
    const folder = await userFolder()
    const before = await snapshot(folder)

    const factory = await client.ok<Factory>('POST', '/factories', {
      name: 'Widgets',
      key: 'WI',
      repos: [{ source: { folder }, name: 'widgets' }],
      showTutorial: true,
    })
    expect(factory).toMatchObject({
      key: 'WI',
      name: 'Widgets',
      repo: 'acme/widgets',
      showTutorial: true,
      cloned: false,
      repos: [
        { repo: 'acme/widgets', name: 'widgets', localFolder: { path: folder, found: true } },
      ],
    })
    expect(factory.setup).toHaveLength(1)

    const done = await untilCloned(client, factory.id)
    expect(done.setup).toBeUndefined()
    const clone = path.join(home, 'repos', 'acme', 'widgets')
    expect((await stat(path.join(clone, '.git'))).isDirectory()).toBe(true)
    const { stdout } = await execFileAsync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: clone,
    })
    expect(stdout.trim()).toBe('https://github.com/acme/widgets.git')
    expect(await readdir(path.join(home, 'repos', 'acme'))).toEqual(['widgets'])
    expect(await snapshot(folder)).toEqual(before)
  })

  test('from owner/repo, sharing a clone another Factory already has', async () => {
    const client = await start()
    await setGh({ ...readyPaths('acme/widgets'), ...readyPaths('acme/gadgets') })

    const first = await client.ok<Factory>('POST', '/factories', {
      name: 'Widgets',
      key: 'WI',
      repos: [{ source: { remote: 'acme/widgets' }, name: 'widgets' }],
      showTutorial: false,
    })
    await untilCloned(client, first.id)

    const second = await client.ok<Factory>('POST', '/factories', {
      name: 'Gadgets',
      key: 'GA',
      repos: [
        { source: { remote: 'https://github.com/acme/gadgets' }, name: 'gadgets' },
        { source: { remote: 'acme/widgets' }, name: 'widgets' },
      ],
      showTutorial: false,
    })
    expect(second.repos.map((r) => r.repo)).toEqual(['acme/gadgets', 'acme/widgets'])
    let setup: Factory['setup']
    await waitUntil(async () => {
      const found = (await client.ok<Factory[]>('GET', '/factories')).find(
        (f) => f.id === second.id,
      )
      setup = found?.setup
      return setup?.every((s) => s.state === 'failed' || s.state === 'shared') === true
    }, 'Gadgets to finish trying')
    expect(setup).toEqual([
      expect.objectContaining({ repo: 'acme/gadgets', state: 'failed' }),
      { repo: 'acme/widgets', state: 'shared', sharedWith: 'Widgets' },
    ])

    await makeOriginRepo(path.join(scratch, 'second'))
    await rename(
      path.join(scratch, 'second', 'acme', 'widgets.git'),
      path.join(scratch, 'acme', 'gadgets.git'),
    )
    await client.ok('POST', `/factories/${second.id}/retry-clone`)
    await untilCloned(client, second.id)
    expect((await readdir(path.join(home, 'repos', 'acme'))).sort()).toEqual(['gadgets', 'widgets'])
  })

  test('the key must be well formed and unused', async () => {
    const client = await start()
    const add = (key: string) =>
      client.call('POST', '/factories', {
        name: 'Widgets',
        key,
        repos: [{ source: { remote: 'acme/widgets' }, name: 'widgets' }],
        showTutorial: false,
      })
    expect((await add('w1')).status).toBe(400)
    expect((await add('TOOLONG')).status).toBe(400)
    expect((await add('DEV')).status).toBe(409)
    expect((await add('WI')).status).toBe(201)
    const again = await add('WI')
    expect(again.status).toBe(409)
    expect(again.body.error).toContain('WI is already the key of Widgets.')
  })

  test('a repo that fails its access check can’t be added', async () => {
    const client = await start()
    const res = await client.call('POST', '/factories', {
      name: 'Widgets',
      key: 'WI',
      repos: [{ source: { remote: 'acme/nope' }, name: 'nope' }],
      showTutorial: false,
    })
    expect(res.status).toBe(409)
    expect(await client.ok<Factory[]>('GET', '/factories')).toEqual([])
  })

  test.each([false, true])(
    'a failed clone holds work until Retry (automatic Backlog starting: %s)',
    async (automatic) => {
      const client = await start()
      const origin = path.join(scratch, 'acme', 'widgets.git')
      const hidden = path.join(scratch, 'hidden.git')
      await rename(origin, hidden)

      const factory = await client.ok<Factory>('POST', '/factories', {
        name: 'Widgets',
        key: 'WI',
        repos: [{ source: { remote: 'acme/widgets' }, name: 'widgets' }],
        showTutorial: false,
      })
      let banner: Banner | undefined
      await waitUntil(async () => {
        banner = (await client.ok<Banner[]>('GET', '/banners')).find(
          (b) => b.problem === 'clone-failed' && b.factoryId === factory.id,
        )
        return banner !== undefined
      }, 'the clone-failed banner')
      expect(banner).toMatchObject({
        severity: 'stops-work',
        text: 'Couldn’t clone acme/widgets · Widgets can’t start Tasks until it’s cloned',
        action: { label: 'Retry' },
      })
      const failed = (await client.ok<Factory[]>('GET', '/factories'))[0]
      expect(failed?.setup?.[0]).toMatchObject({ repo: 'acme/widgets', state: 'failed' })
      expect(failed?.setup?.[0]?.error).toBeTruthy()

      if (automatic) {
        await client.ok('PUT', `/factories/${factory.id}/auto-start-backlog`, { enabled: true })
      }
      const task = await client.ok<Task>('POST', '/tasks', {
        factory: 'WI',
        title: JSON.stringify({ steps: [{ say: 'hi' }, { idle: true }] }),
        start: !automatic,
      })
      const queued = await client
        .ok<Task>('GET', `/tasks/${task.id}`)
        .catch(async () => (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id))
      expect(queued?.leadRunId).toBeUndefined()

      expect(await client.ok<Activity>('GET', '/activity')).toMatchObject({ factoriesSettingUp: 1 })

      await rename(hidden, origin)
      await commitToOrigin(scratch, { '.ted/workflow.yaml': 'version: 1\nmax_working_runs: 1\n' })
      await client.ok('POST', `/banners/${encodeURIComponent(banner?.id ?? '')}/action`)
      await untilCloned(client, factory.id)
      expect(await client.ok<Activity>('GET', '/activity')).toMatchObject({ factoriesSettingUp: 0 })
      await waitUntil(async () => {
        const slots = await client.ok<RunSlots>('GET', '/slots')
        return slots.factories.some((f) => f.factoryId === factory.id && f.cap === 1)
      }, 'the Factory’s own cap to apply once cloned')
      expect(
        (await client.ok<Banner[]>('GET', '/banners')).some((b) => b.problem === 'clone-failed'),
      ).toBe(false)
      await waitUntil(async () => {
        const found = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)
        return found?.leadRunId !== undefined
      }, 'the queued Task to start once the clone is done')
    },
  )
})

describe('local folder banner', () => {
  test('a missing local folder raises a Locate banner that picks a new folder', async () => {
    const client = await start()
    const folder = await userFolder()
    const factory = await client.ok<Factory>('POST', '/factories', {
      name: 'Widgets',
      key: 'WI',
      repos: [{ source: { folder }, name: 'widgets' }],
      showTutorial: false,
    })
    await untilCloned(client, factory.id)
    const moved = path.join(scratch, 'moved')
    await rename(folder, moved)

    await client.ok('GET', '/factories')
    const banner = (await client.ok<Banner[]>('GET', '/banners')).find(
      (b) => b.problem === 'local-folder-missing',
    )
    expect(banner).toMatchObject({
      factoryId: factory.id,
      severity: 'warning',
      text: 'Local folder for widgets not found',
      action: { label: 'Locate', choose: 'folder' },
    })

    const route = `/banners/${encodeURIComponent(banner?.id ?? '')}/action`
    expect((await client.call('POST', route)).status).toBe(400)
    await client.ok('POST', route, { folder: moved })
    expect(
      (await client.ok<Banner[]>('GET', '/banners')).some(
        (b) => b.problem === 'local-folder-missing',
      ),
    ).toBe(false)
    const [updated] = await client.ok<Factory[]>('GET', '/factories')
    expect(updated?.repos[0]?.localFolder).toEqual({ path: moved, found: true })
  })
})

test('clone progress reads git’s phases', () => {
  expect(parseProgress('Receiving objects:  64% (640/1000), 212.00 MiB | 3.00 MiB/s')).toEqual({
    percent: 59,
    detail: 'Receiving objects · 212.00 MiB',
  })
  expect(parseProgress('Resolving deltas: 100% (10/10), done.')).toEqual({
    percent: 100,
    detail: 'Resolving deltas',
  })
  expect(parseProgress('Cloning into x...')).toBeUndefined()
})

async function snapshot(folder: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'find',
    [folder, '-newer', path.join(folder, '.git', 'HEAD'), '-print'],
    {},
  )
  const status = await execFileAsync('git', ['status', '--porcelain', '--ignored'], { cwd: folder })
  const refs = await execFileAsync('git', ['for-each-ref'], { cwd: folder })
  return `${stdout}\n${status.stdout}\n${refs.stdout}`
}
