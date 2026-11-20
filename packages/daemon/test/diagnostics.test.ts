import { appendFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type Diagnostics,
  type DiagnosticsUsage,
  type LogText,
  type MemoryUse,
  type ProcessUsage,
  type Run,
  type TokenUse,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, expectTypeOf, test } from 'vitest'
import { createAgents } from '../src/agents/index.ts'
import { classifyProcesses, countAgentRuns, sharedUsage } from '../src/diagnostics.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { runFiles } from '../src/runs/host-files.ts'
import { parsedOutput } from '../src/runs/parsed-output.ts'
import { createRunOutput } from '../src/runs/run-output.ts'
import type { StoreContext } from '../src/store/context.ts'
import type { TedStore } from '../src/store/index.ts'
import {
  api,
  killRunHosts,
  makeTempHome,
  rawRequest,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'
import { sandboxReasons, skipInsideTedSandbox } from './support/ted-sandbox.ts'

expectTypeOf<StoreContext>().toHaveProperty('store')

let home: string
let cleanup: () => Promise<void>
let cwd: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  cwd = await mkdtemp(path.join(tmpdir(), 'ted-diag-cwd-'))
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(cwd, { recursive: true, force: true })
})

async function start() {
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  return api(daemon.port, { appKey: daemon.appToken })
}

test('each process is classified by the nearest Run host, Check or App above it', () => {
  const row = (pid: number, ppid: number, command = 'node') => ({
    pid,
    ppid,
    cpuPercent: 0,
    memoryBytes: 1,
    command,
  })
  const lead = { runId: 'run-1', agent: 'claude', role: 'task-lead', task: 'TED-1' } as const
  const classified = classifyProcesses(
    [
      row(1, 0, 'launchd'),
      row(10, 1, 'Ted'),
      row(11, 10, 'Ted'),
      row(12, 11, 'claude'),
      row(13, 12),
      row(14, 13, 'java'),
      row(20, 10, 'sandbox-exec'),
      row(21, 20, 'vitest'),
      row(30, 1, 'Ted'),
      row(31, 30, 'electron'),
      row(40, 10, 'git'),
      row(41, 10, 'ps'),
      row(50, 1, 'Safari'),
    ],
    10,
    new Map([[11, lead]]),
    (pid) =>
      pid === 20
        ? { kind: 'check', task: 'TED-2' }
        : pid === 30
          ? { kind: 'app', task: 'TED-3', appName: 'Web' }
          : undefined,
  )
  expect(classified.map((p) => [p.pid, p.kind, p.task ?? p.run?.task, p.appName])).toEqual([
    [10, 'daemon', undefined, undefined],
    [11, 'run-host', 'TED-1', undefined],
    [12, 'agent', 'TED-1', undefined],
    [13, 'agent-tool', 'TED-1', undefined],
    [14, 'agent-tool', 'TED-1', undefined],
    [20, 'check', 'TED-2', undefined],
    [21, 'check', 'TED-2', undefined],
    [30, 'app', 'TED-3', 'Web'],
    [31, 'app', 'TED-3', 'Web'],
    [40, 'other', undefined, undefined],
  ])
})

test('agent processes are counted by their Run’s role and whether it is working', () => {
  const agent = (pid: number, runId: string, role: 'task-lead' | 'sub-agent') => ({
    pid,
    ppid: 1,
    cpuPercent: 0,
    memoryBytes: 1,
    command: 'claude',
    owner: { runId },
    kind: 'agent' as const,
    run: { runId, agent: 'claude' as const, role },
  })
  expect(
    countAgentRuns(
      [
        agent(1, 'a', 'task-lead'),
        agent(2, 'b', 'task-lead'),
        agent(3, 'c', 'task-lead'),
        agent(4, 'd', 'sub-agent'),
        { ...agent(5, 'a', 'task-lead'), kind: 'agent-tool' },
        { ...agent(6, 'a', 'task-lead'), kind: 'run-host' },
      ],
      [
        { id: 'a', state: 'working' },
        { id: 'b', state: 'idle' },
        { id: 'c', state: 'working' },
        { id: 'd', state: 'waiting' },
      ],
    ),
  ).toEqual([
    { role: 'task-lead', working: true, count: 2 },
    { role: 'task-lead', working: false, count: 1 },
    { role: 'sub-agent', working: false, count: 1 },
  ])
})

describe('Diagnostics', () => {
  test('lists each Run with its processes, CPU, memory and token use', async (context) => {
    skipInsideTedSandbox(context, sandboxReasons.processes)
    const client = await start()
    const run = await client.startRun(
      [
        { endTurn: true, usage: { input_tokens: 1200, output_tokens: 300 } },
        { endTurn: true, usage: { input_tokens: 800, output_tokens: 50 } },
        { waitFor: path.join(cwd, 'never') },
      ],
      cwd,
    )

    const diagnostics = await waitUntil(async () => {
      const { body } = await client.call('GET', '/diagnostics')
      const found = (body as Diagnostics).runs.find((r) => r.runId === run.id)
      return found?.tokens.output === 350 && found.memoryBytes > 0
        ? (body as Diagnostics)
        : undefined
    }, 'the Run’s token use and processes')

    const shown = diagnostics.runs.find((r) => r.runId === run.id)
    expect(shown).toMatchObject({
      agent: 'claude',
      tokens: { input: 2000, output: 350 },
    })
    const owned = diagnostics.processes.filter(
      (p) => typeof p.owner === 'object' && p.owner.runId === run.id,
    )
    expect(owned.length).toBeGreaterThanOrEqual(2)
    expect(owned.map((p) => p.kind)).toEqual(expect.arrayContaining(['run-host', 'agent']))
    expect(owned.find((p) => p.kind === 'agent')?.run).toMatchObject({
      runId: run.id,
      agent: 'claude',
      role: 'run',
    })
    expect(
      diagnostics.processes.some(
        (p) => p.owner === 'daemon' && p.kind === 'daemon' && p.pid === process.pid,
      ),
    ).toBe(true)
    expect(diagnostics.memory.totalBytes).toBeGreaterThan(0)
    expect(diagnostics.memory.availableBytes).toBeGreaterThan(0)
    expect(diagnostics.memory.availableBytes).toBeLessThanOrEqual(diagnostics.memory.totalBytes)

    const usage = (await client.call('GET', '/diagnostics/usage')).body as DiagnosticsUsage
    expect(Object.keys(usage).sort()).toEqual(['cpuPercent', 'machine', 'memory', 'memoryBytes'])
    expect(usage.memory.agents.count).toBe(1)
    expect(usage.cpuPercent).toBeGreaterThanOrEqual(0)
    expect(usage.memoryBytes).toBeGreaterThan(owned.reduce((sum, p) => sum + p.memoryBytes, 0) / 2)

    const memory = (await client.call('GET', '/diagnostics/memory')).body as MemoryUse
    expect(memory.hosts.count).toBe(1)
    expect(memory.agents.count).toBe(1)
    expect(memory.agentRuns).toMatchObject([{ role: 'run', count: 1 }])
    for (const bytes of [
      memory.daemon.bytes,
      memory.daemon.heapBytes,
      memory.hosts.bytes,
      memory.agents.bytes,
      memory.store.eventLogBytes,
      memory.store.stateBytes,
    ]) {
      expect(bytes).toBeGreaterThan(0)
    }

    const ended = await client.startRun(
      [{ endTurn: true, usage: { input_tokens: 7, output_tokens: 3 } }, { exit: 0 }],
      cwd,
    )
    const tokensOf = async (runId: string) => {
      const { body } = await client.call('GET', '/diagnostics')
      return (body as Diagnostics).runs.find((r) => r.runId === runId)
    }
    await waitUntil(
      async () => (await tokensOf(ended.id))?.state === 'finished',
      'the second Run to finish',
    )
    for (let read = 0; read < 2; read++) {
      expect((await tokensOf(ended.id))?.tokens).toEqual({ input: 7, output: 3 })
      expect((await tokensOf(run.id))?.tokens).toEqual({ input: 2000, output: 350 })
    }
  })

  test('shows a Run’s raw output and the end of the daemon’s log', async () => {
    const client = await start()
    const run = await client.startRun([{ say: 'raw hello' }, { endTurn: true }], cwd)
    await mkdir(tedPaths(home).logs, { recursive: true })
    await appendFile(tedPaths(home).daemonLog, 'Ted daemon 9.9.9 listening\n')

    const raw = await waitUntil(async () => {
      const { body } = await client.call('GET', `/runs/${run.id}/raw`)
      return (body as LogText).text.includes('raw hello') ? (body as LogText) : undefined
    }, 'the raw output')
    expect(raw.text.split('\n')[0]).toMatch(/^\{"t":"start"/)

    const log = await client.call('GET', '/logs/daemon')
    expect(log.body).toEqual({ text: 'Ted daemon 9.9.9 listening\n', truncated: false })
  })

  test('shows only the end of a long log', async () => {
    const client = await start()
    await mkdir(tedPaths(home).logs, { recursive: true })
    await appendFile(tedPaths(home).daemonLog, `${'x'.repeat(300_000)}\nlast line\n`)

    const { body } = await client.call('GET', '/logs/daemon')

    expect((body as LogText).truncated).toBe(true)
    expect((body as LogText).text.endsWith('last line\n')).toBe(true)
    expect((body as LogText).text.length).toBeLessThanOrEqual(256 * 1024)
  })

  test('an empty daemon log reads as empty', async () => {
    const client = await start()

    expect((await client.call('GET', '/logs/daemon')).body).toEqual({ text: '', truncated: false })
  })

  test('raw output is only for Runs Ted knows', async () => {
    const client = await start()

    expect((await client.call('GET', '/runs/nope/raw')).status).toBe(404)
    expect((await client.call('GET', '/runs/..%2F..%2Fdaemon.json/raw')).status).toBe(404)
  })

  test('Copy report gathers the version, Runs and daemon log, with the home folder hidden', async (context) => {
    skipInsideTedSandbox(context, sandboxReasons.processes)
    const client = await start()
    const run = await client.startRun([{ endTurn: true }], cwd)
    await mkdir(tedPaths(home).logs, { recursive: true })
    await appendFile(
      tedPaths(home).daemonLog,
      `opened ${tedPaths(home).store}\nfatal: https://me:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/k/n.git\nlinear lin_api_abcdefghijklmnopqrstuvwxyz0123456789\n`,
    )

    const { status, body } = await client.call('GET', '/diagnostics/report')

    expect(status).toBe(200)
    const { text } = body as { text: string }
    expect(text).toContain('Ted 9.9.9')
    expect(text).toContain(run.id)
    expect(text).toContain('opened <Ted home>/store')
    expect(text).not.toContain(home)
    expect(text).not.toContain('"steps"')
    expect(text).toContain('fatal: https://[redacted]@github.com/k/n.git')
    expect(text).not.toContain('ghp_')
    expect(text).not.toContain('lin_api_')

    const withoutLog = await client.call('GET', '/diagnostics/report?log=0')
    const { text: short } = withoutLog.body as { text: string }
    expect(short).toContain(run.id)
    expect(short).toContain('Daemon log and process command lines left out')
    expect(short).not.toContain('opened <Ted home>/store')
    expect(short).not.toMatch(/^\d+ \(parent \d+\) (?!·)/m)
  })

  test('the usage reading shows the whole machine’s CPU and memory, as the busy hold sees them', async () => {
    daemon = await startDaemon({
      home,
      version: '9.9.9',
      claudeBin: stubClaudePath,
      load: { ratio: () => 0.7912, memoryAvailable: () => 0.4 },
    })
    const client = api(daemon.port, { appKey: daemon.appToken })
    const usage = (await client.call('GET', '/diagnostics/usage')).body as DiagnosticsUsage
    expect(usage.machine).toEqual({ cpuInUse: 0.79, memoryInUse: 0.6 })
  })

  test('the usage reading leaves out a figure the machine can’t report', async () => {
    daemon = await startDaemon({
      home,
      version: '9.9.9',
      claudeBin: stubClaudePath,
      load: { ratio: () => Number.NaN, memoryAvailable: () => 0.25 },
    })
    const client = api(daemon.port, { appKey: daemon.appToken })
    const usage = (await client.call('GET', '/diagnostics/usage')).body as DiagnosticsUsage
    expect(usage.machine).toEqual({ cpuInUse: null, memoryInUse: 0.75 })
  })

  test('Runs can’t read Diagnostics, logs or the report', async () => {
    daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
    const runToken = (await loadRunTokens(tedPaths(home).runTokenKey)).issue('run-1')
    const asRun = (route: string) =>
      rawRequest(daemon?.port ?? 0, {
        path: route,
        headers: { authorization: `Bearer ${runToken}` },
      })

    for (const route of [
      '/diagnostics',
      '/diagnostics/usage',
      '/diagnostics/memory',
      '/diagnostics/report',
      '/diagnostics/report?log=0',
      '/logs/daemon',
      '/runs/run-1/raw',
    ]) {
      expect((await asRun(route)).status, route).toBe(403)
    }
  })
})

describe('token use from agent output', () => {
  const agents = createAgents({ claudeBin: '/nowhere/claude', codexBin: '/nowhere/codex' })

  test('Claude Code reports each turn’s tokens on its result line', () => {
    const claude = agents.get('claude')

    expect(
      claude.tokensFrom(
        JSON.stringify({ type: 'result', usage: { input_tokens: 10, output_tokens: 4 } }),
      ),
    ).toEqual({ input: 10, output: 4, total: false })
    expect(claude.tokensFrom(JSON.stringify({ type: 'assistant' }))).toBeUndefined()
    expect(claude.tokensFrom('not json')).toBeUndefined()
  })

  test('Codex reports the thread’s running total', () => {
    const codex = agents.get('codex')
    const line = JSON.stringify({
      method: 'thread/tokenUsage/updated',
      params: { tokenUsage: { total: { inputTokens: 900, outputTokens: 120, totalTokens: 1020 } } },
    })

    expect(codex.tokensFrom(line)).toEqual({ input: 900, output: 120, total: true })
    expect(codex.tokensFrom(JSON.stringify({ method: 'turn/started' }))).toBeUndefined()
  })

  test.each([
    {
      agent: 'claude' as const,
      lines: [
        JSON.stringify({ type: 'result', usage: { input_tokens: 10, output_tokens: 4 } }),
        JSON.stringify({ type: 'assistant' }),
        'not json',
        JSON.stringify({ type: 'result', usage: { input_tokens: 5, output_tokens: 1 } }),
      ],
      totals: [
        { input: 10, output: 4 },
        { input: 15, output: 5 },
      ],
    },
    {
      agent: 'codex' as const,
      lines: [
        JSON.stringify({
          method: 'thread/tokenUsage/updated',
          params: { tokenUsage: { total: { inputTokens: 900, outputTokens: 120 } } },
        }),
        JSON.stringify({ method: 'turn/started' }),
        JSON.stringify({
          method: 'thread/tokenUsage/updated',
          params: { tokenUsage: { total: { inputTokens: 1500, outputTokens: 200 } } },
        }),
      ],
      totals: [
        { input: 900, output: 120 },
        { input: 1500, output: 200 },
      ],
    },
  ])('the output fold keeps $agent input and output tokens as lines arrive', async (given) => {
    const home = await mkdtemp(path.join(tmpdir(), 'ted-diag-fold-'))
    try {
      const run = { id: 'run-1', agent: given.agent, cwd: home } as Run
      const log = runFiles(path.join(tedPaths(home).runs, run.id)).log
      await mkdir(path.dirname(log), { recursive: true })
      let offset = 0
      const output = createRunOutput({
        home,
        store: { getRun: () => run, runReadOffset: () => offset },
      })
      const write = async (lines: string[]) => {
        await appendFile(
          log,
          lines.map((line) => `${JSON.stringify({ t: 'out', line })}\n`).join(''),
        )
        offset = (await stat(log)).size
      }
      const reread = (): TokenUse => {
        const agent = agents.get(run.agent)
        let added: TokenUse = { input: 0, output: 0 }
        let latestTotal: TokenUse | undefined
        for (const { line } of output.entries(run.id)) {
          const count = agent.tokensFrom(line)
          if (!count) continue
          if (count.total) latestTotal = { input: count.input, output: count.output }
          else added = { input: added.input + count.input, output: added.output + count.output }
        }
        return latestTotal ?? added
      }
      const fold = () => parsedOutput(output, agents, run)

      expect(fold().tokenUse()).toEqual({ input: 0, output: 0 })
      expect(fold().tokens()).toBeUndefined()
      const half = Math.ceil(given.lines.length / 2)
      for (const [index, lines] of [
        given.lines.slice(0, half),
        given.lines.slice(half),
      ].entries()) {
        await write(lines)
        const total = given.totals[index] as TokenUse
        expect(fold().tokenUse()).toEqual(total)
        expect(fold().tokenUse()).toEqual(reread())
        expect(fold().tokens()).toBe(total.input + total.output)
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('the shared usage reading', () => {
  const usage = (cpuPercent: number) => ({ cpuPercent }) as ProcessUsage
  const sourcesFor = () => ({ home, store: {} as TedStore })

  function counted(results: Array<() => Promise<ProcessUsage>>) {
    let clock = 0
    let reads = 0
    const read = sharedUsage({
      now: () => clock,
      read: () => {
        const index = reads
        reads += 1
        return (results[index] ?? (() => Promise.resolve(usage(index))))()
      },
    })
    return {
      read,
      reads: () => reads,
      advance: (ms: number) => {
        clock += ms
      },
    }
  }

  test('reuses a reading for 10 seconds after it finishes', async () => {
    const shared = counted([])
    const sources = sourcesFor()
    expect(await shared.read(sources)).toEqual(usage(0))
    shared.advance(5_000)
    expect(await shared.read(sources)).toEqual(usage(0))
    expect(shared.reads()).toBe(1)
    shared.advance(5_000)
    expect(await shared.read(sources)).toEqual(usage(1))
    expect(shared.reads()).toBe(2)
  })

  test('callers who ask while a reading runs share it', async () => {
    let finish: (value: ProcessUsage) => void = () => {}
    const shared = counted([() => new Promise((resolve) => (finish = resolve))])
    const sources = sourcesFor()
    const first = shared.read(sources)
    const second = shared.read(sources)
    finish(usage(7))
    expect(await Promise.all([first, second])).toEqual([usage(7), usage(7)])
    expect(shared.reads()).toBe(1)
  })

  test('a failed reading is not kept, and each store has its own', async () => {
    const shared = counted([() => Promise.reject(new Error('footprint timed out'))])
    const sources = sourcesFor()
    await expect(shared.read(sources)).rejects.toThrow('footprint timed out')
    expect(await shared.read(sources)).toEqual(usage(1))
    expect(await shared.read(sourcesFor())).toEqual(usage(2))
    expect(shared.reads()).toBe(3)
  })
})
