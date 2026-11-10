import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type {
  Banner,
  Factory,
  FactorySettingsChanges,
  FactorySettingsView,
  RepoSettingsInput,
  SaveSettingsResult,
  SettingsPreview,
} from '@ted/protocol'
import { settingsInput } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  commitToOrigin,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  tokenFor,
  waitUntil,
} from './helpers.ts'

const run = promisify(execFile)

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let ghState: string
let ghLog: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'ted-factory-settings-')))
  origin = await makeOriginRepo(scratch)
  ghState = path.join(scratch, 'gh.json')
  ghLog = path.join(scratch, 'gh.jsonl')
  process.env.TED_STUB_GH = ghState
  process.env.TED_STUB_GH_LOG = ghLog
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  delete process.env.TED_STUB_GH
  delete process.env.TED_STUB_GH_LOG
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

const workflowYaml = [
  'version: 1',
  '# how this Factory works',
  'order: [intake, work, validate, merge]',
  'repos:',
  '  - name: widgets',
  '    worktree:',
  '      setup: npm ci',
  '      env:',
  '        EXPO_NO_TELEMETRY: "1"',
  '      copy: [.env]',
  'stages:',
  '  validate:',
  '    checks:',
  '      - { name: Typecheck, run: npm run typecheck, repo: widgets }',
  '',
].join('\n')

async function start(options: { workflow?: string | null; gh?: Record<string, unknown> } = {}) {
  await writeFile(ghState, JSON.stringify({ merge: { origin, updateBase: true }, ...options.gh }))
  if (options.workflow !== null) {
    await commitToOrigin(scratch, { '.ted/workflow.yaml': options.workflow ?? workflowYaml })
  }
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  const factory = await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const settings = () => ok<FactorySettingsView>('GET', `/factories/${factory.id}/settings`)
  return { ...client, ok, factory, settings }
}

const apiPaths = {
  'repos/acme/api': {
    body: { full_name: 'acme/api', default_branch: 'main', permissions: { push: true } },
  },
  'repos/acme/api/commits?per_page=1': { body: [] },
}

async function originFile(file: string, ref = 'main'): Promise<string> {
  const { stdout } = await run('git', ['show', `${ref}:${file}`], { cwd: origin })
  return stdout
}

async function originBranches(): Promise<string[]> {
  const { stdout } = await run('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], {
    cwd: origin,
  })
  return stdout.split('\n').filter(Boolean)
}

async function ghCalls(): Promise<string[][]> {
  const text = await readFile(ghLog, 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { args: string[] }).args)
}

function edit(
  view: FactorySettingsView,
  change: (repos: RepoSettingsInput[]) => void,
): FactorySettingsChanges {
  const repos = view.repos.map((r) => structuredClone(settingsInput(r)))
  change(repos)
  return { repos }
}

describe('Factory settings', () => {
  test('loads the repos from the default branch’s .ted/workflow.yaml', async () => {
    const client = await start()
    const view = await client.settings()
    expect(view.source).toBe('file')
    expect(view.defaultBranch).toBe('main')
    expect(view.repos).toHaveLength(1)
    expect(view.repos[0]).toMatchObject({
      primary: true,
      repo: 'acme/widgets',
      name: 'widgets',
      was: 'widgets',
      setup: { run: 'npm ci' },
      env: [{ name: 'EXPO_NO_TELEMETRY', value: '1' }],
      copy: ['.env'],
      apps: [],
    })
    expect(view.github).toMatchObject({ ready: true, login: 'stub-user' })
  })

  test('Save and merge commits on a branch, opens a pull request and merges it', async () => {
    const client = await start()
    const view = await client.settings()
    const changes = edit(view, ([primary]) => {
      if (!primary) return
      primary.mergeMethod = 'rebase'
      primary.env.push({ name: 'NODE_ENV', value: 'development' })
      primary.copy.push('.npmrc')
    })

    const preview = await client.ok<SettingsPreview>(
      'POST',
      `/factories/${client.factory.id}/settings/preview`,
      changes,
    )
    expect(preview.valid).toBe(true)
    expect(preview.files.map((f) => f.path)).toEqual(['.ted/workflow.yaml'])
    const added = preview.files[0]?.lines.filter((l) => l.kind === 'added').map((l) => l.text)
    expect(added?.map((t) => t.trim())).toEqual(
      expect.arrayContaining(['merge_method: rebase', 'NODE_ENV: development']),
    )

    const result = await client.ok<SaveSettingsResult>(
      'POST',
      `/factories/${client.factory.id}/settings/save`,
      { changes, mode: 'merge', version: view.version },
    )
    expect(result.merged).toBe(true)
    expect(result.pullRequest.url).toMatch(/\/pull\/\d+$/)

    const merged = await originFile('.ted/workflow.yaml')
    expect(merged).toContain('merge_method: rebase')
    expect(merged).toContain('NODE_ENV: development')
    expect(merged).toContain('# how this Factory works')
    expect(merged).toContain('order: [intake, work, validate, merge]')
    expect(merged).toContain('copy: [.env, .npmrc]')
    expect(merged).toContain('- { name: Typecheck, run: npm run typecheck, repo: widgets }')

    const create = (await ghCalls()).find((args) => args[0] === 'pr' && args[1] === 'create')
    expect(create).toBeDefined()
    expect(create?.[create.indexOf('--title') + 1]).toBe('Update TED settings')
    expect(create?.[create.indexOf('--base') + 1]).toBe('main')
    expect(create).not.toContain('--draft')
    const merge = (await ghCalls()).find((args) => args[0] === 'pr' && args[1] === 'merge')
    expect(merge).toContain('--squash')

    const after = await client.settings()
    expect(after.repos[0]?.mergeMethod).toBe('rebase')
    expect(after.repos[0]?.env).toContainEqual({ name: 'NODE_ENV', value: 'development' })
  })

  test('Save as pull request leaves the pull request open', async () => {
    const client = await start()
    const view = await client.settings()
    const changes = edit(view, ([primary]) => {
      if (primary) primary.baseBranch = 'develop'
    })
    const result = await client.ok<SaveSettingsResult>(
      'POST',
      `/factories/${client.factory.id}/settings/save`,
      { changes, mode: 'pull-request', version: view.version },
    )
    expect(result.merged).toBe(false)
    expect(result.reason).toBeUndefined()
    expect(await originFile('.ted/workflow.yaml')).not.toContain('base_branch')
    const branch = (await originBranches()).find((b) => b !== 'main')
    expect(branch).toMatch(/^ted\/settings-/)
    expect(await originFile('.ted/workflow.yaml', branch)).toContain('base_branch: develop')
    expect((await ghCalls()).some((args) => args[1] === 'merge')).toBe(false)
  })

  test('a default branch that needs a review leaves the pull request open and says why', async () => {
    const client = await start({
      gh: { merge: { origin, reviewDecision: 'REVIEW_REQUIRED', mergeState: 'BLOCKED' } },
    })
    const view = await client.settings()
    const changes = edit(view, ([primary]) => {
      if (primary) primary.copy.push('config/master.key')
    })
    const result = await client.ok<SaveSettingsResult>(
      'POST',
      `/factories/${client.factory.id}/settings/save`,
      { changes, mode: 'merge', version: view.version },
    )
    expect(result.merged).toBe(false)
    expect(result.reason).toMatch(/review/)
    expect(await originFile('.ted/workflow.yaml')).not.toContain('master.key')
  })

  test('the panel never writes an invalid workflow.yaml', async () => {
    const client = await start()
    const view = await client.settings()
    const changes = edit(view, ([primary]) => {
      if (!primary) return
      primary.name = 'Not Valid'
      primary.setup = { run: 'npm ci', timeout: 'forever' }
    })
    const preview = await client.ok<SettingsPreview>(
      'POST',
      `/factories/${client.factory.id}/settings/preview`,
      changes,
    )
    expect(preview.valid).toBe(false)
    expect(preview.problems.map((p) => p.message)).toEqual(
      expect.arrayContaining([
        'a repo `name` uses only lowercase letters, digits and dashes',
        '`timeout` must be a duration such as 30s, 15m or 1h',
      ]),
    )
    const res = await client.call('POST', `/factories/${client.factory.id}/settings/save`, {
      changes,
      mode: 'merge',
      version: view.version,
    })
    expect(res.status).toBe(400)
    expect(await originBranches()).toEqual(['main'])
    expect((await ghCalls()).some((args) => args[0] === 'pr')).toBe(false)
  })

  test('renaming a repo rewrites each Check’s repo: in the same Save', async () => {
    const client = await start()
    const view = await client.settings()
    const changes = edit(view, ([primary]) => {
      if (primary) primary.name = 'app'
    })
    await client.ok('POST', `/factories/${client.factory.id}/settings/save`, {
      changes,
      mode: 'merge',
      version: view.version,
    })
    const merged = await originFile('.ted/workflow.yaml')
    expect(merged).toContain('- name: app')
    expect(merged).toContain('repo: app }')
    expect(merged).not.toContain('widgets')
  })

  test('a Factory with no .ted/ gets one with repos', async () => {
    const client = await start({ workflow: null })
    const view = await client.settings()
    expect(view.source).toBe('none')
    expect(view.repos[0]).toMatchObject({ name: 'widgets', primary: true, env: [], copy: [] })
    const changes = edit(view, ([primary]) => {
      if (primary) primary.setup = { run: 'pnpm install' }
    })
    await client.ok('POST', `/factories/${client.factory.id}/settings/save`, {
      changes,
      mode: 'merge',
      version: view.version,
    })
    expect(await originFile('.ted/workflow.yaml')).toBe(
      [
        'version: 1',
        'repos:',
        '  - name: widgets',
        '    worktree:',
        '      setup: pnpm install',
        '',
      ].join('\n'),
    )
  })

  test('a save refuses settings that changed on GitHub after the page loaded', async () => {
    const client = await start()
    const view = await client.settings()
    await commitToOrigin(scratch, { '.ted/workflow.yaml': `${workflowYaml}# edited elsewhere\n` })
    const changes = edit(view, ([primary]) => {
      if (primary) primary.mergeMethod = 'merge'
    })
    const res = await client.call('POST', `/factories/${client.factory.id}/settings/save`, {
      changes,
      mode: 'merge',
      version: view.version,
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/changed on GitHub/)
  })

  test('saving is refused with the reason while GitHub is signed out', async () => {
    const client = await start({ gh: { hosts: {} } })
    const view = await client.settings()
    expect(view.github.ready).toBe(false)
    expect(view.github.problem).toMatch(/signed out/i)
    const changes = edit(view, ([primary]) => {
      if (primary) primary.mergeMethod = 'merge'
    })
    const res = await client.call('POST', `/factories/${client.factory.id}/settings/save`, {
      changes,
      mode: 'merge',
      version: view.version,
    })
    expect(res.status).toBe(409)
    expect(await originBranches()).toEqual(['main'])
  })

  test('a repo added to .ted/workflow.yaml outside TED waits for the user to add it', async () => {
    const second = path.join(scratch, 'acme', 'api.git')
    await run('git', ['init', '--bare', '--initial-branch=main', second])
    await run('git', ['push', second, 'main'], { cwd: path.join(scratch, 'seed') })
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = `url.file://${scratch}/.insteadOf`
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/'
    try {
      const client = await start({ gh: { paths: apiPaths } })
      await commitToOrigin(scratch, {
        '.ted/workflow.yaml': workflowYaml.replace(
          'stages:',
          '  - name: api\n    remote: https://github.com/acme/api.git\nstages:',
        ),
      })
      await client.settings()
      const factories = await client.ok<Factory[]>('GET', '/factories')
      expect(factories[0]?.repos.map((r) => r.name)).toEqual(['widgets'])
      const banners = await client.ok<Banner[]>('GET', '/banners')
      const ask = banners.find((b) => b.problem === 'repo-in-workflow')
      expect(ask?.text).toBe(
        '.ted/workflow.yaml adds acme/api · TED clones it only once you add it here',
      )
      expect(
        await stat(path.join(home, 'repos', 'acme', 'api')).then(
          () => true,
          () => false,
        ),
      ).toBe(false)

      await client.ok('POST', `/banners/${encodeURIComponent(ask?.id ?? '')}/action`, {})
      const after = await client.ok<Factory[]>('GET', '/factories')
      expect(after[0]?.repos.map((r) => r.name)).toEqual(['widgets', 'api'])
      await waitUntil(
        () =>
          stat(path.join(home, 'repos', 'acme', 'api', '.git')).then(
            () => true,
            () => false,
          ),
        'the added repo to be cloned',
      )
      const left = await client.ok<Banner[]>('GET', '/banners')
      expect(left.some((b) => b.problem === 'repo-in-workflow')).toBe(false)
    } finally {
      delete process.env.GIT_CONFIG_COUNT
      delete process.env.GIT_CONFIG_KEY_0
      delete process.env.GIT_CONFIG_VALUE_0
    }
  })

  test('repos that would leave TED’s repos folder, or more than 10, are refused', async () => {
    const client = await start()
    const view = await client.settings()
    const changes = edit(view, (repos) => {
      repos.push({
        repo: 'acme/..',
        remote: 'https://github.com/acme/..',
        name: 'up',
        env: [],
        copy: [],
        apps: [],
      })
    })
    const preview = await client.ok<SettingsPreview>(
      'POST',
      `/factories/${client.factory.id}/settings/preview`,
      changes,
    )
    expect(preview.valid).toBe(false)
    expect(preview.problems.map((p) => p.message)).toContain('up needs a GitHub remote.')

    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': workflowYaml.replace(
        'stages:',
        '  - name: up\n    remote: ../..\nstages:',
      ),
    })
    const traversal = await client.settings()
    expect(traversal.source).toBe('last-valid')
    expect(traversal.problems.map((p) => p.message)).toContain('`remote` must be a GitHub repo')

    const many = Array.from(
      { length: 10 },
      (_, i) => `  - name: r${i}\n    remote: acme/r${i}\n`,
    ).join('')
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': workflowYaml.replace('stages:', `${many}stages:`),
    })
    const tooMany = await client.settings()
    expect(tooMany.problems.map((p) => p.message)).toContain('a Factory has at most 10 repos')
    expect((await client.ok<Factory[]>('GET', '/factories'))[0]?.repos).toHaveLength(1)
  })

  test('adding a repo and Apps writes them, and the Factory gains the repo once it merges', async () => {
    const second = path.join(scratch, 'acme', 'api.git')
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = `url.file://${scratch}/.insteadOf`
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/'
    try {
      const client = await start({ gh: { paths: apiPaths } })
      const view = await client.settings()
      const changes = edit(view, (repos) => {
        repos[0]?.apps.push({
          name: 'Web',
          kind: 'web',
          run: 'npm run web -- --port $PORT',
          url: `http://localhost:\${PORT}`,
        })
        repos.push({
          repo: 'acme/api',
          remote: 'https://github.com/acme/api.git',
          name: 'api',
          env: [],
          copy: [],
          apps: [{ name: 'API', kind: 'command', run: 'bin/rails server -p $PORT' }],
        })
      })
      const preview = await client.ok<SettingsPreview>(
        'POST',
        `/factories/${client.factory.id}/settings/preview`,
        changes,
      )
      expect(preview.sideEffects.join(' ')).toMatch(/clones acme\/api/)
      const result = await client.ok<SaveSettingsResult>(
        'POST',
        `/factories/${client.factory.id}/settings/save`,
        { changes, mode: 'merge', version: view.version },
      )
      expect(result.merged).toBe(true)
      const merged = await originFile('.ted/workflow.yaml')
      expect(merged).toContain(
        [
          '    apps:',
          '      - name: Web',
          '        run: npm run web -- --port $PORT',
          `        url: http://localhost:\${PORT}`,
          '  - name: api',
          '    remote: https://github.com/acme/api.git',
          '    apps:',
          '      - name: API',
          '        kind: command',
          '        run: bin/rails server -p $PORT',
        ].join('\n'),
      )
      const factories = await client.ok<Factory[]>('GET', '/factories')
      expect(factories[0]?.repos.map((r) => r.name)).toEqual(['widgets', 'api'])
      const failed = await waitUntil(async () => {
        const shown = await client.ok<Banner[]>('GET', '/banners')
        return shown.find((b) => b.problem === 'clone-failed')
      }, 'the failed clone of the new repo')
      await run('git', ['init', '--bare', '--initial-branch=main', second])
      await run('git', ['push', second, 'main'], { cwd: path.join(scratch, 'seed') })
      await client.ok('POST', `/banners/${encodeURIComponent(failed.id)}/action`, {})
      await waitUntil(
        () =>
          stat(path.join(home, 'repos', 'acme', 'api', '.git')).then(
            () => true,
            () => false,
          ),
        'the new repo to be cloned',
      )
      const banners = await client.ok<Banner[]>('GET', '/banners')
      expect(banners.map((b) => b.text)).toContain(
        'acme/api was added · a New setup Task can set up its Checks and Apps',
      )
      expect(banners.some((b) => b.problem === 'clone-failed')).toBe(false)
    } finally {
      delete process.env.GIT_CONFIG_COUNT
      delete process.env.GIT_CONFIG_KEY_0
      delete process.env.GIT_CONFIG_VALUE_0
    }
  })

  test('a broken .ted/workflow.yaml loads the last valid version, and saving replaces it', async () => {
    const client = await start()
    await commitToOrigin(scratch, { '.ted/workflow.yaml': 'version: 1\norder: [work]\n' })
    const view = await client.settings()
    expect(view.source).toBe('last-valid')
    expect(view.problems.map((p) => p.message)).toContain('`order` must start with `intake`')
    expect(view.repos[0]?.setup).toEqual({ run: 'npm ci' })
    const changes = edit(view, ([primary]) => {
      if (primary) primary.mergeMethod = 'merge'
    })
    await client.ok('POST', `/factories/${client.factory.id}/settings/save`, {
      changes,
      mode: 'merge',
      version: view.version,
    })
    const merged = await originFile('.ted/workflow.yaml')
    expect(merged).toContain('order: [intake, work, validate, merge]')
    expect(merged).toContain('merge_method: merge')
    expect((await client.settings()).source).toBe('file')
  })

  test('only the TED app can change Factory settings', async () => {
    const client = await start()
    const view = await client.settings()
    const fileToken = api(daemon?.port ?? 0, await tokenFor(home))
    const id = client.factory.id
    const changes = edit(view, ([primary]) => {
      if (primary) primary.mergeMethod = 'merge'
    })
    const refused = { status: 403, body: { error: 'only the TED app can do this' } }
    expect(
      await fileToken.call('POST', `/factories/${id}/settings/save`, {
        changes,
        mode: 'merge',
        version: view.version,
      }),
    ).toEqual(refused)
    expect(await fileToken.call('POST', `/factories/${id}/settings/preview`, changes)).toEqual(
      refused,
    )
    expect(await fileToken.call('PUT', `/factories/${id}/name`, { name: 'X' })).toEqual(refused)
    expect(
      await fileToken.call('PUT', `/factories/${id}/repos/widgets/local-folder`, { path: scratch }),
    ).toEqual(refused)
    expect(await fileToken.call('DELETE', `/factories/${id}/repos/widgets/local-folder`)).toEqual(
      refused,
    )
    expect(await originBranches()).toEqual(['main'])
  })

  test('the name and local folders save at once on this Mac', async () => {
    const client = await start()
    const renamed = await client.ok<Factory>('PUT', `/factories/${client.factory.id}/name`, {
      name: 'Notebook',
    })
    expect(renamed.name).toBe('Notebook')
    expect((await client.ok<Factory[]>('GET', '/factories'))[0]?.name).toBe('Notebook')

    const folder = path.join(scratch, 'my-widgets')
    await mkdir(folder)
    await writeFile(path.join(folder, '.env'), 'A=1\n')
    await client.ok('PUT', `/factories/${client.factory.id}/repos/widgets/local-folder`, {
      path: folder,
    })
    expect((await client.settings()).repos[0]?.localFolder).toEqual({
      path: folder,
      found: true,
      copies: [{ path: '.env', found: true }],
    })
    await client.ok('DELETE', `/factories/${client.factory.id}/repos/widgets/local-folder`)
    expect((await client.settings()).repos[0]?.localFolder).toBeUndefined()
  })
})
