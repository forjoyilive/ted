import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DaemonClient, type IntegrationsHealth, readDaemonInfo } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createBanners } from '../src/banners.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { createIntegrations, type Integrations } from '../src/integrations.ts'
import { openStore, type TedStore } from '../src/store/index.ts'
import { terminalScript } from '../src/terminal.ts'
import { makeTempHome, rawRequest, stubClaudePath } from './helpers.ts'

const stubGh = fileURLToPath(new URL('./fixtures/stub-gh.ts', import.meta.url))

const ready = (overrides: Record<string, unknown> = {}) => ({
  state: 'success',
  active: true,
  host: 'github.com',
  login: 'forjoyilive',
  tokenSource: 'keyring',
  scopes: 'gist, read:org, repo, workflow',
  gitProtocol: 'https',
  ...overrides,
})

let dir: string
let statePath: string
let logPath: string
let store: TedStore
let integrations: Integrations | undefined
let opened: string[]

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-integrations-'))
  statePath = path.join(dir, 'gh-state.json')
  logPath = path.join(dir, 'gh-log.jsonl')
  await writeFile(statePath, '{}')
  process.env.TED_STUB_GH = statePath
  process.env.TED_STUB_GH_LOG = logPath
  store = await openStore({ directory: path.join(dir, 'store') })
  opened = []
})

afterEach(async () => {
  integrations?.close()
  integrations = undefined
  await store.close()
  delete process.env.TED_STUB_GH
  delete process.env.TED_STUB_GH_LOG
  await rm(dir, { recursive: true, force: true })
})

async function setGh(state: Record<string, unknown>): Promise<void> {
  await writeFile(statePath, JSON.stringify(state))
}

async function ghCalls(): Promise<{ args: string[]; env: Record<string, string> }[]> {
  const text = await readFile(logPath, 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
}

function start(options: { ghBin?: string; platform?: NodeJS.Platform; now?: () => Date } = {}) {
  const banners = createBanners({ store })
  integrations = createIntegrations({
    store,
    banners,
    ghBin: options.ghBin ?? stubGh,
    openTerminal: async (command) => {
      opened.push(command)
    },
    watchAfterFix: { everyMs: 20, forMs: 2_000 },
    platform: options.platform ?? 'darwin',
    ...(options.now && { now: options.now }),
  })
  return { integrations, banners }
}

describe('GitHub health', () => {
  test('a signed-in host is ready, with its login, token source, protocol, scopes and gh', async () => {
    await setGh({ hosts: { 'github.com': [ready()] } })
    const { integrations } = start()

    const health = await integrations.check()

    expect(health.github).toEqual({
      cli: { state: 'ready', version: '2.89.0', path: stubGh },
      hosts: [
        {
          host: 'github.com',
          state: 'ready',
          login: 'forjoyilive',
          tokenSource: 'keyring',
          gitProtocol: 'https',
          scopes: ['gist', 'read:org', 'repo', 'workflow'],
          usedBy: [],
        },
      ],
    })
    expect(store.listBanners()).toEqual([])
  })

  test('gh runs with prompts and the update notifier off, and only `auth status --json hosts`', async () => {
    const { integrations } = start()
    await integrations.check()

    const calls = await ghCalls()
    expect(calls.map((c) => c.args)).toEqual([['--version'], ['auth', 'status', '--json', 'hosts']])
    for (const call of calls) {
      expect(call.env).toMatchObject({ GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' })
    }
    await expect(integrations.gh.run(['auth', 'token'])).rejects.toThrow(
      'TED runs only `gh auth status --json hosts` itself',
    )
    await expect(integrations.gh.run(['auth', 'status', '--json', 'hosts', '-t'])).rejects.toThrow()
    expect(await ghCalls()).toHaveLength(2)
  })

  test('signing out raises an app-wide banner whose Fix opens gh auth login, and signing in clears it', async () => {
    await setGh({ hosts: {} })
    const { integrations, banners } = start()

    const health = await integrations.check()

    expect(health.github.hosts).toEqual([
      {
        host: 'github.com',
        state: 'signed-out',
        scopes: [],
        usedBy: [],
        fix: {
          label: 'Sign in',
          command: 'gh auth login --web --hostname github.com -s workflow',
        },
      },
    ])
    expect(store.listBanners()).toMatchObject([
      {
        id: 'github-cli:app',
        severity: 'stops-work',
        text: 'GitHub CLI is signed out · needed to add a Factory',
        action: { label: 'Fix', section: 'integrations' },
      },
    ])

    await banners.act('github-cli:app')
    expect(opened).toEqual(['gh auth login --web --hostname github.com -s workflow'])

    await setGh({ hosts: { 'github.com': [ready()] } })
    await expect.poll(() => store.listBanners(), { timeout: 5_000 }).toEqual([])
    expect(integrations.current()?.github.hosts[0]?.state).toBe('ready')
  })

  test('an expired token counts as signed out', async () => {
    await setGh({
      hosts: { 'github.com': [ready({ state: 'error', error: 'token expired', scopes: '' })] },
    })
    const { integrations } = start()

    const [host] = (await integrations.check()).github.hosts
    expect(host).toMatchObject({ state: 'signed-out', login: 'forjoyilive' })
    expect(store.listBanners()).toHaveLength(1)
  })

  test('HTTPS without the workflow scope is an amber row with Add permission, and no banner', async () => {
    await setGh({ hosts: { 'github.com': [ready({ scopes: 'repo, read:org, gist' })] } })
    const { integrations } = start()

    const [host] = (await integrations.check()).github.hosts
    expect(host).toMatchObject({
      state: 'missing-workflow-scope',
      fix: {
        label: 'Add permission',
        command: 'gh auth refresh --hostname github.com -s workflow',
      },
    })
    expect(store.listBanners()).toEqual([])

    await integrations.fix({ fix: 'gh-refresh', host: 'github.com' })
    expect(opened).toEqual(['gh auth refresh --hostname github.com -s workflow'])
  })

  test('SSH without the workflow scope is ready', async () => {
    await setGh({
      hosts: { 'github.com': [ready({ scopes: 'repo, read:org', gitProtocol: 'ssh' })] },
    })
    const { integrations } = start()

    expect((await integrations.check()).github.hosts[0]?.state).toBe('ready')
  })

  test('gh older than 2.81.0 stops work with an Update fix', async () => {
    await setGh({ version: '2.40.1' })
    const { integrations } = start()

    const { cli } = (await integrations.check()).github
    expect(cli).toEqual({
      state: 'too-old',
      version: '2.40.1',
      path: stubGh,
      fix: { label: 'Update', command: 'brew upgrade gh' },
    })
    expect(store.listBanners()[0]?.text).toBe(
      'GitHub CLI 2.40.1 is too old · TED needs 2.81.0 · needed to add a Factory',
    )
    expect((await ghCalls()).map((c) => c.args)).toEqual([['--version']])
  })

  test('a missing gh stops work with an install command for the platform', async () => {
    const { integrations } = start({ ghBin: path.join(dir, 'no-such-gh'), platform: 'darwin' })

    const { cli } = (await integrations.check()).github
    expect(cli).toEqual({
      state: 'not-installed',
      fix: { label: 'Install', command: 'brew install gh' },
    })
    expect(store.listBanners()[0]?.text).toBe(
      'GitHub CLI isn’t installed · needed to add a Factory',
    )
  })

  test('there is one row per host the Factories use, naming the Factories', async () => {
    store.addFactory({
      key: 'NB',
      name: 'notebook',
      repo: 'kriya/notebook',
      cloneUrl: 'https://github.com/kriya/notebook.git',
      defaultBranch: 'main',
    })
    store.addFactory({
      key: 'MS',
      name: 'Marketing site',
      repo: 'kriya/site',
      cloneUrl: 'git@github.kriya.design:kriya/site.git',
      defaultBranch: 'main',
    })
    await setGh({
      hosts: {
        'github.com': [ready()],
        'github.kriya.design': [
          ready({ host: 'github.kriya.design', login: 'nabha', scopes: 'repo' }),
        ],
      },
    })
    const { integrations } = start()

    const { hosts } = (await integrations.check()).github
    expect(hosts.map((h) => [h.host, h.usedBy, h.state])).toEqual([
      ['github.com', ['notebook'], 'ready'],
      ['github.kriya.design', ['Marketing site'], 'missing-workflow-scope'],
    ])
  })

  test('a host-specific Fix refuses a host that isn’t a hostname', async () => {
    const { integrations } = start()

    await expect(
      integrations.fix({ fix: 'gh-login', host: 'github.com; rm -rf ~' }),
    ).rejects.toThrow('host must be a hostname like github.com')
    expect(opened).toEqual([])
  })

  test('an auth error from gh checks again and raises the banner', async () => {
    const { integrations } = start()
    await integrations.check()
    expect(store.listBanners()).toEqual([])

    await setGh({ hosts: {}, api: { result: 'auth' } })
    await expect(integrations.gh.api('/user')).rejects.toMatchObject({ kind: 'auth' })
    await expect.poll(() => store.listBanners().map((b) => b.id)).toEqual(['github-cli:app'])
  })

  test('a rate limit lasting over 15 minutes raises a warning that clears when a call works', async () => {
    let now = new Date('2026-11-08T14:00:00')
    const { integrations } = start({ now: () => now })
    await setGh({ api: { result: 'rate-limit' } })

    await expect(integrations.gh.api('/user')).rejects.toMatchObject({ kind: 'rate-limit' })
    await expect(integrations.gh.api('/user')).rejects.toMatchObject({ kind: 'rate-limit' })
    expect((await ghCalls()).length).toBe(1)
    expect(store.listBanners()).toEqual([])

    now = new Date('2026-11-08T14:16:00')
    await expect(integrations.gh.api('/user')).rejects.toMatchObject({ kind: 'rate-limit' })
    expect(store.listBanners()).toMatchObject([
      {
        id: 'github-rate-limit:app:github.com',
        severity: 'warning',
        text: 'GitHub rate limit · checking again at 14:18',
      },
    ])

    await setGh({ api: { result: 'ok', body: { login: 'forjoyilive' } } })
    now = new Date('2026-11-08T14:19:00')
    expect(await integrations.gh.api('/user')).toEqual({ login: 'forjoyilive' })
    expect(store.listBanners()).toEqual([])
  })

  test('a health check that works doesn’t reset an API rate limit', async () => {
    let now = new Date('2026-11-08T14:00:00')
    const { integrations } = start({ now: () => now })
    await setGh({ api: { result: 'rate-limit' } })
    await expect(integrations.gh.api('/user')).rejects.toMatchObject({ kind: 'rate-limit' })

    now = new Date('2026-11-08T14:10:00')
    await integrations.check()
    now = new Date('2026-11-08T14:16:00')
    await expect(integrations.gh.api('/user')).rejects.toMatchObject({ kind: 'rate-limit' })

    expect(store.listBanners().map((b) => b.id)).toEqual(['github-rate-limit:app:github.com'])
  })

  test('graphql sends the query and variables on stdin to the host’s gh', async () => {
    const { integrations } = start()
    await setGh({ api: { result: 'ok', body: { data: { viewer: { login: 'nabha' } } } } })

    const result = await integrations.gh.graphql(
      'query($n: Int!) { viewer { login } }',
      { n: 1 },
      { host: 'github.kriya.design' },
    )

    expect(result).toEqual({ data: { viewer: { login: 'nabha' } } })
    const [call] = await ghCalls()
    expect(call).toMatchObject({
      args: ['api', 'graphql', '--input', '-'],
      env: { GH_HOST: 'github.kriya.design' },
    })
    expect(JSON.parse((call as unknown as { stdin: string }).stdin)).toEqual({
      query: 'query($n: Int!) { viewer { login } }',
      variables: { n: 1 },
    })
  })
})

describe('Git health', () => {
  test('Git shows its version, path, name and email', async () => {
    const { integrations } = start()

    const { git } = await integrations.check()

    expect(git.version).toMatch(/^\d+\.\d+/)
    expect(git.path).toMatch(/git$/)
    expect(['ready', 'no-identity']).toContain(git.state)
  })
})

describe('Fix in the user’s terminal', () => {
  test('the script sets the login PATH, echoes the command and runs it', () => {
    const script = terminalScript('gh auth login --web --hostname github.com -s workflow', {
      PATH: "/opt/homebrew/bin:/it's/here",
    })

    expect(script).toBe(
      [
        '#!/bin/sh',
        "export PATH='/opt/homebrew/bin:/it'\\''s/here'",
        "printf '%s\\n\\n' '$ gh auth login --web --hostname github.com -s workflow'",
        'gh auth login --web --hostname github.com -s workflow',
        "printf '\\n%s\\n' 'Done. You can close this window and go back to TED.'",
        '',
      ].join('\n'),
    )
  })
})

describe('integrations over HTTP', () => {
  let home: string
  let cleanup: () => Promise<void>
  let daemon: RunningDaemon | undefined

  beforeEach(async () => {
    ;({ home, cleanup } = await makeTempHome())
  })

  afterEach(async () => {
    await daemon?.stop()
    daemon = undefined
    await cleanup()
  })

  test('the app reads health, checks again and runs a Fix; Runs can’t', async () => {
    const commands: string[] = []
    daemon = await startDaemon({
      home,
      version: '9.9.9',
      claudeBin: stubClaudePath,
      integrations: {
        checkOnStart: true,
        ghBin: stubGh,
        openTerminal: async (command) => {
          commands.push(command)
        },
      },
    })
    const info = await readDaemonInfo(home)
    if (!info) throw new Error('no daemon.json')
    const ted = new DaemonClient(info, daemon?.appToken)

    const health: IntegrationsHealth = await ted.getIntegrations()
    expect(health.github.cli.state).toBe('ready')
    expect((await ted.checkIntegrations()).github.hosts[0]?.state).toBe('ready')
    expect(await ted.runFix({ fix: 'gh-setup-git', host: 'github.com' })).toEqual({
      command: 'gh auth setup-git --hostname github.com',
    })
    expect(commands).toEqual(['gh auth setup-git --hostname github.com'])

    const bad = await rawRequest(daemon.port, {
      method: 'POST',
      path: '/integrations/fix',
      headers: { authorization: `Bearer ${daemon.appToken}` },
      body: JSON.stringify({ fix: 'rm' }),
    })
    expect(bad.status).toBe(400)
  })
})

describe('no code path reads a gh token', () => {
  test('no source file runs `gh auth token` or passes the show-token flag', async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const offenders: string[] = []
    for (const pkg of await readdir(root)) {
      const src = path.join(root, pkg, 'src')
      const files = await readdir(src, { recursive: true }).catch(() => [] as string[])
      for (const file of files) {
        if (!/\.(ts|tsx|cjs|mjs|js)$/.test(file)) continue
        const text = await readFile(path.join(src, file), 'utf8')
        if (/auth['"`]?\s*,?\s*['"`]?token\b|show-token|--show-tok/.test(text)) {
          offenders.push(path.join(pkg, 'src', file))
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
