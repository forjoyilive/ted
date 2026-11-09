import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type AgentHealth, type Banner, type Factory, type Task, tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import {
  api,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  rawRequest,
  stubClaudePath,
  stubCodexPath,
  tokenFor,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined
let opened: string[]

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-health-'))
  origin = await makeOriginRepo(scratch)
  opened = []
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

const setStub = (agent: 'claude' | 'codex', state: { version?: string; signedIn?: boolean }) =>
  writeFile(path.join(home, `stub-${agent}.json`), JSON.stringify(state))

async function start(options: { codex?: boolean } = {}) {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    codexBin: options.codex ? stubCodexPath : path.join(scratch, 'no-codex-here'),
    fixPollMs: 100,
    checkAgentsOnStart: true,
    integrations: {
      openTerminal: async (command) => {
        opened.push(command)
      },
    },
  })
  const client = api(daemon.port, await tokenFor(home))
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  return { ...client, ok }
}

type Client = Awaited<ReturnType<typeof start>>

const healthOf = async (client: Client, agent: string) =>
  (await client.ok<AgentHealth[]>('GET', '/agents/health')).find((h) => h.agent === agent)

const getTask = async (client: Client, id: string) =>
  (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)

const agentBanner = async (client: Client, agent: string) =>
  (await client.ok<Banner[]>('GET', '/banners')).find(
    (b) => b.id === `agent-unavailable:app:${agent}`,
  )

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })

const startTask = (client: Client, title: string, agent?: 'claude' | 'codex') =>
  client.ok<Task>('POST', '/tasks', {
    title,
    factory: 'NB',
    start: true,
    ...(agent && { lead: { agent } }),
  })

describe('Agent health', () => {
  test('a Ready agent shows its version against the minimum, its path and its account', async () => {
    const client = await start()

    const claude = await waitUntil(() => healthOf(client, 'claude'), 'Claude Code’s health')
    expect(claude).toMatchObject({
      state: 'ready',
      version: '2.1.319',
      minimumVersion: '2.1.111',
      path: stubClaudePath,
      account: 'Signed in as stub@example.com · Claude Max · subscription',
      pausedRuns: 0,
    })
    expect(claude.fix).toBeUndefined()

    const codex = await waitUntil(() => healthOf(client, 'codex'), 'Codex’s health')
    expect(codex).toMatchObject({
      state: 'not-installed',
      reason: 'Codex isn’t installed',
      fix: { label: 'Install', command: 'npm install -g @openai/codex' },
    })
    expect(await agentBanner(client, 'codex')).toBeUndefined()
  })

  test('an agent below the minimum version is too old and offers its update command', async () => {
    await setStub('claude', { version: '2.0.5' })
    const client = await start()

    const claude = await waitUntil(async () => {
      const h = await healthOf(client, 'claude')
      return h?.state === 'too-old' ? h : undefined
    }, 'Claude Code to be too old')
    expect(claude).toMatchObject({
      version: '2.0.5',
      reason: 'Claude Code needs an update',
      fix: { label: 'Update', command: 'claude update' },
    })
  })

  test('a signed-out agent pauses its Tasks; Fix opens sign-in and the Task continues by itself', async () => {
    await setStub('claude', { signedIn: false })
    const client = await start({ codex: true })

    const claudeTask = await startTask(client, steps({ say: 'hello' }))
    const paused = await waitUntil(async () => {
      const t = await getTask(client, claudeTask.id)
      return t?.status?.kind === 'paused' ? t : undefined
    }, 'the Claude Task to pause')
    expect(paused.status).toEqual({ kind: 'paused', reason: 'Claude Code is signed out' })
    expect(paused.leadRunId).toBeUndefined()

    const banner = await waitUntil(() => agentBanner(client, 'claude'), 'the Claude banner')
    expect(banner).toMatchObject({
      severity: 'stops-work',
      text: 'Claude Code is signed out · 1 Run paused',
      action: { label: 'Fix' },
    })
    expect((await healthOf(client, 'claude'))?.pausedRuns).toBe(1)
    expect((await client.ok<{ runs: { active: number } }>('GET', '/activity')).runs.active).toBe(1)

    const codexTask = await startTask(client, steps({ say: 'hi' }), 'codex')
    await waitUntil(async () => (await getTask(client, codexTask.id))?.leadRunId, 'the Codex Run')

    await client.ok('POST', `/banners/${encodeURIComponent(banner.id)}/action`)
    expect(opened).toEqual(['claude auth login'])

    await setStub('claude', { signedIn: true })
    const continued = await waitUntil(
      async () => {
        const t = await getTask(client, claudeTask.id)
        return t?.leadRunId ? t : undefined
      },
      'the Claude Task to continue',
      15_000,
    )
    expect(continued.status?.kind).not.toBe('paused')
    await waitUntil(
      async () => ((await agentBanner(client, 'claude')) ? undefined : true),
      'the banner to clear',
    )
  })

  test('a Run that stops on an auth error resumes its session once the agent can run again', async () => {
    const client = await start()
    const go = path.join(scratch, 'go')
    const task = await startTask(client, steps({ waitFor: go }, { authError: true }, { exit: 1 }))
    const first = await waitUntil(
      async () => (await getTask(client, task.id))?.leadRunId,
      'the first Run',
    )

    await setStub('claude', { signedIn: false })
    await writeFile(go, '')
    const held = await waitUntil(async () => {
      const t = await getTask(client, task.id)
      return t?.status?.kind === 'paused' ? t : undefined
    }, 'the Task to pause')
    expect(held.status).toEqual({ kind: 'paused', reason: 'Claude Code is signed out' })

    await setStub('claude', { signedIn: true })
    const checked = await client.ok<AgentHealth[]>('POST', '/agents/health/check')
    expect(checked.find((h) => h.agent === 'claude')?.state).toBe('ready')
    const second = await waitUntil(async () => {
      const id = (await getTask(client, task.id))?.leadRunId
      return id !== first ? id : undefined
    }, 'the resumed Run')
    const firstRun = (await client.getRun(first)).run
    const launch = JSON.parse(
      await readFile(path.join(home, 'runs', second, 'launch.json'), 'utf8'),
    ) as { args: string[] }
    expect(launch.args[launch.args.indexOf('--resume') + 1]).toBe(firstRun.sessionId)
    expect(firstRun.sessionId).toBeDefined()
  })

  test('Runs can’t read agent health, check it or open a fix', async () => {
    const client = await start()
    await waitUntil(() => healthOf(client, 'claude'), 'Claude Code’s health')
    const runToken = (await loadRunTokens(tedPaths(home).runTokenKey)).issue('run-1')
    const asRun = (method: string, route: string) =>
      rawRequest(daemon?.port ?? 0, {
        method,
        path: route,
        headers: { authorization: `Bearer ${runToken}` },
      })

    expect((await asRun('GET', '/agents/health')).status).toBe(403)
    expect((await asRun('POST', '/agents/health/check')).status).toBe(403)
    expect((await asRun('POST', '/agents/claude/fix')).status).toBe(403)
    expect(opened).toEqual([])
  })

  test('Fix answers 409 when the agent needs no fix', async () => {
    const client = await start()
    await waitUntil(() => healthOf(client, 'claude'), 'Claude Code’s health')
    const res = await client.call('POST', '/agents/claude/fix')
    expect(res.status).toBe(409)
    expect(opened).toEqual([])
  })
})
