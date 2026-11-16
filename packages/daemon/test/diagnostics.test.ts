import { appendFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type Diagnostics,
  type LogText,
  type MemoryUse,
  type ProcessUsage,
  type Run,
  type TokenUse,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAgents } from '../src/agents/index.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { runFiles } from '../src/runs/host-files.ts'
import { parsedOutput } from '../src/runs/parsed-output.ts'
import { createRunOutput } from '../src/runs/run-output.ts'
import {
  api,
  killRunHosts,
  makeTempHome,
  rawRequest,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'
import { sandboxReasons, skipInsideTedSandbox } from './support/ted-sandbox.ts'

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
    expect(diagnostics.processes.some((p) => p.owner === 'daemon' && p.pid === process.pid)).toBe(
      true,
    )
    expect(diagnostics.memory.totalBytes).toBeGreaterThan(0)
    expect(diagnostics.memory.availableBytes).toBeGreaterThan(0)
    expect(diagnostics.memory.availableBytes).toBeLessThanOrEqual(diagnostics.memory.totalBytes)

    const usage = (await client.call('GET', '/diagnostics/usage')).body as ProcessUsage
    expect(Object.keys(usage).sort()).toEqual(['cpuPercent', 'memoryBytes'])
    expect(usage.cpuPercent).toBeGreaterThanOrEqual(0)
    expect(usage.memoryBytes).toBeGreaterThan(owned.reduce((sum, p) => sum + p.memoryBytes, 0) / 2)

    const memory = (await client.call('GET', '/diagnostics/memory')).body as MemoryUse
    expect(memory.hosts.count).toBe(1)
    expect(memory.agents.count).toBe(1)
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
    await appendFile(tedPaths(home).daemonLog, 'TED daemon 9.9.9 listening\n')

    const raw = await waitUntil(async () => {
      const { body } = await client.call('GET', `/runs/${run.id}/raw`)
      return (body as LogText).text.includes('raw hello') ? (body as LogText) : undefined
    }, 'the raw output')
    expect(raw.text.split('\n')[0]).toMatch(/^\{"t":"start"/)

    const log = await client.call('GET', '/logs/daemon')
    expect(log.body).toEqual({ text: 'TED daemon 9.9.9 listening\n', truncated: false })
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

  test('raw output is only for Runs TED knows', async () => {
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
    expect(text).toContain('TED 9.9.9')
    expect(text).toContain(run.id)
    expect(text).toContain('opened <TED home>/store')
    expect(text).not.toContain(home)
    expect(text).not.toContain('"steps"')
    expect(text).toContain('fatal: https://[redacted]@github.com/k/n.git')
    expect(text).not.toContain('ghp_')
    expect(text).not.toContain('lin_api_')

    const withoutLog = await client.call('GET', '/diagnostics/report?log=0')
    const { text: short } = withoutLog.body as { text: string }
    expect(short).toContain(run.id)
    expect(short).toContain('Daemon log and process command lines left out')
    expect(short).not.toContain('opened <TED home>/store')
    expect(short).not.toMatch(/^\d+ \(parent \d+\) (?!·)/m)
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
