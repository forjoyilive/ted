import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { type Diagnostics, type LogText, tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createAgents } from '../src/agents/index.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import {
  api,
  killRunHosts,
  makeTempHome,
  rawRequest,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

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
  return api(daemon.port, daemon.appToken)
}

describe('Diagnostics', () => {
  test('lists each Run with its processes, CPU, memory and token use', async () => {
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

  test('Copy report gathers the version, Runs and daemon log, with the home folder hidden', async () => {
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
      '/diagnostics/report',
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
})
