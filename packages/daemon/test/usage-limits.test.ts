import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type AgentHealth,
  type Banner,
  DaemonClient,
  defaultMachineSettings,
  type Factory,
  type RunChat,
  type RunWithConversation,
  resetTime,
  type Task,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  stubCodexPath,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined
let online: boolean

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-limits-'))
  origin = await makeOriginRepo(scratch)
  online = true
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

const setStub = (agent: 'claude' | 'codex', state: Record<string, unknown>) =>
  writeFile(path.join(home, `stub-${agent}.json`), JSON.stringify(state))

async function start(
  options: {
    stallAfterMs?: number
    healthIntervalMs?: number
    isOnline?: () => Promise<boolean>
  } = {},
) {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    codexBin: stubCodexPath,
    checkAgentsOnStart: true,
    limitProbeMs: 1000,
    ...(options.healthIntervalMs !== undefined && { healthIntervalMs: options.healthIntervalMs }),
    online: {
      isOnline: options.isOnline ?? (async () => online),
      onlineEveryMs: 100,
      offlineEveryMs: 100,
    },
    ...(options.stallAfterMs !== undefined && { stallAfterMs: options.stallAfterMs }),
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

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })

const startTask = (client: Client, title: string, agent?: 'claude' | 'codex') =>
  client.ok<Task>('POST', '/tasks', {
    title,
    factory: 'NB',
    start: true,
    ...(agent && { lead: { agent } }),
  })

const getTask = async (client: Client, id: string) =>
  (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)

const healthOf = async (client: Client, agent: string) =>
  (await client.ok<AgentHealth[]>('GET', '/agents/health')).find((h) => h.agent === agent)

const bannerWith = async (client: Client, id: string) =>
  (await client.ok<Banner[]>('GET', '/banners')).find((b) => b.id === id)

const leadRunOf = (client: Client, id: string) =>
  waitUntil(async () => (await getTask(client, id))?.leadRunId, 'the Task Lead Run')

const linesOf = async (client: Client, runId: string) =>
  (await client.ok<RunWithConversation>('GET', `/runs/${runId}`)).conversation.map((e) => e.line)

const continued = (client: Client, runId: string) =>
  waitUntil(
    async () =>
      (await linesOf(client, runId)).some(
        (line) => line.includes('"type":"user"') && line.includes('Carry on where you left off'),
      ) || undefined,
    'the Run to be told to carry on',
    20_000,
  )

const limitEvent = (status: string, extra: Record<string, unknown> = {}) => ({
  emit: { type: 'rate_limit_event', rate_limit_info: { status, ...extra } },
})

const limitReached = {
  emit: {
    type: 'assistant',
    error: 'rate_limit',
    message: { role: 'assistant', content: [{ type: 'text', text: 'You’ve hit your limit' }] },
  },
}

describe('Usage limits', () => {
  test('changing time preferences updates active usage-limit reasons and banners', async () => {
    const client = await start()
    const resetsAt = Math.floor(Date.now() / 1000) + 3600
    const at = new Date(resetsAt * 1000).toISOString()
    await startTask(
      client,
      steps(
        limitEvent('rejected', { resetsAt, rateLimitType: 'five_hour', utilization: 1 }),
        limitReached,
        { endTurn: true },
      ),
    )
    await waitUntil(
      async () => (await healthOf(client, 'claude'))?.state === 'usage-limit',
      'the usage limit',
    )
    for (const preferences of [
      { timeFormat: '24-hour', timeZone: 'UTC' },
      { timeFormat: '12-hour', timeZone: 'Asia/Tokyo' },
    ] as const) {
      await client.ok('PATCH', '/settings', preferences)
      const shown = resetTime(at, undefined, preferences)
      expect((await healthOf(client, 'claude'))?.reason).toBe(`Claude usage limit, resets ${shown}`)
      expect((await bannerWith(client, 'agent-usage-limit:app:claude'))?.text).toContain(
        `resets ${shown}`,
      )
    }
  })

  test('a Claude usage limit pauses Claude until the reset time, then the Run carries on by itself', async () => {
    const client = await start()
    const resetsAt = Math.floor(Date.now() / 1000) + 2
    const task = await startTask(
      client,
      steps(
        limitEvent('rejected', { resetsAt, rateLimitType: 'five_hour', utilization: 1 }),
        limitReached,
        { endTurn: true },
      ),
    )
    const runId = await leadRunOf(client, task.id)
    const shown = resetTime(
      new Date(resetsAt * 1000).toISOString(),
      undefined,
      defaultMachineSettings,
    )

    const health = await waitUntil(async () => {
      const h = await healthOf(client, 'claude')
      return h?.state === 'usage-limit' ? h : undefined
    }, 'Claude to be at its usage limit')
    expect(health.reason).toBe(`Claude usage limit, resets ${shown}`)
    expect(health.limitResetsAt).toBe(new Date(resetsAt * 1000).toISOString())

    const paused = await waitUntil(async () => {
      const t = await getTask(client, task.id)
      return t?.status?.kind === 'paused' ? t : undefined
    }, 'the Task to pause')
    expect(paused.status).toEqual({ kind: 'paused', reason: `Claude usage limit, resets ${shown}` })
    const banner = await waitUntil(
      () => bannerWith(client, 'agent-usage-limit:app:claude'),
      'the usage-limit banner',
    )
    expect(banner).toMatchObject({
      severity: 'stops-work',
      text: `Claude usage limit · resets ${shown} · 1 Run paused`,
      action: { label: 'Open', opens: { kind: 'settings', section: 'agents' } },
    })
    expect((await healthOf(client, 'codex'))?.state).toBe('ready')

    await continued(client, runId)
    expect((await healthOf(client, 'claude'))?.state).toBe('ready')
    await waitUntil(
      async () => ((await bannerWith(client, banner.id)) ? undefined : true),
      'the banner to clear',
    )
  })

  test('with no reset time TED tries one Run every 15 minutes and carries on once it works', async () => {
    const client = await start()
    const task = await startTask(
      client,
      steps({ everyMessage: [{ say: 'back at it' }, { endTurn: true }] }, limitReached, {
        endTurn: true,
      }),
    )
    const runId = await leadRunOf(client, task.id)
    const health = await waitUntil(async () => {
      const h = await healthOf(client, 'claude')
      return h?.state === 'usage-limit' ? h : undefined
    }, 'Claude to be at its usage limit')
    expect(health.reason).toBe('Claude usage limit')
    expect(health.limitResetsAt).toBeUndefined()

    await continued(client, runId)
    await waitUntil(
      async () => (await healthOf(client, 'claude'))?.state === 'ready' || undefined,
      'Claude to be ready again',
    )
  })

  test('a later limit message with no reset time keeps the reset time already known', async () => {
    const client = await start()
    const go = path.join(scratch, 'go')
    const resetsAt = Math.floor(Date.now() / 1000) + 3600
    await startTask(
      client,
      steps(limitEvent('rejected', { resetsAt }), { waitFor: go }, limitReached, { endTurn: true }),
    )
    await waitUntil(
      async () => (await healthOf(client, 'claude'))?.limitResetsAt,
      'the known reset time',
    )
    await writeFile(go, '')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect((await healthOf(client, 'claude'))?.limitResetsAt).toBe(
      new Date(resetsAt * 1000).toISOString(),
    )
  })

  test('no Run is tried while another pause, like being offline, also applies', async () => {
    const client = await start()
    const task = await startTask(
      client,
      steps({ everyMessage: [{ say: 'back at it' }, { endTurn: true }] }, limitReached, {
        endTurn: true,
      }),
    )
    const runId = await leadRunOf(client, task.id)
    await waitUntil(
      async () => (await healthOf(client, 'claude'))?.state === 'usage-limit' || undefined,
      'Claude to be at its usage limit',
    )
    online = false
    await waitUntil(
      async () => (await healthOf(client, 'claude'))?.state === 'offline' || undefined,
      'Claude to be offline',
    )
    await new Promise((resolve) => setTimeout(resolve, 2500))
    expect(
      (await linesOf(client, runId)).some((line) => line.includes('Carry on where you left off')),
    ).toBe(false)
    online = true
    await continued(client, runId)
  })

  test('the Codex usage limit pauses only Codex Tasks; Claude Tasks move ahead', async () => {
    const client = await start()
    const resetsAt = Math.floor(Date.now() / 1000) + 3600
    const codex = await startTask(
      client,
      steps({
        notify: 'error',
        params: {
          willRetry: false,
          error: { message: 'limit', codexErrorInfo: { usageLimitExceeded: { resetsAt } } },
        },
      }),
      'codex',
    )
    await waitUntil(async () => {
      const h = await healthOf(client, 'codex')
      return h?.state === 'usage-limit' ? h : undefined
    }, 'Codex to be at its usage limit')
    const queued = await startTask(client, steps({ say: 'later' }), 'codex')
    const claude = await startTask(client, steps({ say: 'hello' }, { endTurn: true }))

    await waitUntil(async () => (await getTask(client, claude.id))?.leadRunId, 'the Claude Run')
    const waiting = await waitUntil(async () => {
      const t = await getTask(client, queued.id)
      return t?.status?.kind === 'paused' ? t : undefined
    }, 'the queued Codex Task to show Paused')
    expect(waiting.leadRunId).toBeUndefined()
    expect(waiting.status).toMatchObject({ reason: expect.stringMatching(/^Codex usage limit/) })
    expect((await getTask(client, codex.id))?.status?.kind).toBe('paused')
  })
})

describe('Offline', () => {
  test('going offline pauses every agent kind and stops the no-output clock; coming back carries on', async () => {
    let transient = false
    let recoveredChecks = 0
    const client = await start({
      stallAfterMs: 1500,
      isOnline: async () => {
        if (transient) {
          transient = false
          recoveredChecks = 0
          return false
        }
        recoveredChecks++
        return online
      },
    })
    const go = path.join(scratch, 'go')
    const task = await startTask(client, steps({ say: 'hi' }, { waitFor: go }, { endTurn: true }))
    const runId = await leadRunOf(client, task.id)
    await waitUntil(
      async () => (await getTask(client, task.id))?.status?.kind === 'working' || undefined,
      'the Run to work',
    )

    transient = true
    await waitUntil(() => !transient && recoveredChecks >= 2, 'the transient failure to recover')
    expect(await bannerWith(client, 'offline:app')).toBeUndefined()
    expect((await healthOf(client, 'claude'))?.state).toBe('ready')
    expect((await getTask(client, task.id))?.status?.kind).toBe('working')

    online = false
    const banner = await waitUntil(() => bannerWith(client, 'offline:app'), 'the offline banner')
    expect(banner).toMatchObject({
      severity: 'stops-work',
      text: 'You’re offline · 1 Run paused until the connection returns',
    })
    expect(banner.action).toBeUndefined()
    const all = await client.ok<AgentHealth[]>('GET', '/agents/health')
    expect(all.map((h) => [h.agent, h.state, h.reason])).toEqual([
      ['claude', 'offline', 'offline'],
      ['codex', 'offline', 'offline'],
    ])
    expect((await getTask(client, task.id))?.status).toEqual({ kind: 'paused', reason: 'offline' })

    await new Promise((resolve) => setTimeout(resolve, 3000))
    const quiet = await client.ok<RunWithConversation>('GET', `/runs/${runId}`)
    expect(quiet.run.state).not.toBe('finished')
    expect((await getTask(client, task.id))?.leadRunId).toBe(runId)

    online = true
    await waitUntil(
      async () => ((await bannerWith(client, 'offline:app')) ? undefined : true),
      'the offline banner to clear',
    )
    expect((await healthOf(client, 'claude'))?.state).toBe('ready')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(
      (await linesOf(client, runId)).some((line) => line.includes('Carry on where you left off')),
    ).toBe(false)
    await writeFile(go, '')
    await waitUntil(
      async () => (await getTask(client, task.id))?.status?.kind !== 'paused' || undefined,
      'the Task to carry on',
    )
    expect((await getTask(client, task.id))?.leadRunId).toBe(runId)
    await waitUntil(
      async () =>
        (await client.ok<RunWithConversation>('GET', `/runs/${runId}`)).run.state === 'idle' ||
        undefined,
      'the turn to end',
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(
      (await linesOf(client, runId)).some((line) => line.includes('Carry on where you left off')),
    ).toBe(false)
  })
})

describe('Billing and credentials', () => {
  test('under Subscription the key variables are removed; under API key they reach the agent', async () => {
    const saved = { ...process.env }
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    process.env.ANTHROPIC_AUTH_TOKEN = 'auth-test'
    process.env.CODEX_API_KEY = 'codex-test'
    try {
      const client = await start()
      const record = async (task: Task) => {
        const runId = await leadRunOf(client, task.id)
        const { cwd } = (await client.getRun(runId)).run
        return waitUntil(async () => {
          const text = await readFile(path.join(cwd, 'stub-record.json'), 'utf8').catch(
            () => undefined,
          )
          return text ? (JSON.parse(text) as { env: Record<string, string> }).env : undefined
        }, 'the stub to record its environment')
      }
      const claudeEnv = await record(
        await startTask(client, steps({ say: 'one' }, { endTurn: true })),
      )
      expect(claudeEnv.ANTHROPIC_API_KEY).toBeUndefined()
      expect(claudeEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined()

      const settings = await client.ok<{ billing: Record<string, string> }>('PATCH', '/settings', {
        billing: { claude: 'api-key', codex: 'subscription' },
      })
      expect(settings.billing).toEqual({ claude: 'api-key', codex: 'subscription' })
      const keyed = await record(await startTask(client, steps({ say: 'two' }, { endTurn: true })))
      expect(keyed.ANTHROPIC_API_KEY).toBe('sk-ant-test')
      const codexEnv = await record(
        await startTask(client, steps({ say: 'three' }, { endTurn: true }), 'codex'),
      )
      expect(codexEnv.CODEX_API_KEY).toBeUndefined()
    } finally {
      process.env = saved
    }
  })

  test('billing must name each agent and a known choice', async () => {
    const client = await start()
    for (const billing of [
      'api-key',
      { claude: 'api-key' },
      { claude: 'free', codex: 'subscription' },
      { claude: 'api-key', codex: 'api-key', gemini: 'api-key' },
    ]) {
      expect((await client.call('PATCH', '/settings', { billing })).status).toBe(400)
    }
  })

  test('a Run that reports an API key under Subscription pauses its kind until billing changes', async () => {
    await setStub('claude', { apiKeySource: 'apiKeyHelper', interruptEndsAfterMs: 1500 })
    const client = await start()
    const go = path.join(scratch, 'go')
    const task = await startTask(
      client,
      steps({ everyMessage: [{ say: 'carrying on' }, { endTurn: true }] }, { waitFor: go }),
    )
    const runId = await leadRunOf(client, task.id)

    const health = await waitUntil(async () => {
      const h = await healthOf(client, 'claude')
      return h?.state === 'wrong-credential' ? h : undefined
    }, 'Claude to report the wrong credential')
    expect(health.reason).toBe('Using an API key, not your subscription')
    expect(health.keySource).toMatch(/apiKeyHelper/)
    const banner = await waitUntil(
      () => bannerWith(client, 'agent-unavailable:app:claude'),
      'the credential banner',
    )
    expect(banner).toMatchObject({
      text: 'Using an API key, not your subscription · 1 Run paused',
      action: { label: 'Fix', opens: { kind: 'settings', section: 'agents' } },
    })
    const chat = await client.ok<RunChat>('GET', `/runs/${runId}/chat`)
    expect(chat.run.credential).toBe('API key')

    await client.ok('PATCH', '/settings', { billing: { claude: 'api-key', codex: 'subscription' } })
    await waitUntil(
      async () => (await healthOf(client, 'claude'))?.state === 'ready' || undefined,
      'Claude to be ready once billing is API key',
    )
    await continued(client, runId)
  })
})

describe('Tokens, dollars, plan usage and retries', () => {
  const result = {
    emit: {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.42,
      usage: { input_tokens: 1000, output_tokens: 500 },
    },
  }

  test('every Run shows its tokens; dollars only when the Run used an API key', async () => {
    const client = await start()
    const sub = await startTask(client, steps(result, { endTurn: true }))
    const subRun = await leadRunOf(client, sub.id)
    const subChat = await waitUntil(async () => {
      const chat = await client.ok<RunChat>('GET', `/runs/${subRun}/chat`)
      return chat.run.tokens !== undefined ? chat : undefined
    }, 'tokens on the subscription Run')
    expect(subChat.run).toMatchObject({ credential: 'Subscription', tokens: 1500 })
    expect(subChat.run.cost).toBeUndefined()

    await client.ok('PATCH', '/settings', { billing: { claude: 'api-key', codex: 'subscription' } })
    await setStub('claude', { apiKeySource: 'ANTHROPIC_API_KEY' })
    const keyed = await startTask(client, steps(result, { endTurn: true }))
    const keyedRun = await leadRunOf(client, keyed.id)
    const keyedChat = await waitUntil(async () => {
      const chat = await client.ok<RunChat>('GET', `/runs/${keyedRun}/chat`)
      return chat.run.cost !== undefined ? chat : undefined
    }, 'dollars on the API-key Run')
    expect(keyedChat.run).toMatchObject({ credential: 'API key', tokens: 1500, cost: 0.42 })
    expect((await healthOf(client, 'claude'))?.state).toBe('ready')
  })

  test('plan usage comes from the last Run’s rate limit events, and the same usage again sends no event', async () => {
    const client = await start()
    const sent: string[] = []
    const events = await new DaemonClient(
      { port: daemon?.port ?? 0, token: '', pid: 0, version: 'test' },
      '',
      { appKey: daemon?.appToken ?? '' },
    ).subscribe((event) => {
      if (event.type !== 'agent-health-changed' || event.health.agent !== 'claude') return
      const usage = event.health.planUsage
      sent.push(JSON.stringify({ ...event.health, planUsage: usage && { ...usage, at: '' } }))
    })
    const resetsAt = Math.floor(Date.now() / 1000) + 3600
    const fiveHour = limitEvent('allowed_warning', {
      resetsAt,
      rateLimitType: 'five_hour',
      utilization: 0.87,
    })
    const task = await startTask(
      client,
      steps(
        fiveHour,
        limitEvent('allowed', { rateLimitType: 'seven_day', utilization: 0.41 }),
        { lines: 1, everyMs: 300 },
        fiveHour,
        { lines: 1, everyMs: 300 },
        fiveHour,
        { endTurn: true },
      ),
    )
    const runId = await leadRunOf(client, task.id)
    await waitUntil(
      async () =>
        (await client.ok<RunWithConversation>('GET', `/runs/${runId}`)).run.state === 'idle' ||
        undefined,
      'the turn to end',
    )
    events.close()
    expect(sent.length, 'events with plan usage').toBeGreaterThan(0)
    expect(
      sent.filter((health, i) => health === sent[i - 1]),
      'events that repeat the one before',
    ).toEqual([])
    const health = await waitUntil(async () => {
      const h = await healthOf(client, 'claude')
      return (h?.planUsage?.windows.length ?? 0) >= 2 ? h : undefined
    }, 'Claude’s plan usage')
    expect(health.state).toBe('ready')
    expect(health.planUsage).toMatchObject({
      from: 'run',
      windows: [
        { window: 'five-hour', percent: 87, resetsAt: new Date(resetsAt * 1000).toISOString() },
        { window: 'weekly', percent: 41 },
      ],
    })
  })

  test('Check again refreshes Codex usage to zero without a new Run', async () => {
    const rateLimits = (percent: number) => ({
      primary: { usedPercent: percent, windowDurationMins: 300 },
      secondary: { usedPercent: 78, windowDurationMins: 10080 },
    })
    await setStub('codex', { rateLimits: rateLimits(94) })
    const client = await start()
    await startTask(client, steps({ endTurn: true }), 'codex')
    await waitUntil(async () => (await healthOf(client, 'codex'))?.planUsage, 'initial usage')
    await setStub('codex', { rateLimits: rateLimits(0) })
    await client.ok('POST', '/agents/health/check')
    expect((await healthOf(client, 'codex'))?.planUsage?.windows).toEqual([
      { window: 'five-hour', percent: 0 },
      { window: 'weekly', percent: 78 },
    ])
  })

  test('Codex usage refreshes periodically without any Run and replaces absent windows', async () => {
    await setStub('codex', {
      rateLimits: {
        primary: { usedPercent: 94, windowDurationMins: 300 },
        secondary: { usedPercent: 78, windowDurationMins: 10080 },
      },
    })
    const client = await start({ healthIntervalMs: 500 })
    await waitUntil(
      async () => (await healthOf(client, 'codex'))?.planUsage?.windows.length === 2,
      'initial usage without a Run',
    )
    await setStub('codex', { rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300 } } })
    await waitUntil(async () => {
      const windows = (await healthOf(client, 'codex'))?.planUsage?.windows
      return windows?.length === 1 && windows[0]?.percent === 0
    }, 'automatic zero usage')
    expect((await client.ok<{ runs: { active: number } }>('GET', '/activity')).runs.active).toBe(0)
    expect(await client.ok('GET', '/tasks')).toEqual([])
  })

  test('Codex usage refreshes after its reset without manufacturing a zero', async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 1
    await setStub('codex', {
      rateLimits: { primary: { usedPercent: 94, windowDurationMins: 300, resetsAt } },
    })
    const client = await start()
    await waitUntil(async () => (await healthOf(client, 'codex'))?.planUsage, 'initial usage')
    await setStub('codex', { rateLimits: { primary: { usedPercent: 3, windowDurationMins: 300 } } })
    await waitUntil(
      async () => (await healthOf(client, 'codex'))?.planUsage?.windows[0]?.percent === 3,
      'usage read after reset',
      12_000,
    )
  })

  test('a reset overlapping a pre-reset read queues a fresh zero reading', async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 1
    const rateLimits = { primary: { usedPercent: 94, windowDurationMins: 300, resetsAt } }
    await setStub('codex', { rateLimits })
    const client = await start()
    await waitUntil(async () => (await healthOf(client, 'codex'))?.planUsage, 'initial usage')
    await setStub('codex', { rateLimits, rateLimitsDelayMs: 6500 })
    const checking = client.ok('POST', '/agents/health/check')
    await waitUntil(
      async () =>
        (await readFile(path.join(home, 'stub-usage-reads.jsonl'), 'utf8')).trim().split('\n')
          .length >= 2,
      'pre-reset read',
    )
    await setStub('codex', { rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300 } } })
    await checking
    await waitUntil(
      async () => (await healthOf(client, 'codex'))?.planUsage?.windows[0]?.percent === 0,
      'fresh read after the overlapping reset',
      2000,
    )
  })

  test('failed Codex usage reads retain their timestamp and do not pause work', async () => {
    await setStub('codex', { rateLimits: { primary: { usedPercent: 94 } } })
    const client = await start()
    const initial = await waitUntil(
      async () => (await healthOf(client, 'codex'))?.planUsage,
      'initial usage',
    )
    await setStub('codex', { rateLimitsError: true })
    await client.ok('POST', '/agents/health/check')
    expect(await healthOf(client, 'codex')).toMatchObject({ state: 'ready', planUsage: initial })
    await setStub('codex', {})
    await client.ok('POST', '/agents/health/check')
    expect((await healthOf(client, 'codex'))?.planUsage?.windows).toEqual([])
  })

  test('a newer Run update wins over an in-flight Codex usage read', async () => {
    const client = await start()
    const go = path.join(scratch, 'usage-go')
    const task = await startTask(
      client,
      steps(
        { waitFor: go },
        {
          notify: 'account/rateLimits/updated',
          params: { rateLimits: { primary: { usedPercent: 0 } } },
        },
        { endTurn: true },
      ),
      'codex',
    )
    const runId = await leadRunOf(client, task.id)
    await waitUntil(async () => (await client.getRun(runId)).run.state === 'working', 'working Run')
    const reads = async () =>
      (await readFile(path.join(home, 'stub-usage-reads.jsonl'), 'utf8')).trim().split('\n').length
    await waitUntil(async () => (await reads()) >= 2, 'startup reads')
    const before = await reads()
    await setStub('codex', {
      rateLimitsDelayMs: 1500,
      rateLimits: { primary: { usedPercent: 94 } },
    })
    const check = client.ok('POST', '/agents/health/check')
    await waitUntil(async () => (await reads()) > before, 'the delayed read')
    await writeFile(go, '')
    await waitUntil(
      async () => (await healthOf(client, 'codex'))?.planUsage?.windows[0]?.percent === 0,
      'the newer Run update',
    )
    await check
    expect((await healthOf(client, 'codex'))?.planUsage?.windows[0]?.percent).toBe(0)
  })

  test('concurrent health checks share a usage probe with the scrubbed daemon environment', async () => {
    const saved = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'usage-probe-test-key'
    try {
      const client = await start()
      await waitUntil(async () => (await healthOf(client, 'codex'))?.planUsage, 'initial usage')
      await setStub('codex', { rateLimitsDelayMs: 500 })
      const records = async () =>
        (await readFile(path.join(home, 'stub-usage-reads.jsonl'), 'utf8')).trim().split('\n')
      const before = (await records()).length
      await Promise.all([
        client.ok('POST', '/agents/health/check'),
        client.ok('POST', '/agents/health/check'),
      ])
      const after = await records()
      expect(after.length).toBe(before + 1)
      const probe = JSON.parse(after.at(-1) ?? '{}')
      expect(probe.cwd).toBe(await realpath(home))
      expect(probe.env.OPENAI_API_KEY).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = saved
    }
  })

  test('usage probes skip offline, signed-out, old and API-key agents', async () => {
    const client = await start()
    await waitUntil(async () => (await healthOf(client, 'codex'))?.planUsage, 'initial usage')
    const records = () => readFile(path.join(home, 'stub-usage-reads.jsonl'), 'utf8')
    const before = await records()
    online = false
    await waitUntil(async () => (await healthOf(client, 'codex'))?.state === 'offline', 'offline')
    await client.ok('POST', '/agents/health/check')
    expect(await records()).toBe(before)
    await setStub('codex', { signedIn: false })
    online = true
    await client.ok('POST', '/agents/health/check')
    expect(await records()).toBe(before)
    await setStub('codex', { version: '0.1.0' })
    await client.ok('POST', '/agents/health/check')
    expect(await records()).toBe(before)
    await client.ok('PATCH', '/settings', { billing: { claude: 'subscription', codex: 'api-key' } })
    await setStub('codex', {})
    await client.ok('POST', '/agents/health/check')
    expect(await records()).toBe(before)
  })

  test('closing health cancels a running periodic usage probe', async () => {
    const client = await start({ healthIntervalMs: 500 })
    await waitUntil(async () => (await healthOf(client, 'codex'))?.planUsage, 'initial usage')
    await setStub('codex', { rateLimitsHang: true })
    const probe = await waitUntil(async () => {
      const lines = (await readFile(path.join(home, 'stub-usage-reads.jsonl'), 'utf8'))
        .trim()
        .split('\n')
      return lines.length >= 2 ? (JSON.parse(lines.at(-1) ?? '{}') as { pid: number }) : undefined
    }, 'hanging periodic probe')
    await daemon?.stop()
    daemon = undefined
    await waitUntil(() => {
      try {
        process.kill(probe.pid, 0)
        return undefined
      } catch {
        return true
      }
    }, 'the cancelled probe to be reaped')
  })

  test('Codex plan usage is read from the app-server when a Run starts', async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 600
    await setStub('codex', {
      rateLimits: {
        primary: { usedPercent: 22, windowDurationMins: 300, resetsAt },
        secondary: { usedPercent: 35, windowDurationMins: 10080, resetsAt: resetsAt + 86400 },
      },
    })
    const client = await start()
    await startTask(client, steps({ say: 'hi' }, { endTurn: true }), 'codex')
    const health = await waitUntil(async () => {
      const h = await healthOf(client, 'codex')
      return h?.planUsage ? h : undefined
    }, 'Codex’s plan usage')
    expect(health.planUsage).toMatchObject({
      from: 'read',
      windows: [
        { window: 'five-hour', percent: 22 },
        { window: 'weekly', percent: 35 },
      ],
    })
  })

  test('a Run the CLI is retrying shows “Retrying (rate limited)” until it carries on', async () => {
    const client = await start()
    const go = path.join(scratch, 'go')
    const task = await startTask(
      client,
      steps(
        { emit: { type: 'system', subtype: 'api_retry', attempt: 1, error_status: 429 } },
        { waitFor: go },
        { say: 'through' },
        { waitFor: path.join(scratch, 'never') },
      ),
    )
    await waitUntil(
      async () =>
        (await getTask(client, task.id))?.activity === 'Retrying (rate limited)' || undefined,
      'the retry activity line',
    )
    await writeFile(go, '')
    await waitUntil(
      async () =>
        (await getTask(client, task.id))?.activity !== 'Retrying (rate limited)' || undefined,
      'the retry line to go',
    )
  })
})
