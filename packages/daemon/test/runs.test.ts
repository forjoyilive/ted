import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { readDaemonInfo } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  assistantTexts,
  hostRecords,
  killRunHosts,
  makeTempHome,
  spawnDaemonProcess,
  stubClaudePath,
  testAppToken,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let cwd: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  cwd = await mkdtemp(path.join(tmpdir(), 'ted-run-cwd-'))
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(cwd, { recursive: true, force: true })
})

async function startWithStub() {
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  return api(daemon.port, daemon.appToken)
}

interface StubRecord {
  argv: string[]
  env: Record<string, string | undefined>
}

const stubRecord = () =>
  waitUntil(
    () =>
      readFile(path.join(cwd, 'stub-record.json'), 'utf8')
        .then((s) => JSON.parse(s) as StubRecord)
        .catch(() => undefined),
    'the stub agent to start',
  )

describe('Runs', () => {
  test('a dev Run’s output lands in the store as its Conversation, with the session ID', async () => {
    const client = await startWithStub()

    const run = await client.startRun([{ say: 'hello' }, { say: 'world' }, { endTurn: true }], cwd)

    const done = await waitUntil(async () => {
      const r = await client.getRun(run.id)
      return r.run.state === 'idle' ? r : undefined
    }, 'the Run to go idle')
    expect(assistantTexts(done.conversation)).toEqual(['hello', 'world'])
    const types = done.conversation.map((e) => (JSON.parse(e.line) as { type: string }).type)
    expect(types[0]).toBe('user')
    expect(types.at(-1)).toBe('result')

    const { argv } = await stubRecord()
    expect(done.run.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(done.run.sessionId)
  })

  test('hook events move the Run between working, waiting, idle and finished', async () => {
    const client = await startWithStub()
    const gate = (name: string) => path.join(cwd, name)
    const stateOf = async (id: string) => (await client.getRun(id)).run.state
    const reaches = (id: string, state: string) =>
      waitUntil(async () => (await stateOf(id)) === state || undefined, `state ${state}`)

    const run = await client.startRun(
      [
        { waitFor: gate('1') },
        { hook: 'PermissionRequest:Bash' },
        { waitFor: gate('2') },
        { hook: 'PreToolUse:Bash' },
        { waitFor: gate('3') },
        { endTurn: true },
        { waitFor: gate('4') },
        { exit: 0 },
      ],
      cwd,
    )

    await reaches(run.id, 'working')
    await writeFile(gate('1'), '')
    await reaches(run.id, 'waiting')
    await writeFile(gate('2'), '')
    await reaches(run.id, 'working')
    await writeFile(gate('3'), '')
    await reaches(run.id, 'idle')
    await writeFile(gate('4'), '')
    await reaches(run.id, 'finished')
  })

  test('starts claude with per-Run flags only, no API keys, and nothing in ~/.claude', async () => {
    const saved = { ...process.env }
    const fakeHome = await mkdtemp(path.join(tmpdir(), 'ted-user-home-'))
    process.env.HOME = fakeHome
    process.env.ANTHROPIC_API_KEY = 'sk-stray'
    process.env.ANTHROPIC_AUTH_TOKEN = 'stray-token'
    process.env.ELECTRON_RUN_AS_NODE = '1'
    try {
      const client = await startWithStub()
      const run = await client.startRun([{ endTurn: true }], cwd)
      const { argv, env } = await stubRecord()
      await waitUntil(
        async () => (await client.getRun(run.id)).run.state === 'idle' || undefined,
        'idle',
      )

      const runDir = path.join(home, 'runs', run.id)
      expect(argv.slice(0, 3)).toEqual(['-p', '--input-format', 'stream-json'])
      expect(argv).toEqual(
        expect.arrayContaining([
          '--output-format',
          'stream-json',
          '--verbose',
          '--include-hook-events',
          '--replay-user-messages',
          '--permission-mode',
          'auto',
        ]),
      )
      expect(argv).not.toContain('--bare')
      expect(argv[argv.indexOf('--settings') + 1]).toBe(path.join(runDir, 'settings.json'))
      for (const arg of argv) expect(arg).not.toContain('.claude')

      const settings = JSON.parse(await readFile(path.join(runDir, 'settings.json'), 'utf8'))
      expect(Object.keys(settings.hooks).sort()).toEqual(
        [
          'PermissionRequest',
          'PostToolUse',
          'PostToolUseFailure',
          'PreToolUse',
          'Stop',
          'StopFailure',
          'UserPromptSubmit',
        ].sort(),
      )

      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
      expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
      expect(env.TED_RUN).toBe(run.id)
      expect(env.TED_RUN_TOKEN).toMatch(new RegExp(`^${run.id}\\.[0-9a-f]{64}$`))
      expect(env.PATH?.split(':')[0]).toBe(path.join(home, 'bin'))
      await expect(stat(path.join(fakeHome, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      process.env = saved
      await rm(fakeHome, { recursive: true, force: true })
    }
  })

  test('a Run token may read Tasks but not start a Run, over HTTP and through ted', async () => {
    const client = await startWithStub()
    const run = await client.startRun(
      [
        { run: ['ted', 'task', 'list'] },
        { run: ['ted', 'dev', 'run', 'start', 'x'] },
        { endTurn: true },
      ],
      cwd,
    )

    const done = await waitUntil(async () => {
      const r = await client.getRun(run.id)
      return r.run.state === 'idle' ? r : undefined
    }, 'the Run to go idle')
    const [list, start] = assistantTexts(done.conversation).map(
      (t) => JSON.parse(t) as { code: number; stdout: string; stderr: string },
    )
    expect(list).toMatchObject({ code: 0, stdout: 'No Tasks yet.\n' })
    expect(start?.code).toBe(1)
    expect(start?.stderr).toContain('Not allowed from inside a Run')

    const runToken = (await stubRecord()).env.TED_RUN_TOKEN ?? ''
    const asRun = api(daemon?.port ?? 0, runToken)
    expect((await asRun.call('GET', '/tasks')).status).toBe(200)
    const refused = await asRun.call('POST', '/dev/runs', { prompt: 'x', cwd })
    expect(refused).toEqual({ status: 403, body: { error: 'Not allowed from inside a Run' } })
    expect((await asRun.call('GET', `/runs/${run.id}`)).status).toBe(403)
    expect(
      (await api(daemon?.port ?? 0, `${run.id}.${'0'.repeat(64)}`).call('GET', '/tasks')).status,
    ).toBe(401)
  })

  test('a Run whose host disappears without an exit record is marked finished', async () => {
    const client = await startWithStub()
    const run = await client.startRun([{ waitFor: path.join(cwd, 'never') }], cwd)
    const start = await waitUntil(
      async () => (await hostRecords(home, run.id)).find((r) => r.t === 'start'),
      'the host to start',
    )

    process.kill(start.hostPid as number, 'SIGKILL')
    process.kill(start.agentPid as number, 'SIGKILL')

    await waitUntil(
      async () => (await client.getRun(run.id)).run.state === 'finished' || undefined,
      'finished',
    )
  })
  test('a host that exits while the daemon is stopped keeps its whole backlog', async () => {
    let client = await startWithStub()
    const gate = path.join(cwd, 'go')
    const lines = 1_500
    const run = await client.startRun(
      [{ say: 'ready' }, { waitFor: gate }, { lines, everyMs: 0, pad: 1_000 }, { exit: 0 }],
      cwd,
    )
    await waitUntil(
      async () =>
        assistantTexts((await client.getRun(run.id)).conversation).includes('ready') || undefined,
      'the daemon to read the first line',
    )
    await daemon?.stop()
    daemon = undefined

    await writeFile(gate, '')
    await waitUntil(
      async () => (await hostRecords(home, run.id)).some((r) => r.t === 'exit') || undefined,
      'the host to exit',
      20_000,
    )

    client = await startWithStub()
    const done = await waitUntil(async () => {
      const r = await client.getRun(run.id)
      return r.run.state === 'finished' ? r : undefined
    }, 'the Run to finish')
    expect(assistantTexts(done.conversation)).toHaveLength(lines + 1)
  })
})

describe('Runs across daemon restarts', () => {
  const _mainPath = fileURLToPath(new URL('../src/main.ts', import.meta.url))
  let child: ChildProcess | undefined

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
    child = undefined
  })

  async function startDaemonProcess() {
    await rm(path.join(home, 'daemon.json'), { force: true })
    child = spawnDaemonProcess([], {
      ...process.env,
      TED_HOME: home,
      TED_CLAUDE_BIN: stubClaudePath,
    })
    const info = await waitUntil(() => readDaemonInfo(home), 'daemon.json')
    return api(info.port, testAppToken)
  }

  test('killing and restarting the daemon mid-turn loses no output and the Run keeps going', async () => {
    const release = path.join(cwd, 'release')
    let client = await startDaemonProcess()
    const run = await client.startRun(
      [
        { lines: 40, everyMs: 50 },
        { waitFor: release },
        { say: 'after restart' },
        { endTurn: true },
      ],
      cwd,
    )
    await waitUntil(
      async () =>
        assistantTexts((await client.getRun(run.id)).conversation).length >= 5 || undefined,
      'some output',
    )

    const killed = child
    killed?.kill('SIGKILL')
    if (killed) await once(killed, 'exit')
    await sleep(1_000)
    const agentPid = (await hostRecords(home, run.id)).find((r) => r.t === 'start')?.agentPid

    client = await startDaemonProcess()
    await writeFile(release, '')

    const done = await waitUntil(async () => {
      const r = await client.getRun(run.id)
      return r.run.state === 'idle' ? r : undefined
    }, 'the Run to go idle after the restart')
    const expected = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)
    expect(assistantTexts(done.conversation)).toEqual([...expected, 'after restart'])
    const records = await hostRecords(home, run.id)
    expect(records.filter((r) => r.t === 'start')).toHaveLength(1)
    expect(records.find((r) => r.t === 'start')?.agentPid).toBe(agentPid)
    expect(records.some((r) => r.t === 'exit')).toBe(false)
  })
})
