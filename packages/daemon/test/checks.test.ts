import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type {
  Activity,
  Banner,
  CheckRun,
  Factory,
  FailureCase,
  SendBack,
  Task,
  ThreadEvent,
} from '@ted/protocol'
import { shortReference } from '@ted/protocol/reference'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  assistantTexts,
  commitToOrigin,
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

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-checks-'))
  origin = await makeOriginRepo(scratch)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home, { waitForStart: true })
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function startTed() {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    codexBin: stubCodexPath,
  })
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

async function startTask(client: Client, title: string, bypass = false): Promise<Task> {
  const factory = await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  if (bypass)
    await client.ok('PUT', `/factories/${factory.id}/permissions`, {
      mode: 'bypass',
      confirmBypass: true,
    })
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

const worktreeFile = async (client: Client, task: Task, name: string) => {
  const repo = await waitUntil(
    async () => (await getTask(client, task.id))?.repos[0],
    `${task.displayId}’s worktree`,
  )
  return path.join(repo.worktree, name)
}

const states = (run: CheckRun | undefined) => run?.checks.map((c) => [c.name, c.state])

const threadEvents = (client: Client, task: Task) =>
  client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)

const counter =
  'f="stub-n-$TED_RUN"; n=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$f";'

describe('Checks before a Task leaves Work', () => {
  test('a failure keeps the Task in Work with its output and no send-back; the run that passes is the one Validate uses', async () => {
    const flag = 'stub-failed-once'
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

    await waitUntil(
      async () => (await getTask(client, task.id))?.stage === 'done' || undefined,
      'the Task to finish',
      60_000,
    )
    const [first, second, ...more] = await checkRuns(client, task)
    expect(more).toEqual([])
    expect(first?.trigger).toBe('hand-off')
    expect(first?.stage).toBe('work')
    expect(states(first)).toEqual([
      ['Typecheck', 'passed'],
      ['Tests', 'failed'],
      ['Lint', 'not-run'],
    ])
    expect(first?.outcome).toBe('failed')
    expect(second?.trigger).toBe('hand-off')
    expect(states(second)).toEqual([
      ['Typecheck', 'passed'],
      ['Tests', 'passed'],
      ['Lint', 'passed'],
    ])
    expect(await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)).toEqual([])

    const messages = await leadMessages(client, task)
    const failed = messages.find((m) => m.startsWith('# A Check failed')) ?? ''
    expect(failed).toContain('so the Task stays in Work')
    expect(failed).toContain('This is failure 1 of 3 in this visit to Work')
    expect(failed).toContain('\n102\n')
    expect(failed).not.toContain('\n101\n')
    expect(failed).toContain('[redacted]')
    expect(failed).not.toContain('ghp_abcdefghij')
    expect(failed).toMatch(/Full output: .*checks.*2\.log/)
    expect(messages.some((m) => m.includes('moved this Task back to Work'))).toBe(false)
    const passed = messages.find((m) => m.includes('None failed')) ?? ''
    expect(passed).toContain('✓ Typecheck\n✓ Tests\n✓ Lint')
    expect(passed).toContain('TED moved this Task to Validate')
    expect(passed).toContain('before moving the Task out of Work')

    const events = await threadEvents(client, task)
    expect(events.find((e) => e.validate === 'passed')?.checkRunId).toBe(second?.id)
    expect(events.some((e) => e.text.includes('sent this back'))).toBe(false)

    const output = await client.ok<{ text: string }>(
      'GET',
      `/check-runs/${first?.id}/checks/1/output`,
    )
    expect(output.text.split('\n')[0]).toBe('1')
    expect(output.text).not.toContain('ghp_abcdefghij')
  }, 90_000)

  test('after three failures in one Work visit TED asks the human and refuses an outcome until they answer; Diagnose in Validate moves the Task and the failure becomes a failure case', async () => {
    await workflow('      - { name: Tests, run: "echo nope; exit 1" }')
    const client = await startTed()
    const task = await startTask(
      client,
      steps({ everyMessage: [advance] }, { run: ['sh', '-c', 'echo x > a.txt'] }, advance, {
        endTurn: true,
      }),
    )

    const questions = () =>
      client.ok<
        {
          id: string
          kind: string
          title?: string
          body: string
          author: { kind: string }
          answer?: unknown
        }[]
      >('GET', `/tasks/${task.id}/comments`)
    const question = await waitUntil(
      async () => {
        return (await questions()).find((c) => c.kind === 'question')
      },
      'the question to the human',
      60_000,
    )
    expect(question).toMatchObject({
      author: { kind: 'ted' },
      title: 'Checks have failed 3 times as NB-1 tried to leave Work',
      choices: ['Try again', 'Diagnose in Validate'],
      purpose: { kind: 'send-back' },
    })
    expect(question.body).toContain('**Try again** keeps the Task in Work')
    expect(question.body).toContain('**Diagnose in Validate** moves the Task to Validate')
    expect((await finishedRuns(client, task, 3)).map((r) => [r.trigger, r.outcome])).toEqual([
      ['hand-off', 'failed'],
      ['hand-off', 'failed'],
      ['hand-off', 'failed'],
    ])
    expect(await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)).toEqual([])
    await waitUntil(async () => {
      const id = (await getTask(client, task.id))?.leadRunId
      if (!id) return undefined
      return assistantTexts((await client.getRun(id)).conversation).some((t) =>
        t.includes('TED asked the human about NB-1’s failing Checks'),
      )
    }, 'the Task Lead’s advance to be refused')
    expect((await getTask(client, task.id))?.stage).toBe('work')
    expect((await threadEvents(client, task)).map((e) => e.text)).toContain(
      'Checks kept failing as this Task tried to leave Work, so TED asked the human',
    )

    await client.ok('POST', `/comments/${question.id}/answer`, {
      action: 'answer',
      choice: 'Try again',
    })
    await finishedRuns(client, task, 4)
    await waitUntil(
      async () =>
        (await leadMessages(client, task)).some((m) =>
          m.includes('This is failure 1 of 3 in this visit to Work'),
        ) || undefined,
      'the count to start over after the answer',
    )
    expect((await getTask(client, task.id))?.stage).toBe('work')

    const second = await waitUntil(
      async () => (await questions()).find((c) => c.kind === 'question' && c.answer === undefined),
      'the second question to the human',
      60_000,
    )
    await client.ok('POST', `/comments/${second.id}/answer`, {
      action: 'answer',
      choice: 'Diagnose in Validate',
      text: 'Tests are broken on main',
    })
    const runs = await finishedRuns(client, task, 7)
    expect(runs.slice(3).map((r) => [r.trigger, r.stage, r.outcome])).toEqual([
      ['hand-off', 'work', 'failed'],
      ['hand-off', 'work', 'failed'],
      ['hand-off', 'work', 'failed'],
      ['validate', 'validate', 'failed'],
    ])
    const failure = await waitUntil(
      async () => (await client.ok<FailureCase[]>('GET', `/tasks/${task.id}/failures`))[0],
      'the failure case in Validate',
    )
    expect(failure.evidence).toContain('nope')
    expect((await getTask(client, task.id))?.stage).toBe('validate')
    expect(await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)).toEqual([])
    const chosen = await waitUntil(
      async () =>
        (await leadMessages(client, task)).find((m) => m.includes('with Diagnose in Validate')),
      'the Task Lead to hear what the human chose',
    )
    expect(chosen).toContain('The human added:\n\nTests are broken on main')
    expect(chosen).toContain(shortReference(failure.id))
  }, 180_000)
})

describe('Checks at Validate', () => {
  test('Validate entered from Review runs the Checks again, and a failure there stays in Validate for diagnosis without a send-back to Work', async () => {
    await commitToOrigin(scratch, {
      '.gitignore': 'stub-*\n',
      '.ted/workflow.yaml': [
        'version: 1',
        'order: [intake, work, validate, review]',
        'stages:',
        '  validate:',
        '    max_back: 0',
        '    checks:',
        '      - { name: Typecheck, run: "echo typed" }',
        '      - { name: Tests, run: "n=$(cat stub-runs 2>/dev/null || echo 0); n=$((n+1)); echo $n > stub-runs; if [ $n -eq 2 ]; then seq 1 300; echo token ghp_abcdefghijklmnopqrstuvwxyz0123; exit 1; fi" }',
        '      - { name: Lint, run: "echo linted" }',
        '',
      ].join('\n'),
    })
    const findings = path.join(scratch, 'findings.md')
    await writeFile(findings, 'Check it again.\n')
    const client = await startTed()
    const script = [
      counter,
      'case $n in',
      '1) ted outcome advance;;',
      '2) echo x > work.txt; ted outcome advance;;',
      '3) ted outcome advance;;',
      `4) ted outcome back --to validate --findings "${findings}";;`,
      'esac',
    ].join(' ')
    const run = { run: ['sh', '-c', script] }
    const task = await startTask(
      client,
      steps({ everyMessage: [run, { endTurn: true }] }, run, { endTurn: true }),
    )

    const [first, second] = await finishedRuns(client, task, 2)
    expect([first, second].map((r) => [r?.trigger, r?.stage, r?.outcome])).toEqual([
      ['hand-off', 'work', 'passed'],
      ['validate', 'validate', 'failed'],
    ])
    expect(states(second)).toEqual([
      ['Typecheck', 'passed'],
      ['Tests', 'failed'],
      ['Lint', 'not-run'],
    ])
    const failure = await waitUntil(
      async () => (await client.ok<FailureCase[]>('GET', `/tasks/${task.id}/failures`))[0],
      'failure evidence',
    )
    expect(failure.evidence).toContain('\n102\n')
    expect(failure.evidence).not.toContain('\n101\n')
    expect(failure.evidence).toContain('[redacted]')
    expect(failure.evidence).not.toContain('ghp_abcdefghij')
    expect(failure.evidence).toMatch(/Full output: .*checks.*2\.log/)
    await waitUntil(
      async () =>
        (await leadMessages(client, task)).some(
          (m) => m.includes('# A Check failed') && m.includes(shortReference(failure.id)),
        ),
      'diagnosis instructions',
    )
    expect((await getTask(client, task.id))?.stage).toBe('validate')
    expect(
      (await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)).map((b) => [
        b.from,
        b.to,
      ]),
    ).toEqual([['review', 'validate']])
    expect(await client.ok('GET', '/inbox')).toEqual([])
    const output = await client.ok<{ text: string }>(
      'GET',
      `/check-runs/${second?.id}/checks/1/output`,
    )
    expect(output.text.split('\n')[0]).toBe('1')
    expect(output.text).not.toContain('ghp_abcdefghij')
  }, 120_000)

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
    const failed = await waitUntil(
      async () => (await leadMessages(client, task)).find((m) => m.startsWith('# A Check failed')),
      'the failure to reach the Task Lead',
    )
    expect(failed).toContain('timed out after 1s')
    expect(await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)).toEqual([])
    expect((await getTask(client, task.id))?.stage).toBe('work')
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
    await expect
      .poll(async () => {
        const slots = await client.ok<{ holders: { taskId: string }[] }>('GET', '/slots')
        return slots.holders.some((h) => h.taskId === task.id)
      })
      .toBe(false)
    expect(await client.ok<{ checksRunning: number }>('GET', '/activity')).toMatchObject({
      checksRunning: 1,
    })
    expect(await client.ok('GET', '/update/work')).toEqual({ checks: 1, merges: 0 })

    await writeFile(go, '')
    await finishedRuns(client, task, 1)
    await expect.poll(() => client.ok('GET', '/update/work')).toEqual({ checks: 0, merges: 0 })
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

describe('Checks across restarts', () => {
  test('Resume is refused while interrupted hand-off Checks are being prepared again', async () => {
    await workflow(
      '      - { name: Tests, run: "echo run >> stub-count; while [ ! -e stub-go ]; do sleep 0.05; done" }',
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
    const count = await worktreeFile(client, task, 'stub-count')
    const go = path.join(path.dirname(count), 'stub-go')
    await waitUntil(
      () =>
        readFile(count, 'utf8').then(
          (text) => text === 'run\n',
          () => false,
        ),
      'the original Check to start',
    )
    const lead = (await getTask(client, task.id))?.leadRunId
    await client.ok('POST', '/shutdown', {})
    await daemon?.stop()

    const preparing = path.join(scratch, 'preparing')
    const release = path.join(scratch, 'release')
    const program = path.join(scratch, 'sandbox-prepare')
    await writeFile(
      program,
      `#!/bin/sh\necho waiting > '${preparing}'\nwhile [ ! -e '${release}' ]; do sleep 0.01; done\nexec ${process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : 'bwrap'} "$@"\n`,
      { mode: 0o755 },
    )
    const previous = process.env.TED_SANDBOX_BIN
    process.env.TED_SANDBOX_BIN = program
    try {
      client = await startTed()
      await waitUntil(
        () =>
          readFile(preparing, 'utf8').then(
            () => true,
            () => false,
          ),
        'the restarted Check preparation to wait',
      )
      expect(await checkRuns(client, task)).toMatchObject([{ outcome: 'interrupted' }])
      const during = await getTask(client, task.id)
      expect((await client.call('POST', `/tasks/${task.id}/resume`, {})).status).toBe(409)
      expect(during).not.toHaveProperty('canResume', true)
      expect(during?.leadRunId).toBe(lead)
      expect(during?.status?.kind).toBe('working')
      expect((await client.ok<Activity>('GET', '/activity')).checksRunning).toBe(1)
      await writeFile(release, '')
      await waitUntil(
        async () => (await checkRuns(client, task)).length === 2,
        'the replacement Check',
      )
      expect(await getTask(client, task.id)).not.toHaveProperty('canResume', true)
      expect((await client.ok<Activity>('GET', '/activity')).checksRunning).toBe(1)
      await writeFile(go, '')
      await finishedRuns(client, task, 2)
      await waitUntil(
        async () => (await getTask(client, task.id))?.canResume,
        'Resume after Checks finish',
      )
      expect((await client.ok<Activity>('GET', '/activity')).checksRunning).toBe(0)
    } finally {
      if (previous === undefined) delete process.env.TED_SANDBOX_BIN
      else process.env.TED_SANDBOX_BIN = previous
      await writeFile(release, '')
      await writeFile(go, '')
    }
  }, 60_000)

  test('Checks cut short by a daemon restart run again from the start', async () => {
    const go = path.join(scratch, 'go')
    await workflow(
      `      - { name: Tests, run: "echo run >> stub-count; while [ ! -e '${go}' ]; do sleep 0.05; done" }`,
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
    const count = await worktreeFile(client, task, 'stub-count')
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

describe('Checks before a stopped Task leaves Work', () => {
  test('a Task stopped while its Checks run stays in Work when they pass, and a restart doesn’t run them again', async () => {
    const go = path.join(scratch, 'go')
    await workflow(
      `      - { name: Tests, run: "echo run >> stub-count; while [ ! -e '${go}' ]; do sleep 0.05; done" }`,
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
    const count = await worktreeFile(client, task, 'stub-count')
    const started = (times: number) =>
      waitUntil(
        () =>
          readFile(count, 'utf8').then(
            (t) => t === 'run\n'.repeat(times) || undefined,
            () => undefined,
          ),
        `Check run ${times} to start`,
        40_000,
      )
    await started(1)

    await client.ok('POST', `/tasks/${task.id}/stop`, {})
    await writeFile(go, '')
    expect((await finishedRuns(client, task, 1)).map((r) => r.outcome)).toEqual(['passed'])
    await rm(go)
    await client.ok('POST', `/tasks/${task.id}/resume`, {})
    await started(2)
    const resumed = await getTask(client, task.id)
    expect(resumed?.stage).toBe('work')
    expect(await leadMessages(client, task)).toEqual(
      expect.arrayContaining([expect.stringContaining('# TED didn’t use the Checks’ result')]),
    )

    await client.ok('POST', `/tasks/${task.id}/stop`, {})
    await daemon?.stop()
    client = await startTed()
    await waitUntil(
      async () => (await checkRuns(client, task)).at(-1)?.outcome === 'interrupted' || undefined,
      'the interrupted Check run',
    )
    await sleep(1_500)
    expect((await checkRuns(client, task)).map((r) => r.outcome)).toEqual(['passed', 'interrupted'])
    expect(await readFile(count, 'utf8')).toBe('run\nrun\n')
    const stopped = await getTask(client, task.id)
    expect(stopped?.stage).toBe('work')
    expect(stopped?.status?.kind).toBe('stopped')
    expect((await client.ok<Activity>('GET', '/activity')).checksRunning).toBe(0)
  }, 120_000)
})

describe('the Checks’ environment', () => {
  test('Checks get worktree.env, CI=1 and TED_TASK, and none of the daemon’s TED_ names or agent credentials', async () => {
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
    let seen = ''
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
          '      - { name: Env, run: env }',
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
      const [run] = await finishedRuns(client, task, 1)
      seen = (await client.ok<{ text: string }>('GET', `/check-runs/${run?.id}/checks/0/output`))
        .text
    } finally {
      for (const name of Object.keys(planted)) {
        if (before[name] === undefined) delete process.env[name]
        else process.env[name] = before[name]
      }
    }
    const env = Object.fromEntries(
      seen
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

  test('Checks run in the login shell and environment TED read at start, not the daemon’s own, and a fresh read doesn’t make their coverage stale', async () => {
    const loginBin = path.join(scratch, 'login-bin')
    await mkdir(loginBin)
    await writeFile(path.join(loginBin, 'login-tool'), '#!/bin/sh\nprintf %s "$1"\n')
    await chmod(path.join(loginBin, 'login-tool'), 0o755)
    const shell = path.join(scratch, 'fake-login-shell')
    await writeFile(
      shell,
      [
        '#!/bin/sh',
        'if [ "$1" = "-lc" ]; then echo login-shell; exec /bin/sh -c "$2"; fi',
        `PATH='${loginBin}':"$PATH"`,
        'SHELL_SESSION=$$',
        'export PATH SHELL_SESSION',
        'exec /bin/sh -c "$4"',
        '',
      ].join('\n'),
    )
    await chmod(shell, 0o755)
    await workflow('      - { name: Tool, run: "login-tool ran" }')
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
    const output = await ok<{ text: string }>('GET', `/check-runs/${run?.id}/checks/0/output`)
    expect(output.text).toBe('login-shell\nran')
    const covered = async () =>
      (await ok<{ satisfied: boolean }>('GET', `/tasks/${task.id}/validation-obligations`))
        .satisfied
    await expect.poll(covered).toBe(true)
    await ok('POST', '/integrations/check')
    expect(await covered()).toBe(true)
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

describe('the Checks’ sandbox', () => {
  const escapeCheck = (targets: string[]) =>
    `      - { name: Escape, run: "${targets.map((t) => `touch '${t}' 2>/dev/null`).join('; ')}; touch stub-inside; echo done" }`

  test.runIf(process.platform === 'darwin')(
    'a Check an agent starts writes its worktree, but can’t write TED_HOME or the home folder or read daemon.json',
    async () => {
      const homeFile = path.join(homedir(), `.ted-check-escape-${randomUUID()}`)
      const targets = [path.join(home, 'planted'), homeFile, path.join(scratch, 'out')]
      try {
        await workflow(
          [
            escapeCheck(targets),
            `      - { name: Peek, run: "cat '${path.join(home, 'daemon.json')}' >/dev/null 2>&1 && echo leaked || echo hidden" }`,
          ].join('\n'),
        )
        const client = await startTed()
        const task = await startTask(
          client,
          steps(
            { run: ['sh', '-c', 'echo x > a.txt'] },
            { run: ['ted', 'checks'] },
            { endTurn: true },
          ),
        )
        const [run] = await finishedRuns(client, task, 1)
        expect(run?.trigger).toBe('agent')
        expect(states(run)).toEqual([
          ['Escape', 'passed'],
          ['Peek', 'passed'],
        ])
        const peek = await client.ok<{ text: string }>(
          'GET',
          `/check-runs/${run?.id}/checks/1/output`,
        )
        expect(peek.text.trim()).toBe('hidden')
        expect(await readFile(await worktreeFile(client, task, 'stub-inside'), 'utf8')).toBe('')
        for (const file of targets) await expect(readFile(file), file).rejects.toThrow()
      } finally {
        await rm(homeFile, { force: true })
      }
    },
  )

  test.runIf(process.platform === 'darwin')(
    'the Checks TED runs before Validate are sandboxed too, since they run the code the agent wrote',
    async () => {
      await workflow(escapeCheck([path.join(home, 'planted')]))
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
      expect(run?.trigger).toBe('hand-off')
      expect(states(run)).toEqual([['Escape', 'passed']])
      await expect(readFile(path.join(home, 'planted'))).rejects.toThrow()
    },
  )

  test.each([false, true])(
    'repo Bypass only removes the Checks’ sandbox with local consent: %s',
    async (consent) => {
      await commitToOrigin(scratch, {
        '.gitignore': 'stub-*\n',
        '.ted/workflow.yaml': [
          'version: 1',
          'permissions: bypass',
          'order: [intake, work, validate]',
          'stages:',
          '  validate:',
          '    checks:',
          escapeCheck([path.join(scratch, 'out')]),
          '',
        ].join('\n'),
      })
      const client = await startTed()
      const task = await startTask(
        client,
        steps(
          { run: ['sh', '-c', 'echo x > a.txt'] },
          { run: ['ted', 'checks'] },
          { endTurn: true },
        ),
        consent,
      )
      const [run] = await finishedRuns(client, task, 1)
      expect(states(run)).toEqual([['Escape', 'passed']])
      if (consent) expect(await readFile(path.join(scratch, 'out'), 'utf8')).toBe('')
      else await expect(readFile(path.join(scratch, 'out'))).rejects.toThrow()
    },
  )

  test.runIf(process.platform === 'darwin')(
    'revoking Bypass while a Check runs sandboxes the next Check in the batch',
    async () => {
      await workflow(
        [
          '      - { name: Hold, run: "touch stub-check-started; while [ ! -f stub-release ]; do sleep 0.02; done" }',
          escapeCheck([path.join(scratch, 'out')]),
        ].join('\n'),
      )
      const client = await startTed()
      const task = await startTask(
        client,
        steps(
          { run: ['sh', '-c', 'echo x > a.txt'] },
          { run: ['ted', 'checks'] },
          { endTurn: true },
        ),
        true,
      )
      const started = await worktreeFile(client, task, 'stub-check-started')
      await waitUntil(
        () =>
          readFile(started)
            .then(() => true)
            .catch(() => false),
        'first Check',
      )
      await client.ok('PUT', `/factories/${task.factoryId}/permissions`, { mode: 'auto' })
      await writeFile(await worktreeFile(client, task, 'stub-release'), '')
      const [run] = await finishedRuns(client, task, 1)
      expect(states(run)).toEqual([
        ['Hold', 'passed'],
        ['Escape', 'passed'],
      ])
      await expect(readFile(path.join(scratch, 'out'))).rejects.toThrow()
    },
  )

  test('without a working sandbox, ted checks is refused and a banner says why', async () => {
    await workflow('      - { name: Typecheck, run: "echo typed" }')
    const before = process.env.TED_SANDBOX_BIN
    process.env.TED_SANDBOX_BIN = path.join(scratch, 'no-such-sandbox')
    try {
      const client = await startTed()
      const task = await startTask(
        client,
        steps(
          { run: ['sh', '-c', 'echo x > a.txt'] },
          { run: ['ted', 'checks'] },
          { endTurn: true },
        ),
      )
      const current = await waitUntil(async () => {
        const t = await getTask(client, task.id)
        return t?.leadRunId ? t : undefined
      }, 'the Task Lead')
      const results = await waitUntil(async () => {
        const texts = assistantTexts((await client.getRun(current.leadRunId ?? '')).conversation)
          .filter((t) => t.startsWith('{'))
          .map((t) => JSON.parse(t) as { code: number; stderr: string })
        return texts.length >= 2 ? texts : undefined
      }, 'the ted checks result')
      expect(results[1]?.code).not.toBe(0)
      expect(results[1]?.stderr).toContain('can’t sandbox Checks and Apps')
      expect(await checkRuns(client, task)).toEqual([])
      const banners = await client.ok<Banner[]>('GET', '/banners')
      expect(banners.find((b) => b.problem === 'sandbox-unavailable')).toMatchObject({
        severity: 'stops-work',
      })
    } finally {
      if (before === undefined) delete process.env.TED_SANDBOX_BIN
      else process.env.TED_SANDBOX_BIN = before
    }
  })
})
