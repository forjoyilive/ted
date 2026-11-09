import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { Comment, Factory, Task } from '@ted/protocol'
import { readDaemonInfo } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  assistantTexts,
  commitToOrigin,
  hostRecords,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  spawnDaemonProcess,
  stubClaudePath,
  stubCodexPath,
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

async function startWithStubs() {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    codexBin: stubCodexPath,
  })
  return api(daemon.port, { appKey: daemon.appToken })
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

describe('Codex Runs', () => {
  test('a Codex Run’s output lands as its Conversation, with the thread ID as session ID', async () => {
    const client = await startWithStubs()

    const run = await client.startRun(
      [{ say: 'hello' }, { say: 'world' }, { endTurn: true }],
      cwd,
      'codex',
    )
    expect(run.agent).toBe('codex')

    const done = await waitUntil(async () => {
      const r = await client.getRun(run.id)
      return r.run.state === 'idle' ? r : undefined
    }, 'the Run to go idle')
    expect(assistantTexts(done.conversation)).toEqual(['hello', 'world'])
    expect(done.run.sessionId).toMatch(/^0199a000-/)
  })

  test('Codex events move the Run between working, waiting, idle and finished', async () => {
    const client = await startWithStubs()
    const gate = (name: string) => path.join(cwd, name)
    const stateOf = async (id: string) => (await client.getRun(id)).run.state
    const reaches = (id: string, state: string) =>
      waitUntil(async () => (await stateOf(id)) === state || undefined, `state ${state}`)

    const run = await client.startRun(
      [{ waitFor: gate('1') }, { endTurn: true }, { waitFor: gate('2') }, { exit: 0 }],
      cwd,
      'codex',
    )

    await reaches(run.id, 'working')
    await writeFile(gate('1'), '')
    await reaches(run.id, 'idle')
    await writeFile(gate('2'), '')
    await reaches(run.id, 'finished')
  })

  test('a Run outside a Task has no one to ask, so its approval requests are declined', async () => {
    const client = await startWithStubs()
    const run = await client.startRun(
      [{ approval: 'command' }, { approval: 'fileChange' }, { endTurn: true }],
      cwd,
      'codex',
    )
    const done = await waitUntil(async () => {
      const r = await client.getRun(run.id)
      return r.run.state === 'idle' ? r : undefined
    }, 'the Run to go idle')
    expect(assistantTexts(done.conversation).map((t) => JSON.parse(t))).toEqual([
      { decision: 'decline' },
      { decision: 'decline' },
    ])
  })

  test('starts codex app-server with per-Run flags only, no CODEX_API_KEY, nothing in ~/.codex', async () => {
    const saved = { ...process.env }
    const fakeHome = await mkdtemp(path.join(tmpdir(), 'ted-user-home-'))
    process.env.HOME = fakeHome
    delete process.env.CODEX_HOME
    process.env.CODEX_API_KEY = 'sk-stray'
    process.env.OPENAI_API_KEY = 'sk-openai'
    try {
      const client = await startWithStubs()
      const run = await client.startRun([{ endTurn: true }], cwd, 'codex')
      const { argv, env } = await stubRecord()
      await waitUntil(
        async () => (await client.getRun(run.id)).run.state === 'idle' || undefined,
        'idle',
      )

      expect(argv).toEqual([
        'app-server',
        '-c',
        'sandbox_mode="workspace-write"',
        '-c',
        'approval_policy="on-request"',
        '-c',
        'sandbox_workspace_write.network_access=true',
        '-c',
        'shell_environment_policy.inherit="all"',
        '-c',
        'shell_environment_policy.ignore_default_excludes=true',
        '-c',
        'shell_environment_policy.exclude=["CODEX_API_KEY","OPENAI_API_KEY"]',
      ])
      expect(env.CODEX_API_KEY).toBeUndefined()
      expect(env.OPENAI_API_KEY).toBeUndefined()
      expect(env.TED_RUN).toBe(run.id)
      expect(env.TED_RUN_TOKEN).toMatch(new RegExp(`^${run.id}\\.[0-9a-f]{64}$`))
      expect(env.PATH?.split(':')[0]).toBe(path.join(home, 'bin'))
      await expect(stat(path.join(fakeHome, '.codex'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      process.env = saved
      await rm(fakeHome, { recursive: true, force: true })
    }
  })

  test('a Codex Run reaches the daemon through ted', async () => {
    const client = await startWithStubs()
    const run = await client.startRun(
      [{ run: ['ted', 'task', 'list'] }, { endTurn: true }],
      cwd,
      'codex',
    )
    const done = await waitUntil(async () => {
      const r = await client.getRun(run.id)
      return r.run.state === 'idle' ? r : undefined
    }, 'the Run to go idle')
    const [list] = assistantTexts(done.conversation).map((t) => JSON.parse(t))
    expect(list).toMatchObject({ code: 0, stdout: 'No Tasks yet.\n' })
  })

  test('a Codex Run whose turn can’t start is stopped and marked finished', async () => {
    const client = await startWithStubs()
    const res = await client.call('POST', '/dev/runs', {
      prompt: 'reject-turn',
      cwd,
      agent: 'codex',
    })
    const done = await waitUntil(async () => {
      const r = await client.getRun(res.body.id)
      return r.run.state === 'finished' ? r : undefined
    }, 'the Run to finish')
    expect(done.conversation.some((e) => e.line.includes('turn rejected'))).toBe(true)
  })

  test('an unknown agent kind is refused', async () => {
    const client = await startWithStubs()
    const res = await client.call('POST', '/dev/runs', { prompt: 'x', cwd, agent: 'gemini' })
    expect(res).toEqual({ status: 400, body: { error: 'agent must be claude or codex' } })
  })
})

describe('Codex as the Task Lead', () => {
  let scratch: string

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'ted-origin-'))
  })

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  test('with Claude Code not installed, the Task Lead is Codex and carries the Task to Done', async () => {
    const origin = await makeOriginRepo(scratch)
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
    daemon = await startDaemon({
      home,
      version: '9.9.9',
      claudeBin: path.join(scratch, 'no-claude-here'),
      codexBin: stubCodexPath,
    })
    const client = api(daemon.port, { appKey: daemon.appToken })
    const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
      const res = await client.call(method, route, body)
      if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
      return res.body as T
    }
    await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
    const advance = { run: ['ted', 'outcome', 'advance'] }
    const task = await ok<Task>('POST', '/tasks', {
      title: JSON.stringify({
        steps: [
          { run: ['ted', 'comment', 'From Codex'] },
          ...Array.from({ length: 10 }, () => advance),
          { waitFor: 'never-appears' },
        ],
      }),
      factory: 'NB',
    })

    await ok('POST', `/tasks/${task.displayId}/start`)

    const done = await waitUntil(async () => {
      const t = (await ok<Task[]>('GET', '/tasks')).find((x) => x.id === task.id)
      return t?.stage === 'done' ? t : undefined
    }, 'the Task to reach Done')
    const comments = await ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
    expect(comments).toMatchObject([{ body: 'From Codex' }])
    const lead = await client.getRun(done.leadRunId ?? '')
    expect(lead.run.agent).toBe('codex')
    expect(lead.run.sessionId).toMatch(/^0199a000-/)
    await waitUntil(
      async () => (await client.getRun(lead.run.id)).run.state === 'finished' || undefined,
      'the Task Lead’s Run to stop',
    )
  })
})

describe('Codex and the Workflow', () => {
  let scratch: string

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'ted-origin-'))
  })

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  test('a Codex Task Lead gets the next Stage file as a new turn', async () => {
    const origin = await makeOriginRepo(scratch)
    daemon = await startDaemon({
      home,
      version: '9.9.9',
      claudeBin: path.join(scratch, 'no-claude-here'),
      codexBin: stubCodexPath,
    })
    const client = api(daemon.port, { appKey: daemon.appToken })
    const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
      const res = await client.call(method, route, body)
      if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
      return res.body as T
    }
    await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
    const task = await ok<Task>('POST', '/tasks', {
      title: JSON.stringify({
        steps: [{ run: ['ted', 'outcome', 'advance'] }, { endTurn: true }],
      }),
      factory: 'NB',
    })

    await ok('POST', `/tasks/${task.displayId}/start`)

    const lead = await waitUntil(async () => {
      const t = (await ok<Task[]>('GET', '/tasks')).find((x) => x.id === task.id)
      return t?.stage === 'clarify' ? t.leadRunId : undefined
    }, 'the Task to reach Clarify')
    await waitUntil(async () => {
      const { conversation } = await client.getRun(lead)
      return conversation.some(
        (e) => e.line.includes('userMessage') && e.line.includes('TED moved this Task to Clarify'),
      )
    }, 'the Clarify Stage file to reach the Codex Task Lead')
  })
})

describe('Codex Runs across daemon restarts', () => {
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
      TED_CODEX_BIN: stubCodexPath,
    })
    const info = await waitUntil(() => readDaemonInfo(home), 'daemon.json')
    return api(info.port, { appKey: testAppToken })
  }

  test('a Codex Run survives a daemon restart and reattaches to the same agent process', async () => {
    const release = path.join(cwd, 'release')
    let client = await startDaemonProcess()
    const run = await client.startRun(
      [
        { lines: 20, everyMs: 50 },
        { waitFor: release },
        { say: 'after restart' },
        { endTurn: true },
      ],
      cwd,
      'codex',
    )
    await waitUntil(
      async () =>
        assistantTexts((await client.getRun(run.id)).conversation).length >= 5 || undefined,
      'some output',
    )

    const killed = child
    killed?.kill('SIGKILL')
    if (killed) await once(killed, 'exit')
    await sleep(500)
    const agentPid = (await hostRecords(home, run.id)).find((r) => r.t === 'start')?.agentPid

    client = await startDaemonProcess()
    await writeFile(release, '')

    const done = await waitUntil(async () => {
      const r = await client.getRun(run.id)
      return r.run.state === 'idle' ? r : undefined
    }, 'the Run to go idle after the restart')
    const expected = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
    expect(assistantTexts(done.conversation)).toEqual([...expected, 'after restart'])
    expect(done.run.agent).toBe('codex')
    expect(done.run.sessionId).toMatch(/^0199a000-/)
    const records = await hostRecords(home, run.id)
    expect(records.filter((r) => r.t === 'start')).toHaveLength(1)
    expect(records.find((r) => r.t === 'start')?.agentPid).toBe(agentPid)
  })
})
