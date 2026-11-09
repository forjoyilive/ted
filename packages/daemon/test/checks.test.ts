import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Banner, CheckRun, Factory, SendBack, Task } from '@ted/protocol'
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
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-checks-'))
  origin = await makeOriginRepo(scratch)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  const runIds = await readdir(path.join(home, 'runs')).catch(() => [])
  for (const runId of runIds) {
    await waitUntil(
      async () => (await hostRecords(home, runId)).some((r) => r.t === 'start'),
      `Run ${runId}’s host to start`,
    ).catch(() => undefined)
  }
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function startTed() {
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  return { ...client, ok }
}

type Client = Awaited<ReturnType<typeof startTed>>

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })
const advance = { run: ['ted', 'outcome', 'advance'] }

const workflow = (checks: string, extra: Record<string, string> = {}) =>
  commitToOrigin(scratch, {
    '.gitignore': 'stub-*\n',
    '.ted/workflow.yaml': [
      'version: 1',
      'order: [intake, work, validate]',
      'stages:',
      '  validate:',
      '    max_back: 5',
      ...(checks === '' ? [] : ['    checks:', checks]),
      '',
    ].join('\n'),
    ...extra,
  })

async function startTask(client: Client, title: string): Promise<Task> {
  await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const task = await client.ok<Task>('POST', '/tasks', { title, factory: 'NB' })
  await client.ok('POST', `/tasks/${task.id}/start`)
  return task
}

const getTask = async (client: Client, id: string) =>
  (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)

const checkRuns = (client: Client, task: Task) =>
  client.ok<CheckRun[]>('GET', `/tasks/${task.id}/check-runs`)

const finishedRuns = (client: Client, task: Task, count: number) =>
  waitUntil(
    async () => {
      const runs = (await checkRuns(client, task)).filter((r) => r.finishedAt !== undefined)
      return runs.length >= count ? runs : undefined
    },
    `${count} finished Check runs`,
    40_000,
  )

const userMessages = async (client: Client, runId: string) =>
  (await client.getRun(runId)).conversation.flatMap((e) => {
    const line = JSON.parse(e.line) as { type: string; message?: { content?: unknown } }
    return line.type === 'user' && typeof line.message?.content === 'string'
      ? [line.message.content]
      : []
  })

const leadMessages = async (client: Client, task: Task) => {
  const current = await getTask(client, task.id)
  return current?.leadRunId ? userMessages(client, current.leadRunId) : []
}

const sendBacks = (client: Client, task: Task) =>
  waitUntil(async () => {
    const found = await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)
    return found.length > 0 ? found : undefined
  }, 'a send-back')

const states = (run: CheckRun | undefined) => run?.checks.map((c) => [c.name, c.state])

describe('Checks at Validate', () => {
  test('Checks run in order, the first failure sends the Task back to Work with its output', async () => {
    const flag = path.join(scratch, 'failed-once')
    await workflow(
      [
        '      - { name: Typecheck, run: "echo typed" }',
        `      - { name: Tests, run: "if [ -e '${flag}' ]; then echo ok; else touch '${flag}'; seq 1 300; echo token ghp_abcdefghijklmnopqrstuvwxyz0123; exit 1; fi" }`,
        '      - { name: Lint, run: "echo linted" }',
      ].join('\n'),
    )
    const client = await startTed()
    const task = await startTask(
      client,
      steps({ everyMessage: [{ run: ['sh', '-c', 'echo x > work.txt'] }, advance] }, advance),
    )

    const [first, second] = await finishedRuns(client, task, 2)
    expect(first?.trigger).toBe('validate')
    expect(first?.stage).toBe('validate')
    expect(states(first)).toEqual([
      ['Typecheck', 'passed'],
      ['Tests', 'failed'],
      ['Lint', 'not-run'],
    ])
    expect(first?.outcome).toBe('failed')
    expect(states(second)).toEqual([
      ['Typecheck', 'passed'],
      ['Tests', 'passed'],
      ['Lint', 'passed'],
    ])

    const [sendBack] = await sendBacks(client, task)
    expect(sendBack).toMatchObject({
      from: 'validate',
      to: 'work',
      counted: true,
      round: 1,
      limit: 5,
      checkRunId: first?.id,
    })
    expect(sendBack?.findings).toContain('Tests')
    expect(sendBack?.findings).toContain('\n102\n')
    expect(sendBack?.findings).not.toContain('\n101\n')
    expect(sendBack?.findings).toContain('[redacted]')
    expect(sendBack?.findings).not.toContain('ghp_abcdefghij')
    expect(sendBack?.findings).toMatch(/Full output: .*checks.*2\.log/)

    const messages = await waitUntil(async () => {
      const all = await leadMessages(client, task)
      return all.some((m) => m.includes('None failed')) ? all : undefined
    }, 'the Validate instructions after the Checks pass')
    expect(
      messages.some((m) => m.includes('moved this Task back to Work') && m.includes('\n300\n')),
    ).toBe(true)
    const passed = messages.find((m) => m.includes('None failed')) ?? ''
    expect(passed).toContain('✓ Typecheck\n✓ Tests\n✓ Lint')
    expect(passed).toContain('TED moved this Task to Validate')

    const output = await client.ok<{ text: string }>(
      'GET',
      `/check-runs/${first?.id}/checks/1/output`,
    )
    expect(output.text.split('\n')[0]).toBe('1')
    expect(output.text).not.toContain('ghp_abcdefghij')
  })

  test('a Check past its timeout fails and the Checks after it don’t run', async () => {
    await workflow(
      [
        '      - { name: Tests, run: "sleep 30", timeout: 1s }',
        '      - { name: Lint, run: "echo linted" }',
      ].join('\n'),
    )
    const client = await startTed()
    const task = await startTask(
      client,
      steps(
        { everyMessage: [{ endTurn: true }] },
        { run: ['sh', '-c', 'echo x > a.txt'] },
        advance,
        advance,
      ),
    )

    const [run] = await finishedRuns(client, task, 1)
    expect(states(run)).toEqual([
      ['Tests', 'timed-out'],
      ['Lint', 'not-run'],
    ])
    const [sendBack] = await sendBacks(client, task)
    expect(sendBack?.findings).toContain('timed out after 1s')
  })

  test('a Check whose command isn’t found raises the setup-suggested banner', async () => {
    await workflow('      - { name: E2E, run: "ted-no-such-command-xyz --all" }')
    const client = await startTed()
    const task = await startTask(
      client,
      steps(
        { everyMessage: [{ endTurn: true }] },
        { run: ['sh', '-c', 'echo x > a.txt'] },
        advance,
        advance,
      ),
    )

    const [run] = await finishedRuns(client, task, 1)
    expect(run?.checks[0]).toMatchObject({ state: 'failed', exitCode: 127 })
    const banners = await client.ok<Banner[]>('GET', '/banners')
    expect(banners.find((b) => b.problem === 'setup-suggested')).toMatchObject({
      severity: 'warning',
      text: 'A Check’s command wasn’t found: `ted-no-such-command-xyz --all`',
      action: { label: 'Open Factory settings' },
    })
  })

  test('Checks in a repo the Task didn’t change are skipped', async () => {
    await workflow('      - { name: Tests, run: "touch ran.txt" }')
    const client = await startTed()
    const task = await startTask(
      client,
      steps({ everyMessage: [{ endTurn: true }] }, advance, advance),
    )

    const [run] = await finishedRuns(client, task, 1)
    expect(states(run)).toEqual([['Tests', 'skipped']])
    expect(run?.outcome).toBe('passed')
    const messages = await waitUntil(async () => {
      const all = await leadMessages(client, task)
      return all.some((m) => m.includes('None failed')) ? all : undefined
    }, 'the Validate instructions')
    expect(messages.at(-1)).toContain('– Tests · skipped, no changes')
    expect(await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)).toEqual([])
  })

  test('with no Checks, Validate gets its instructions straight away', async () => {
    await workflow('')
    const client = await startTed()
    const task = await startTask(
      client,
      steps({ everyMessage: [{ endTurn: true }] }, advance, advance),
    )

    await waitUntil(async () => {
      const all = await leadMessages(client, task)
      return all.some((m) => m.includes('TED moved this Task to Validate')) || undefined
    }, 'the Validate instructions')
    expect(await checkRuns(client, task)).toEqual([])
    const banners = await client.ok<Banner[]>('GET', '/banners')
    expect(banners.some((b) => b.problem === 'no-checks')).toBe(true)
  })

  test('while Checks run the Task is Working and says which Check, without a working slot', async () => {
    const go = path.join(scratch, 'go')
    await workflow(
      [
        '      - { name: Typecheck, run: "echo typed" }',
        `      - { name: Tests, run: "while [ ! -e '${go}' ]; do sleep 0.05; done" }`,
        '      - { name: Lint, run: "echo linted" }',
      ].join('\n'),
    )
    const client = await startTed()
    const task = await startTask(
      client,
      steps(
        { everyMessage: [{ endTurn: true }] },
        { run: ['sh', '-c', 'echo x > a.txt'] },
        advance,
        advance,
      ),
    )

    const running = await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current?.activity?.includes('Tests') ? current : undefined
    }, 'the Checks to start')
    expect(running.activity).toBe('Running Checks · Tests (2 of 3)')
    expect(running.status).toEqual({ kind: 'working' })
    const slots = await client.ok<{ holders: { taskId: string }[] }>('GET', '/slots')
    expect(slots.holders.some((h) => h.taskId === task.id)).toBe(false)
    expect(await client.ok<{ checksRunning: number }>('GET', '/activity')).toMatchObject({
      checksRunning: 1,
    })
    expect(await client.ok('GET', '/update/work')).toEqual({ checks: 1, merges: 0 })

    await writeFile(go, '')
    await finishedRuns(client, task, 1)
    expect(await client.ok('GET', '/update/work')).toEqual({ checks: 0, merges: 0 })
  })

  test('a Task whose changes touch .ted/ gets the TED settings Check', async () => {
    await workflow('      - { name: Typecheck, run: "echo typed" }')
    const client = await startTed()
    const task = await startTask(
      client,
      steps(
        { everyMessage: [{ endTurn: true }] },
        advance,
        { run: ['sh', '-c', 'printf "version: [\\n" > .ted/workflow.yaml'] },
        advance,
      ),
    )

    const [run] = await finishedRuns(client, task, 1)
    expect(states(run)).toEqual([
      ['Typecheck', 'passed'],
      ['TED settings', 'failed'],
    ])
    expect(run?.checks[1]).toMatchObject({ command: 'ted workflow check', builtIn: 'ted-settings' })
    const output = await client.ok<{ text: string }>(
      'GET',
      `/check-runs/${run?.id}/checks/1/output`,
    )
    expect(output.text).toContain('.ted/workflow.yaml:')
  })
})

describe('Checks over the send-back limit and across restarts', () => {
  test('past max_back a failing Check asks the human instead of sending back', async () => {
    await commitToOrigin(scratch, {
      '.gitignore': 'stub-*\n',
      '.ted/workflow.yaml': [
        'version: 1',
        'order: [intake, work, validate]',
        'stages:',
        '  validate:',
        '    max_back: 1',
        '    checks:',
        '      - { name: Tests, run: "echo nope; exit 1" }',
        '',
      ].join('\n'),
    })
    const client = await startTed()
    const task = await startTask(
      client,
      steps({ everyMessage: [advance] }, { run: ['sh', '-c', 'echo x > a.txt'] }, advance),
    )

    const question = await waitUntil(
      async () => {
        const comments = await client.ok<
          { id: string; kind: string; title?: string; author: { kind: string } }[]
        >('GET', `/tasks/${task.id}/comments`)
        return comments.find((c) => c.kind === 'question')
      },
      'the question to the human',
      40_000,
    )
    expect(question).toMatchObject({
      author: { kind: 'ted' },
      title: 'Validate has sent this Task back 1 time, its limit',
      choices: ['Try again', 'Move to Done anyway'],
    })
    expect(await sendBacks(client, task)).toHaveLength(1)
    const messages = await waitUntil(async () => {
      const all = await leadMessages(client, task)
      return all.some((m) => m.includes('# A Check failed')) ? all : undefined
    }, 'the note that TED asked the human')
    expect(messages.find((m) => m.includes('# A Check failed'))).toContain('asked the human')
    await waitUntil(async () => {
      const id = (await getTask(client, task.id))?.leadRunId
      if (!id) return undefined
      return assistantTexts((await client.getRun(id)).conversation).some((t) =>
        t.includes('TED asked the human whether to keep sending NB-1 back'),
      )
    }, 'the Task Lead’s advance to be refused')
    expect((await getTask(client, task.id))?.stage).toBe('validate')
    await client.ok('POST', `/comments/${question.id}/answer`, {
      action: 'answer',
      choice: 'Move to Done anyway',
    })
    await waitUntil(
      async () => (await getTask(client, task.id))?.stage === 'done' || undefined,
      'the Task Lead to finish',
      40_000,
    )
    await waitUntil(
      async () => (await getTask(client, task.id))?.repos.every((r) => r.removed) || undefined,
      'the worktree to be removed',
      40_000,
    )
  }, 90_000)

  test('Checks cut short by a daemon restart run again from the start', async () => {
    const go = path.join(scratch, 'go')
    const count = path.join(scratch, 'count')
    await workflow(
      `      - { name: Tests, run: "echo run >> '${count}'; while [ ! -e '${go}' ]; do sleep 0.05; done" }`,
    )
    let client = await startTed()
    const task = await startTask(
      client,
      steps(
        { everyMessage: [{ endTurn: true }] },
        { run: ['sh', '-c', 'echo x > a.txt'] },
        advance,
        advance,
      ),
    )
    await waitUntil(
      () =>
        readFile(count, 'utf8').then(
          (t) => t === 'run\n' || undefined,
          () => undefined,
        ),
      'the Check to start',
      40_000,
    )

    await daemon?.stop()
    client = await startTed()
    await waitUntil(
      () =>
        readFile(count, 'utf8').then(
          (t) => t === 'run\nrun\n' || undefined,
          () => undefined,
        ),
      'the Check to run again',
      40_000,
    )
    await writeFile(go, '')

    const [first, second] = await finishedRuns(client, task, 2)
    expect(first?.outcome).toBe('interrupted')
    expect(second?.outcome).toBe('passed')
    await waitUntil(async () => {
      const all = await leadMessages(client, task)
      return all.some((m) => m.includes('None failed')) || undefined
    }, 'the Validate instructions')
  }, 90_000)
})

describe('the Checks’ environment', () => {
  test('Checks get worktree.env, CI=1 and TED_TASK, and none of the daemon’s TED_ names or agent credentials', async () => {
    const seen = path.join(scratch, 'env-seen.txt')
    const planted = {
      ANTHROPIC_API_KEY: 'anthropic-secret',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-token',
      OPENAI_API_KEY: 'openai-secret',
      CODEX_API_KEY: 'codex-secret',
      TED_APP_WEB_PORT: '5174',
      TED_PRIVATE_THING: 'internal',
      KEEP_ME: 'kept',
    }
    const before = { ...process.env }
    Object.assign(process.env, planted)
    try {
      await commitToOrigin(scratch, {
        '.gitignore': 'stub-*\n',
        '.ted/workflow.yaml': [
          'version: 1',
          'order: [intake, work, validate]',
          'repos:',
          '  - name: widgets',
          '    worktree:',
          '      env:',
          '        GREETING: hello',
          'stages:',
          '  validate:',
          '    checks:',
          `      - { name: Env, run: "env > '${seen}'" }`,
          '',
        ].join('\n'),
      })
      const client = await startTed()
      const task = await startTask(
        client,
        steps(
          { everyMessage: [{ endTurn: true }] },
          { run: ['sh', '-c', 'echo x > a.txt'] },
          advance,
          advance,
        ),
      )
      await finishedRuns(client, task, 1)
    } finally {
      for (const name of Object.keys(planted)) {
        if (before[name] === undefined) delete process.env[name]
        else process.env[name] = before[name]
      }
    }
    const env = Object.fromEntries(
      (await readFile(seen, 'utf8'))
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    )
    expect(env.CI).toBe('1')
    expect(env.TED_TASK).toBe('NB-1')
    expect(env.GREETING).toBe('hello')
    expect(env.KEEP_ME).toBe('kept')
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'TED_APP_WEB_PORT',
      'TED_PRIVATE_THING',
      'TED_HOME',
    ]) {
      expect(env[name], name).toBeUndefined()
    }
  }, 90_000)

  test('Checks run in the login shell and environment TED read at start, not the daemon’s own', async () => {
    const loginBin = path.join(scratch, 'login-bin')
    await mkdir(loginBin)
    await writeFile(path.join(loginBin, 'login-tool'), '#!/bin/sh\nprintf %s "$1"\n')
    await chmod(path.join(loginBin, 'login-tool'), 0o755)
    const shell = path.join(scratch, 'fake-login-shell')
    const seen = path.join(scratch, 'check-saw')
    await writeFile(
      shell,
      [
        '#!/bin/sh',
        `if [ "$1" = "-lc" ]; then echo login-shell > '${seen}'; exec /bin/sh -c "$2"; fi`,
        `PATH='${loginBin}':"$PATH"`,
        'export PATH',
        'exec /bin/sh -c "$4"',
        '',
      ].join('\n'),
    )
    await chmod(shell, 0o755)
    await workflow(`      - { name: Tool, run: "login-tool ran >> '${seen}'" }`)
    const realShell = process.env.SHELL
    process.env.SHELL = shell
    daemon = await startDaemon({
      home,
      version: '9.9.9',
      claudeBin: stubClaudePath,
      integrations: { loginShell: true },
    }).finally(() => {
      process.env.SHELL = realShell
    })
    const client = api(daemon.port, { appKey: daemon.appToken })
    const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
      const res = await client.call(method, route, body)
      if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
      return res.body as T
    }
    const task = await startTask(
      { ...client, ok },
      steps(
        { everyMessage: [{ endTurn: true }] },
        { run: ['sh', '-c', 'echo x > a.txt'] },
        advance,
        advance,
      ),
    )
    const [run] = await finishedRuns({ ...client, ok }, task, 1)
    expect(states(run)).toEqual([['Tool', 'passed']])
    expect(await readFile(seen, 'utf8')).toBe('login-shell\nran')
  }, 90_000)
})

describe('ted checks', () => {
  test('Work runs the Checks; the results go back to the agent and into one Check run', async () => {
    await workflow(
      [
        '      - { name: Typecheck, run: "echo typed" }',
        '      - { name: Tests, run: "echo broken; exit 2" }',
        '      - { name: Lint, run: "echo linted" }',
      ].join('\n'),
    )
    const client = await startTed()
    const task = await startTask(
      client,
      steps(
        { everyMessage: [{ endTurn: true }] },
        advance,
        { run: ['sh', '-c', 'echo x > a.txt'] },
        { run: ['ted', 'checks'] },
        { run: ['ted', 'checks', '--name', 'Typecheck'] },
        { endTurn: true },
      ),
    )

    const runs = await finishedRuns(client, task, 2)
    expect(runs.map((r) => [r.trigger, r.stage])).toEqual([
      ['agent', 'work'],
      ['agent', 'work'],
    ])
    expect(states(runs[0])).toEqual([
      ['Typecheck', 'passed'],
      ['Tests', 'failed'],
      ['Lint', 'not-run'],
    ])
    expect(states(runs[1])).toEqual([['Typecheck', 'passed']])
    const current = await getTask(client, task.id)
    const results = await waitUntil(async () => {
      const texts = assistantTexts((await client.getRun(current?.leadRunId ?? '')).conversation)
        .filter((t) => t.startsWith('{'))
        .map((t) => JSON.parse(t) as { code: number; stdout: string })
      return texts.length >= 4 ? texts : undefined
    }, 'the ted checks results')
    expect(results[2]?.code).toBe(1)
    expect(results[2]?.stdout).toContain('exit code 2')
    expect(results[2]?.stdout).toContain('broken')
    expect(results[2]?.stdout).toContain('– Lint · not run')
    expect(results[3]?.code).toBe(0)
    expect(results[3]?.stdout).toContain('✓ Typecheck')
    expect((await getTask(client, task.id))?.stage).toBe('work')
  })

  test('a Check name the Factory doesn’t have is refused', async () => {
    await workflow('      - { name: Typecheck, run: "echo typed" }')
    const client = await startTed()
    const task = await startTask(
      client,
      steps({ run: ['ted', 'checks', '--name', 'Nope'] }, { endTurn: true }),
    )
    const current = await waitUntil(async () => {
      const t = await getTask(client, task.id)
      return t?.leadRunId ? t : undefined
    }, 'the Task Lead')
    const [result] = await waitUntil(async () => {
      const texts = assistantTexts((await client.getRun(current.leadRunId ?? '')).conversation)
      return texts.length > 0
        ? texts.map((t) => JSON.parse(t) as { code: number; stderr: string })
        : undefined
    }, 'the ted checks result')
    expect(result?.code).not.toBe(0)
    expect(result?.stderr).toContain('no Check named “Nope”')
    expect(await checkRuns(client, task)).toEqual([])
  })
})
