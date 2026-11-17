import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type AgentHealth,
  antigravityPlanNotice,
  type Banner,
  type Factory,
  type RunChat,
  type RunSlots,
  type Task,
  tedPaths,
} from '@ted/protocol'
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

const setStub = (
  agent: 'claude' | 'codex',
  state: { version?: string; signedIn?: boolean; authMethod?: string; apiKeySource?: string },
) => writeFile(path.join(home, `stub-${agent}.json`), JSON.stringify(state))

async function start(options: { codex?: boolean; antigravity?: boolean } = {}) {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    antigravityBin: options.antigravity
      ? fileURLToPath(new URL('./fixtures/stub-antigravity.ts', import.meta.url))
      : path.join(scratch, 'no-agy-here'),
    codexBin: options.codex ? stubCodexPath : path.join(scratch, 'no-codex-here'),
    fixPollMs: 100,
    checkAgentsOnStart: true,
    integrations: {
      openTerminal: async (command) => {
        opened.push(command)
      },
    },
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
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

  test('a CLI signed in with an API key under Subscription offers a subscription sign-in', async () => {
    await setStub('claude', { authMethod: 'console' })
    await setStub('codex', { signedIn: false })
    const client = await start({ codex: true })

    const claude = await waitUntil(async () => {
      const h = await healthOf(client, 'claude')
      return h?.state === 'wrong-credential' ? h : undefined
    }, 'Claude Code to report an API key')
    expect(claude.fix).toEqual({ label: 'Sign in', command: 'claude auth login' })

    await client.ok('POST', '/agents/claude/fix')
    expect(opened).toEqual(['claude auth login'])

    const codex = await waitUntil(async () => {
      const h = await healthOf(client, 'codex')
      return h?.state === 'signed-out' ? h : undefined
    }, 'Codex to offer sign-in for TED storage')
    const folder = path.join(home, 'codex')
    const command = `env CODEX_HOME='${folder}' CODEX_SQLITE_HOME='${folder}' codex login`
    expect(codex.fix).toEqual({ label: 'Sign in', command })
    await client.ok('POST', '/agents/codex/fix')
    expect(opened).toEqual(['claude auth login', command])
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

  test('a signed-out agent pauses its queued Tasks; Fix opens sign-in and the Task continues by itself', async () => {
    await setStub('claude', { signedIn: false })
    const client = await start({ codex: true })
    const banner = await waitUntil(() => agentBanner(client, 'claude'), 'the Claude banner')
    expect(banner).toMatchObject({
      severity: 'stops-work',
      text: 'Claude Code is signed out',
      action: { label: 'Fix', section: 'agents' },
    })

    const claudeTask = await startTask(client, steps({ say: 'hello' }))
    const paused = await waitUntil(async () => {
      const t = await getTask(client, claudeTask.id)
      return t?.status?.kind === 'paused' ? t : undefined
    }, 'the Claude Task to pause')
    expect(paused.status).toEqual({ kind: 'paused', reason: 'Claude Code is signed out' })
    expect(paused.activity).toBe('Queued · 1st')
    expect(paused.leadRunId).toBeUndefined()

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

  test('a held Task Lead waits for a free slot before it continues', async () => {
    const client = await start({ codex: true })
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const goA = path.join(scratch, 'go-a')
    const goB = path.join(scratch, 'go-b')
    const a = await startTask(client, steps({ waitFor: goA }, { authError: true }, { exit: 1 }))
    const firstA = await waitUntil(async () => (await getTask(client, a.id))?.leadRunId, 'A’s Run')
    const b = await startTask(client, steps({ waitFor: goB }, { endTurn: true }), 'codex')

    await setStub('claude', { signedIn: false })
    await writeFile(goA, '')
    const holdsSlot = async (id: string) =>
      (await client.ok<RunSlots>('GET', '/slots')).holders.some(
        (h) => h.kind === 'task' && h.taskId === id && h.runs > 0,
      )
    await waitUntil(() => holdsSlot(b.id), 'B to take the free slot')
    await waitUntil(
      async () => (await getTask(client, a.id))?.status?.kind === 'paused' || undefined,
      'A to be paused',
    )

    await setStub('claude', { signedIn: true })
    await client.ok('POST', '/agents/health/check')
    await waitUntil(
      async () => (await getTask(client, a.id))?.status?.kind !== 'paused' || undefined,
      'A to stop being paused',
    )
    const later = await client.ok<Task>('POST', '/tasks', {
      title: steps({ endTurn: true }),
      factory: 'NB',
    })
    await client.ok('POST', `/tasks/${later.id}/start`)
    expect((await getTask(client, a.id))?.leadRunId).toBe(firstA)
    expect(await holdsSlot(a.id)).toBe(false)
    expect(await holdsSlot(b.id)).toBe(true)
    expect(await holdsSlot(later.id)).toBe(false)
    await client.ok('POST', `/tasks/${later.id}/stop`)

    await writeFile(goB, '')
    await waitUntil(async () => {
      const id = (await getTask(client, a.id))?.leadRunId
      return id !== firstA ? id : undefined
    }, 'A to continue once B’s slot frees')
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
    const banner = await waitUntil(async () => {
      const b = await agentBanner(client, 'claude')
      return b?.text.endsWith('1 Run paused') ? b : undefined
    }, 'the banner to count the held Run')
    expect(banner.text).toBe('Claude Code is signed out · 1 Run paused')
    await expect
      .poll(() => client.ok<{ runs: { active: number; queued: number } }>('GET', '/activity'))
      .toMatchObject({ runs: { active: 0, queued: 1 } })

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

test('Antigravity ACP failures offer repair guidance instead of sign-in and recover after repair', async () => {
  const state = path.join(home, 'stub-antigravity-health.json')
  await writeFile(state, JSON.stringify({ help: 'Unrelated CLI help' }))
  const client = await start({ antigravity: true })
  const unsupported = await waitUntil(async () => {
    const health = await healthOf(client, 'antigravity')
    return health?.state === 'unavailable' ? health : undefined
  }, 'ACP capability failure')
  expect(unsupported.reason).toContain('does not advertise ACP support')
  expect(unsupported.fix).toEqual({ label: 'Update', command: 'agy update' })
  expect((await agentBanner(client, 'antigravity'))?.text).toContain('ACP support')
  await writeFile(state, JSON.stringify({ code: 1 }))
  const failed = (await client.ok<AgentHealth[]>('POST', '/agents/health/check')).find(
    (h) => h.agent === 'antigravity',
  )
  expect(failed).toMatchObject({
    state: 'unavailable',
    reason: expect.stringContaining('ACP check failed'),
  })
  expect(failed?.fix).toBeUndefined()
  expect((await agentBanner(client, 'antigravity'))?.action).toMatchObject({
    opens: { kind: 'settings', section: 'agents' },
  })
  await writeFile(state, '{}')
  const repaired = (await client.ok<AgentHealth[]>('POST', '/agents/health/check')).find(
    (h) => h.agent === 'antigravity',
  )
  expect(repaired).toMatchObject({ state: 'unavailable', reason: antigravityPlanNotice })
  expect(repaired?.fix).toBeUndefined()
  expect((await agentBanner(client, 'antigravity'))?.action).toMatchObject({
    opens: { kind: 'settings', section: 'agents' },
  })
  await client.ok('PATCH', '/settings', { antigravityPlanAccepted: true })
  const accepted = await waitUntil(async () => {
    const health = await healthOf(client, 'antigravity')
    return health?.state === 'unavailable' ? undefined : health
  }, 'Antigravity to be checked again once the Google plan is accepted')
  expect(accepted.state).toBe('signed-out')
  await client.ok('PATCH', '/settings', {
    antigravityPlanAccepted: false,
    billing: { claude: 'subscription', codex: 'subscription', antigravity: 'api-key' },
  })
  await waitUntil(async () => {
    const health = await healthOf(client, 'antigravity')
    return health?.reason?.includes('GEMINI_API_KEY') ? health : undefined
  }, 'API-key billing to need a key, not the plan notice')
})

test('off agents skip routine checks and setup banners until re-enabled', async () => {
  await setStub('claude', { signedIn: false })
  const client = await start()
  await waitUntil(
    async () => (await healthOf(client, 'claude'))?.state === 'signed-out',
    'signed-out health',
  )
  expect(await agentBanner(client, 'claude')).toBeDefined()
  await client.ok('POST', '/agents/availability', { agent: 'claude', enabled: false })
  expect(await agentBanner(client, 'claude')).toBeUndefined()
  await setStub('claude', { signedIn: true })
  await client.ok('POST', '/agents/health/check')
  expect((await healthOf(client, 'claude'))?.state).toBe('signed-out')
  expect(await agentBanner(client, 'claude')).toBeUndefined()
  await client.ok('POST', '/agents/availability', { agent: 'claude', enabled: true })
  await waitUntil(
    async () => (await healthOf(client, 'claude'))?.state === 'ready',
    'fresh check after enabling',
  )
})

test('Runs kept going still receive runtime authentication safeguards while the agent is off', async () => {
  const client = await start()
  const release = path.join(scratch, 'report-auth-error')
  const run = await client.ok<{ id: string }>('POST', '/dev/runs', {
    agent: 'claude',
    cwd: scratch,
    prompt: steps({ waitFor: release }, { authError: true }),
  })
  await client.ok('POST', '/agents/availability', {
    agent: 'claude',
    enabled: false,
    existing: 'keep',
    confirmedRunIds: [run.id],
  })
  await setStub('claude', { signedIn: false })
  await writeFile(release, '')
  await waitUntil(
    async () => (await healthOf(client, 'claude'))?.state === 'signed-out',
    'retained Run authentication failure',
  )
  expect(await agentBanner(client, 'claude')).toBeDefined()
  expect(
    (await client.ok<{ enabledAgents: string[] }>('GET', '/settings')).enabledAgents,
  ).not.toContain('claude')
  await setStub('claude', { signedIn: true })
  await client.ok('POST', '/agents/health/check')
  await waitUntil(
    async () => (await healthOf(client, 'claude'))?.state === 'ready',
    'retained Run authentication recovery',
  )
})

test('a retained off-kind Run clears a runtime credential warning and continues with the same ID', async () => {
  const client = await start()
  const run = await client.ok<{ id: string }>('POST', '/dev/runs', {
    agent: 'claude',
    cwd: scratch,
    prompt: steps({ endTurn: true }),
  })
  await waitUntil(
    async () => (await client.getRun(run.id)).run.state === 'idle',
    'idle retained Run',
  )
  await client.ok('POST', '/agents/availability', {
    agent: 'claude',
    enabled: false,
    existing: 'keep',
    confirmedRunIds: [run.id],
  })
  await setStub('claude', { apiKeySource: 'ANTHROPIC_API_KEY' })
  await client.ok('POST', `/runs/${run.id}/messages`, {
    text: steps({ waitFor: path.join(scratch, 'credential-turn') }),
  })
  await waitUntil(
    async () => (await healthOf(client, 'claude'))?.state === 'wrong-credential',
    'runtime credential warning',
  )
  await waitUntil(
    async () => (await client.getRun(run.id)).run.state === 'idle',
    'credential interruption to settle',
  )
  await setStub('claude', { apiKeySource: 'none', signedIn: true })
  const checked = await client.ok<AgentHealth[]>('POST', '/agents/health/check')
  expect(checked.find((health) => health.agent === 'claude')?.state).toBe('ready')
  await waitUntil(async () => {
    const current = await client.getRun(run.id)
    return current.conversation.some((entry) => entry.line.includes('Carry on where you left off.'))
  }, 'same-ID credential recovery')
  expect((await client.ok<RunChat>('GET', `/runs/${run.id}/chat`)).run.paused).toBeUndefined()
  expect((await client.getRun(run.id)).run.state).not.toBe('finished')
  expect(
    (await client.ok<{ enabledAgents: string[] }>('GET', '/settings')).enabledAgents,
  ).not.toContain('claude')
})
