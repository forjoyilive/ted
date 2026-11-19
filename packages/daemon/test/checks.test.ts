import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, homedir, tmpdir } from 'node:os'
import path from 'node:path'
import type {
  Activity,
  Banner,
  CheckRun,
  Comment,
  Factory,
  FailureCase,
  RunSummary,
  SendBack,
  Task,
  ThreadEvent,
} from '@ted/protocol'
import { defaultMachineSettings, tedPaths } from '@ted/protocol'
import { shortReference } from '@ted/protocol/reference'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { openStore } from '../src/store/index.ts'
import { checkCpus } from '../src/tasks/check-slots.ts'
import {
  api,
  assistantTexts,
  commitToOrigin,
  hostsStarted,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  stubCodexPath,
  waitUntil,
} from './helpers.ts'
import { skipInsideTedSandbox } from './support/ted-sandbox.ts'

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

async function startTed(load?: Parameters<typeof startDaemon>[0]['load']) {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    codexBin: stubCodexPath,
    ...(load && { load }),
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

async function stopTed() {
  await daemon?.stop()
  daemon = undefined
}

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

describe('Checks at Validate entry', () => {
  test('a failed Check at Validate entry returns the Task to Work counted, with its output and no Validate instructions, and Ted merges the latest main into the branch on the way, so a fix already on main passes; the passing run is the one Validate uses', async () => {
    await workflow(
      [
        '      - { name: Typecheck, run: "echo typed" }',
        '      - { name: Tests, run: "if [ -e fix.txt ]; then echo ok; else while [ ! -e stub-moved ]; do sleep 0.1; done; seq 1 300; echo token ghp_abcdefghijklmnopqrstuvwxyz0123; exit 1; fi" }',
        '      - { name: Lint, run: "echo linted" }',
      ].join('\n'),
    )
    const client = await startTed()
    const work =
      'echo x > work.txt; git add work.txt; git -c user.name=T -c user.email=t@example.com commit -qm work || true'
    const task = await startTask(
      client,
      steps({ everyMessage: [{ run: ['sh', '-c', work] }, advance] }, advance),
    )
    await waitUntil(
      async () => ((await checkRuns(client, task)).length > 0 ? true : undefined),
      'the first Check run to start',
      60_000,
    )
    await commitToOrigin(scratch, { 'fix.txt': 'fixed\n' })
    await writeFile(await worktreeFile(client, task, 'stub-moved'), '')

    await waitUntil(
      async () => {
        const stage = (await getTask(client, task.id))?.stage
        return stage === 'merge' || stage === 'done' || undefined
      },
      'the Task to pass Validate',
      60_000,
    )
    const [first, second, ...more] = await checkRuns(client, task)
    expect(more).toEqual([])
    expect(first?.trigger).toBe('validate')
    expect(first?.stage).toBe('validate')
    expect(states(first)).toEqual([
      ['Typecheck', 'passed'],
      ['Tests', 'failed'],
      ['Lint', 'not-run'],
    ])
    expect(first?.outcome).toBe('failed')
    expect(second?.trigger).toBe('validate')
    expect(states(second)).toEqual([
      ['Typecheck', 'passed'],
      ['Tests', 'passed'],
      ['Lint', 'passed'],
    ])
    expect(await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)).toMatchObject([
      {
        from: 'validate',
        to: 'work',
        counted: true,
        round: 1,
        cause: 'check',
        checkRunId: first?.id,
      },
    ])
    const [failure] = await client.ok<FailureCase[]>('GET', `/tasks/${task.id}/failures`)
    expect(failure?.source).toMatchObject({ kind: 'factory-check', checkRunId: first?.id })

    const messages = await leadMessages(client, task)
    const back = messages.findIndex((m) => m.includes('# Send-back 1 of 5 from Validate'))
    const failed = messages[back] ?? ''
    expect(failed).toContain(`failure case ${shortReference(failure?.id ?? '')}`)
    expect(failed).toContain('\n102\n')
    expect(failed).not.toContain('\n101\n')
    expect(failed).toContain('[redacted]')
    expect(failed).not.toContain('ghp_abcdefghij')
    expect(failed).toMatch(/Full output: .*checks.*2\.log/)
    expect(failed).toContain(
      'Ted merged the latest main into this Task’s branch on the way back to Work.',
    )
    expect(messages.some((m) => m.startsWith('# A check failed'))).toBe(false)
    const validate = messages.flatMap((m, i) => (m.includes('None failed') ? [i] : []))
    expect(validate).toHaveLength(1)
    expect(validate[0]).toBeGreaterThan(back)
    const passed = messages[validate[0] ?? -1] ?? ''
    expect(passed).toContain('✓ Typecheck\n✓ Tests\n✓ Lint')
    expect(passed).toContain('Ted moved this Task to Validate')

    const events = await threadEvents(client, task)
    expect(events.find((e) => e.validate === 'passed')?.checkRunId).toBe(second?.id)
    expect(events.map((e) => e.text)).toContain(
      'Validate sent this back to Work (round 1 of 5) · a check failed',
    )
    expect(
      events.filter((e) => e.text.startsWith('Ted merged the latest main into ')),
    ).toHaveLength(1)

    const output = await client.ok<{ text: string }>(
      'GET',
      `/check-runs/${first?.id}/checks/1/output`,
    )
    expect(output.text.split('\n')[0]).toBe('1')
    expect(output.text).not.toContain('ghp_abcdefghij')
  }, 90_000)

  test('Check returns count toward Validate’s limit; at the limit Ted asks Keep going or Stop the Task, and each does what it says', async () => {
    await commitToOrigin(scratch, {
      '.gitignore': 'stub-*\n',
      '.ted/workflow.yaml': [
        'version: 1',
        'order: [intake, work, validate]',
        'stages:',
        '  validate:',
        '    max_back: 1',
        '    loop_check: false',
        '    checks:',
        '      - { name: Tests, run: "echo nope; exit 1" }',
        '',
      ].join('\n'),
    })
    const client = await startTed()
    const task = await startTask(
      client,
      steps(
        { everyMessage: [advance, { endTurn: true }] },
        { run: ['sh', '-c', 'echo x > a.txt'] },
        advance,
        { endTurn: true },
      ),
    )
    const open = () =>
      waitUntil(
        async () =>
          (await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)).find(
            (c) => c.kind === 'question' && c.answer === undefined,
          ),
        'the limit question',
        60_000,
      )
    const question = await open()
    expect(question).toMatchObject({
      author: { kind: 'ted' },
      title: 'Validate sent this Task back to Work 1 time, its limit',
      choices: ['Keep going', 'Stop the Task'],
      purpose: { kind: 'send-back' },
    })
    expect(question.body).toContain(
      'Validate has sent the Task back to Work 1 time: 1 for a failed check. Its limit is 1.',
    )
    expect(question.body).toContain(
      '**Stop the Task** sends the Task back to Work with these findings and stops it',
    )
    expect(await getTask(client, task.id)).toMatchObject({
      stage: 'validate',
      backToWork: { count: 1, limit: 1 },
    })
    expect((await finishedRuns(client, task, 2)).map((r) => [r.trigger, r.outcome])).toEqual([
      ['validate', 'failed'],
      ['validate', 'failed'],
    ])
    expect(await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)).toMatchObject([
      { counted: true, round: 1, cause: 'check' },
    ])
    expect((await leadMessages(client, task)).some((m) => m.includes('None failed'))).toBe(false)

    await client.ok('POST', `/comments/${question.id}/answer`, {
      action: 'answer',
      choice: 'Keep going',
    })
    const again = await open()
    expect(again.id).not.toBe(question.id)
    expect(
      (await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)).map((b) => b.round),
    ).toEqual([1, 1])
    expect(await finishedRuns(client, task, 3)).toHaveLength(3)

    await client.ok('POST', `/comments/${again.id}/answer`, {
      action: 'answer',
      choice: 'Stop the Task',
    })
    const stopped = await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current?.status?.kind === 'stopped' && current.stage === 'work' ? current : undefined
    }, 'the Task to stop in Work')
    expect(stopped).toMatchObject({ stage: 'work', backToWork: { count: 1, limit: 1 } })
    expect(
      (await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)).map((b) => b.round),
    ).toEqual([1, 1, 1])
  }, 180_000)
})

const yamlText = (text: string) => `'${text.replaceAll("'", "''")}'`

const instructionCheck = (name: string, agentSteps: string, extra: string[] = []) =>
  [
    `      - name: ${name}`,
    `        instruction: ${yamlText(agentSteps)}`,
    '        agent: claude',
    ...extra.map((line) => `        ${line}`),
  ].join('\n')

const commit = (file: string, message: string) => [
  'sh',
  '-c',
  `echo x > ${file} && git add ${file} && (git -c user.name=Stub -c user.email=stub@example.com commit -qm '${message}' || true)`,
]

const committingLead = () =>
  steps({ everyMessage: [{ run: commit('work.txt', 'Work') }, advance] }, advance)

const passedValidate = (client: Client, task: Task) =>
  waitUntil(
    async () => {
      const stage = (await getTask(client, task.id))?.stage
      return stage === 'merge' || stage === 'done' || undefined
    },
    'the Task to pass Validate',
    90_000,
  )

describe('Instruction Checks at Validate', () => {
  test('a fixing instruction Check runs before the commands and commits its fix; the commands run once on the fixed code, a fix under .ted/ adds the Ted settings Check to the same Check run, the report-only one runs after them, and the report lists the commit', async () => {
    await workflow(
      [
        '      - { name: Tests, run: "test -e .ted/notes.md && echo ok" }',
        instructionCheck(
          'Review',
          steps({ say: 'Nothing wrong.\nResult: pass' }, { endTurn: true }),
        ),
        instructionCheck(
          'Docs drift',
          steps(
            { run: commit('.ted/notes.md', 'Fix the docs') },
            { say: 'Fixed the docs.\nResult: pass' },
            { endTurn: true },
          ),
          ['fix: true'],
        ),
      ].join('\n'),
    )
    const client = await startTed()
    const task = await startTask(client, committingLead())
    await passedValidate(client, task)

    const [run, ...more] = await checkRuns(client, task)
    expect(more).toEqual([])
    expect(states(run)).toEqual([
      ['Docs drift', 'passed'],
      ['Tests', 'passed'],
      ['Ted settings', 'passed'],
      ['Review', 'passed'],
    ])
    expect(run?.checks[2]).toMatchObject({ builtIn: 'ted-settings' })
    expect(run?.checks[0]).toMatchObject({ fix: true, agent: 'claude' })
    expect(run?.checks[0]?.instruction).toContain('Fix the docs')
    expect(run?.checks[0]?.command).toBeUndefined()
    const report = await client.ok<{ text: string }>(
      'GET',
      `/check-runs/${run?.id}/checks/0/output`,
    )
    expect(report.text).toMatch(/^The agent committed:\n- widgets: [0-9a-f]+ Fix the docs\n/)
    expect(report.text).toContain('Fixed the docs.\nResult: pass')
    const messages = await leadMessages(client, task)
    expect(
      messages.some((m) =>
        m.includes('✓ Docs drift (instruction)\n✓ Tests\n✓ Ted settings\n✓ Review (instruction)'),
      ),
    ).toBe(true)
  }, 120_000)

  test('a passed instruction Check isn’t rerun while the Task’s changes stay the same, and a failed command still returns the Task to Work', async () => {
    const flag = 'stub-failed-once'
    await workflow(
      [
        `      - { name: Tests, run: "if [ -e '${flag}' ]; then echo ok; else touch '${flag}'; exit 1; fi" }`,
        instructionCheck(
          'Docs drift',
          steps({ say: 'The docs are current.\nResult: pass' }, { endTurn: true }),
          ['fix: true'],
        ),
      ].join('\n'),
    )
    const client = await startTed()
    const task = await startTask(client, committingLead())
    await passedValidate(client, task)

    const [first, second, ...more] = await checkRuns(client, task)
    expect(more).toEqual([])
    expect(states(first)).toEqual([
      ['Docs drift', 'passed'],
      ['Tests', 'failed'],
    ])
    expect(first?.checks[0]?.notRerun).toBeUndefined()
    expect(states(second)).toEqual([
      ['Docs drift', 'passed'],
      ['Tests', 'passed'],
    ])
    expect(second?.checks[0]?.notRerun).toBe(true)
    const started = (await threadEvents(client, task)).filter((e) =>
      e.text.startsWith('Sub-agent “Check · Docs drift” started'),
    )
    expect(started).toHaveLength(1)
    expect(await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)).toMatchObject([
      { cause: 'check', checkRunId: first?.id },
    ])
  }, 120_000)

  test('a report-only instruction Check that changes files fails, and its report is the Findings the Task returns to Work with', async () => {
    await workflow(
      instructionCheck(
        'Stray',
        steps(
          { run: ['sh', '-c', 'echo y > stray.txt'] },
          { say: 'I looked.\nResult: pass' },
          { endTurn: true },
        ),
      ),
    )
    const client = await startTed()
    const task = await startTask(client, committingLead())
    await passedValidate(client, task)

    const [first, second, ...more] = await checkRuns(client, task)
    expect(more).toEqual([])
    expect(states(first)).toEqual([['Stray', 'failed']])
    expect(states(second)).toEqual([['Stray', 'passed']])
    expect(await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)).toMatchObject([
      { cause: 'check', counted: true, checkRunId: first?.id },
    ])
    const [failure] = await client.ok<FailureCase[]>('GET', `/tasks/${task.id}/failures`)
    expect(failure?.source).toMatchObject({ kind: 'factory-check', checkRunId: first?.id })
    const back = (await leadMessages(client, task)).find((m) =>
      m.includes('# Send-back 1 of 5 from Validate'),
    )
    expect(back).toContain('The instruction check “Stray” failed.')
    expect(back).toContain('The agent changed files.')
    expect(back).toContain('I looked.\nResult: pass')
  }, 120_000)

  test('an instruction Check with no report asks the user, and the question and the waiting Check survive a restart, which asks again when the question is gone: Try again starts a new agent, Count it as failed is a failed Check; Run now runs one on a chosen Task without a failure case', async () => {
    await workflow(
      instructionCheck('Silent', steps({ say: 'I looked around.' }, { endTurn: true })),
    )
    let client = await startTed()
    const task = await startTask(client, committingLead())
    const question = (n: number) =>
      waitUntil(
        async () => {
          const asked = (await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)).filter(
            (c) => c.purpose?.kind === 'check-report',
          )
          return asked.length >= n && asked[n - 1]?.answer === undefined ? asked[n - 1] : undefined
        },
        `no-report question ${n}`,
        60_000,
      )

    const first = await question(1)
    expect(first).toMatchObject({
      author: { kind: 'ted' },
      title: 'An instruction check didn’t report: Silent',
      choices: ['Try again', 'Count it as failed'],
    })
    expect(first?.body).toContain(
      'The instruction check “Silent” has no report: it ended without a result line.',
    )
    expect((await getTask(client, task.id))?.stage).toBe('validate')

    expect(
      await client.ok<{ id: string }[]>('GET', `/factories/${task.factoryId}/checks/try/tasks`),
    ).toMatchObject([{ id: task.id, displayId: task.displayId }])
    await client.ok('POST', `/factories/${task.factoryId}/checks/try`, {
      name: 'Quick look',
      instruction: steps({ say: 'Fine.\nResult: pass' }, { endTurn: true }),
      agent: 'claude',
      taskId: task.id,
    })
    const tried = await waitUntil(
      async () =>
        (
          await client.ok<{ tries: { name: string; state: string }[] }>(
            'GET',
            `/factories/${task.factoryId}/settings`,
          )
        ).tries.find((t) => t.name === 'Quick look' && t.state !== 'running'),
      'the Run now try to finish',
      60_000,
    )
    expect(tried).toMatchObject({
      state: 'passed',
      instruction: true,
      taskId: task.id,
      taskDisplayId: task.displayId,
    })
    const output = await client.ok<{ text: string }>(
      'GET',
      `/factories/${task.factoryId}/checks/try/output?name=Quick%20look`,
    )
    expect(output.text).toContain('Fine.\nResult: pass')
    expect(await client.ok<FailureCase[]>('GET', `/tasks/${task.id}/failures`)).toEqual([])

    const agentsStarted = async () =>
      (await threadEvents(client, task)).filter((e) =>
        e.text.startsWith('Sub-agent “Check · Silent” started'),
      ).length
    expect(await agentsStarted()).toBe(1)
    expect(
      (await threadEvents(client, task)).filter((e) => e.text.includes('Check · Quick look')),
    ).toEqual([])
    await hostsStarted(home)
    await stopTed()
    client = await startTed()
    const [waiting, ...rerun] = await checkRuns(client, task)
    expect(rerun).toEqual([])
    expect(waiting?.finishedAt).toBeUndefined()
    expect(
      (await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)).find(
        (c) => c.id === first?.id,
      )?.answer,
    ).toBeUndefined()
    expect(await agentsStarted()).toBe(1)
    expect((await getTask(client, task.id))?.stage).toBe('validate')

    await stopTed()
    const stopped = await openStore({ directory: tedPaths(home).store })
    stopped.answerComment(first?.id ?? '', {
      kind: 'withdrawn',
      at: new Date().toISOString(),
      cancelled: true,
    })
    await stopped.persisted()
    await stopped.close()
    client = await startTed()
    const asked = await question(2)
    expect(asked).toMatchObject({
      title: first?.title,
      body: first?.body,
      choices: ['Try again', 'Count it as failed'],
    })
    expect((await checkRuns(client, task)).map((r) => [r.id, r.finishedAt])).toEqual([
      [waiting?.id, undefined],
    ])
    expect(await agentsStarted()).toBe(1)
    expect((await getTask(client, task.id))?.stage).toBe('validate')

    await client.ok('POST', `/comments/${asked?.id}/answer`, {
      action: 'answer',
      choice: 'Try again',
    })
    const second = await question(3)
    expect(await agentsStarted()).toBe(2)
    expect((await checkRuns(client, task)).map((r) => [r.id === waiting?.id, r.outcome])).toEqual([
      [true, 'interrupted'],
      [false, undefined],
    ])
    await client.ok('POST', `/comments/${second?.id}/answer`, {
      action: 'answer',
      choice: 'Count it as failed',
    })
    const [, failed] = await finishedRuns(client, task, 2)
    expect(failed?.outcome).toBe('failed')
    expect(failed?.checks[0]).toMatchObject({
      state: 'failed',
      noReport: 'it ended without a result line',
    })
    expect(
      await waitUntil(async () => {
        const backs = await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)
        return backs.length > 0 ? backs : undefined
      }, 'the return to Work'),
    ).toMatchObject([{ cause: 'check', checkRunId: failed?.id }])
  }, 180_000)

  test('an instruction Check whose agent runs past its timeout is stopped and ends as no report, and Count it as failed returns the Task to Work', async () => {
    await workflow(
      instructionCheck('Slow', steps({ waitFor: 'stub-never' }, { endTurn: true }), [
        'timeout: 1s',
      ]),
    )
    const client = await startTed()
    const task = await startTask(client, committingLead())
    const asked = await waitUntil(
      async () =>
        (await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)).find(
          (c) => c.purpose?.kind === 'check-report' && c.answer === undefined,
        ),
      'the no-report question',
      60_000,
    )
    expect(asked).toMatchObject({
      title: 'An instruction check didn’t report: Slow',
      choices: ['Try again', 'Count it as failed'],
    })
    expect(asked.body).toContain('The instruction check “Slow” has no report: timed out after 1s.')
    const agent = await waitUntil(
      async () =>
        (await client.ok<RunSummary[]>('GET', `/tasks/${task.id}/runs`)).find(
          (r) => r.name === 'Check · Slow' && r.state === 'finished',
        ),
      'the timed-out agent to stop',
    )
    expect(agent).toBeDefined()
    const [waiting] = await checkRuns(client, task)
    expect(waiting?.finishedAt).toBeUndefined()

    await client.ok('POST', `/comments/${asked.id}/answer`, {
      action: 'answer',
      choice: 'Count it as failed',
    })
    const [failed] = await finishedRuns(client, task, 1)
    expect(failed?.outcome).toBe('failed')
    expect(failed?.checks[0]).toMatchObject({ state: 'failed', noReport: 'timed out after 1s' })
    const report = await client.ok<{ text: string }>(
      'GET',
      `/check-runs/${failed?.id}/checks/0/output`,
    )
    expect(report.text).toContain('No report: timed out after 1s.')
    expect(
      await waitUntil(async () => {
        const backs = await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)
        return backs.length > 0 ? backs : undefined
      }, 'the return to Work'),
    ).toMatchObject([{ cause: 'check', checkRunId: failed?.id }])
  }, 120_000)
})

describe('Checks killed for lack of memory', () => {
  test('a Check killed while memory is low isn’t a failure and runs again once memory frees up; a second kill asks the user, and Count it as failed is a failed Check that returns the Task to Work', async () => {
    await workflow(
      `      - { name: Tests, run: "n=$(cat stub-n 2>/dev/null || echo 0); n=$((n+1)); echo $n > stub-n; if [ $n -le 2 ]; then while [ ! -e stub-go-$n ]; do sleep 0.05; done; kill -9 $$; fi; echo ok" }`,
    )
    let memory = 0.05
    let reads = 0
    const client = await startTed({
      memoryAvailable: () => {
        reads++
        return memory
      },
      checkEveryMs: 50,
    })
    await client.ok('PATCH', '/settings', { waitWhenBusy: false })
    const task = await startTask(
      client,
      steps({ everyMessage: [{ run: ['sh', '-c', 'echo x > a.txt'] }, advance] }, advance),
    )
    const counter = await worktreeFile(client, task, 'stub-n')
    const started = (n: number) =>
      waitUntil(
        async () => (await readFile(counter, 'utf8').catch(() => '')).trim() === String(n),
        `Check attempt ${n} to start`,
        40_000,
      )
    const killed = (n: number) =>
      waitUntil(async () => {
        const lines = (await threadEvents(client, task)).filter((e) =>
          e.text.includes('ran out of memory, so the check “Tests” was stopped'),
        )
        return lines.length >= n ? lines : undefined
      }, `memory kill ${n} in the thread`)

    await started(1)
    await writeFile(path.join(path.dirname(counter), 'stub-go-1'), '')
    const [line] = await killed(1)
    const [run] = await checkRuns(client, task)
    expect(line?.checkRunId).toBe(run?.id)
    expect(run?.finishedAt).toBeUndefined()
    expect(states(run)).toEqual([['Tests', 'out-of-memory']])
    expect(await client.ok<FailureCase[]>('GET', `/tasks/${task.id}/failures`)).toEqual([])
    expect(await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)).toEqual([])

    memory = 0.5
    await started(2)
    memory = 0.05
    const before = reads
    await waitUntil(async () => reads >= before + 2 || undefined, 'a low memory reading')
    await writeFile(path.join(path.dirname(counter), 'stub-go-2'), '')
    await killed(2)
    const question = await waitUntil(
      async () =>
        (await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)).find(
          (c) => c.kind === 'question' && c.answer === undefined,
        ),
      'the question about the second memory kill',
    )
    expect(question).toMatchObject({
      author: { kind: 'ted' },
      title: 'This computer ran out of memory again: Tests',
      choices: ['Try again', 'Count it as failed'],
      purpose: { kind: 'memory-kill' },
    })
    expect((await checkRuns(client, task)).map((r) => r.finishedAt)).toEqual([undefined])

    await client.ok('POST', `/comments/${question.id}/answer`, {
      action: 'answer',
      choice: 'Count it as failed',
    })
    const [failed, passed] = await finishedRuns(client, task, 2)
    expect(failed).toMatchObject({ trigger: 'validate', outcome: 'failed' })
    expect(states(failed)).toEqual([['Tests', 'failed']])
    expect(passed).toMatchObject({ trigger: 'validate', outcome: 'passed' })
    expect(
      (await leadMessages(client, task)).some((m) =>
        m.includes('# Send-back 1 of 5 from Validate'),
      ),
    ).toBe(true)
    expect(await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)).toMatchObject([
      { cause: 'check', checkRunId: failed?.id },
    ])
  }, 120_000)
})

describe('Checks at Validate', () => {
  test('Validate entered from Review runs the Checks again, and a failure there returns the Task to Work counted', async () => {
    await commitToOrigin(scratch, {
      '.gitignore': 'stub-*\n',
      '.ted/workflow.yaml': [
        'version: 1',
        'order: [intake, work, validate, review]',
        'stages:',
        '  validate:',
        '    max_back: 1',
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
      ['validate', 'validate', 'passed'],
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
    expect(failure.evidence.match(/Full output: /g)).toHaveLength(1)
    await waitUntil(
      async () =>
        (await leadMessages(client, task)).some(
          (m) =>
            m.includes('# Send-back 1 of 1 from Validate') &&
            m.includes(shortReference(failure.id)),
        ),
      'the return to Work',
    )
    expect((await getTask(client, task.id))?.stage).toBe('work')
    expect(
      (await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)).map((b) => [
        b.from,
        b.to,
        b.cause,
      ]),
    ).toEqual([
      ['review', 'validate', undefined],
      ['validate', 'work', 'check'],
    ])
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
      async () =>
        (await leadMessages(client, task)).find((m) =>
          m.includes('# Send-back 1 of 5 from Validate'),
        ),
      'the failure to reach the Task Lead',
    )
    expect(failed).toContain('timed out after 1s')
    expect(await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)).toHaveLength(1)
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
      text: 'A check’s command wasn’t found: `ted-no-such-command-xyz --all`',
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
      return all.some((m) => m.includes('Ted moved this Task to Validate')) || undefined
    }, 'the Validate instructions')
    expect(await checkRuns(client, task)).toEqual([])
    const banners = await client.ok<Banner[]>('GET', '/banners')
    expect(banners.some((b) => b.problem === 'no-checks')).toBe(true)
  })

  test('while Checks run the Task says which Check, without Working or a working slot', async () => {
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
      return current?.activity?.includes('Tests') &&
        current.runs.every((r) => r.state !== 'working')
        ? current
        : undefined
    }, 'the Checks to start and the Task Lead to end its turn')
    expect(running.activity).toBe('Running checks · Tests (2 of 3)')
    expect(running.status).toBeUndefined()
    expect(running.checksActive).toBe(true)
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

  test('a Task whose changes touch .ted/ gets the Ted settings Check', async () => {
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
      ['Ted settings', 'failed'],
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
  test('Resume is refused while interrupted Validate Checks are being prepared again', async () => {
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
    const sandboxProgram =
      process.env.TED_SANDBOX_BIN ??
      (process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : 'bwrap')
    await writeFile(
      program,
      `#!/bin/sh\necho waiting > '${preparing}'\nwhile [ ! -e '${release}' ]; do sleep 0.01; done\nexec '${sandboxProgram}' "$@"\n`,
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
      expect(during?.status).toBeUndefined()
      expect(during?.checksActive).toBe(true)
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

  test('a Validate entry Check run that failed just before a restart is finished at start: Ted records its failure case and returns the Task to Work once', async () => {
    const go = path.join(scratch, 'go')
    await workflow(
      `      - { name: Tests, run: "echo run >> stub-count; while [ ! -e '${go}' ]; do sleep 0.05; done; exit 1" }`,
    )
    let client = await startTed()
    const task = await startTask(
      client,
      steps(
        { everyMessage: [{ endTurn: true }] },
        { run: ['sh', '-c', 'echo x > a.txt'] },
        advance,
        advance,
        { endTurn: true },
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
    const [run] = await checkRuns(client, task)
    await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current?.runs.every((r) => r.state !== 'working') ? current : undefined
    }, 'the Task Lead to end its turn')
    await hostsStarted(home)
    await daemon?.stop()
    daemon = undefined
    const store = await openStore({ directory: tedPaths(home).store })
    store.checkFinished(run?.id ?? '', 0, { state: 'failed', exitCode: 1, durationMs: 10 })
    store.finishChecks(run?.id ?? '', 'failed')
    await store.persisted()
    await store.close()

    client = await startTed()
    const back = await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current?.stage === 'work' && current.checksActive !== true ? current : undefined
    }, 'the Task to return to Work')
    expect(back.backToWork).toEqual({ count: 1, limit: 5 })
    expect(await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)).toMatchObject([
      {
        from: 'validate',
        to: 'work',
        counted: true,
        round: 1,
        cause: 'check',
        checkRunId: run?.id,
      },
    ])
    const failures = await client.ok<FailureCase[]>('GET', `/tasks/${task.id}/failures`)
    expect(failures.map((f) => f.source)).toMatchObject([
      { kind: 'factory-check', checkRunId: run?.id, position: 0 },
    ])
    expect((await checkRuns(client, task)).map((r) => r.outcome)).toEqual(['failed'])
    const told = await waitUntil(
      async () =>
        (await leadMessages(client, task)).find((m) =>
          m.includes('# Send-back 1 of 5 from Validate'),
        ),
      'the Work Task Lead to get the failure',
    )
    expect(told).toContain(`failure case ${shortReference(failures[0]?.id ?? '')}`)
    await writeFile(go, '')
  }, 90_000)
})

describe('Hand-off Checks from before the upgrade', () => {
  test('an unfinished hand-off Check run is marked interrupted at start and not run again, and the Task Lead is told to report again', async () => {
    await workflow('      - { name: Tests, run: "echo run >> stub-count" }')
    let client = await startTed()
    const task = await startTask(
      client,
      steps({ everyMessage: [{ endTurn: true }] }, advance, { endTurn: true }),
    )
    await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current?.stage === 'work' && current.runs.every((r) => r.state !== 'working')
        ? current
        : undefined
    }, 'the Task Lead to wait in Work')
    await hostsStarted(home)
    await daemon?.stop()
    daemon = undefined
    const store = await openStore({ directory: tedPaths(home).store })
    store.startChecks({
      taskId: task.id,
      trigger: 'hand-off',
      stage: 'work',
      checks: [
        { name: 'Tests', command: 'echo run >> stub-count', timeout: '1m', state: 'waiting' },
      ],
    })
    await store.persisted()
    await store.close()

    client = await startTed()
    const told = await waitUntil(
      async () =>
        (await leadMessages(client, task)).find((m) => m.startsWith('# Report the outcome again')),
      'the Task Lead to be told to report again',
    )
    expect(told).toContain('`ted outcome advance`')
    expect((await checkRuns(client, task)).map((r) => [r.trigger, r.outcome])).toEqual([
      ['hand-off', 'interrupted'],
    ])
    const current = await getTask(client, task.id)
    expect(current?.stage).toBe('work')
    expect(current?.checksActive).not.toBe(true)
    await expect(readFile(await worktreeFile(client, task, 'stub-count'))).rejects.toThrow()
  }, 90_000)
})

describe('the Checks’ environment', () => {
  test('Checks get worktree.env, CI=1, TED_TASK and their CPU allowance, and none of the daemon’s TED_ names or agent credentials', async () => {
    const planted = {
      ANTHROPIC_API_KEY: 'anthropic-secret',
      ANTHROPIC_AUTH_TOKEN: 'anthropic-token',
      OPENAI_API_KEY: 'openai-secret',
      CODEX_API_KEY: 'codex-secret',
      TED_APP_WEB_PORT: '5174',
      TED_PRIVATE_THING: 'internal',
      TED_CHECK_CPUS: '99',
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
    expect(env.TED_CHECK_CPUS).toBe(
      String(checkCpus(availableParallelism(), 1, defaultMachineSettings.checkCpuPercent)),
    )
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

  test('Checks run in the login shell and environment Ted read at start, not the daemon’s own, and a fresh read doesn’t make their coverage stale', async () => {
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
  test('outside Work the Checks run; the results go back to the agent and into one Check run', async () => {
    await workflow(
      [
        '      - { name: Typecheck, run: "echo typed" }',
        '      - { name: Tests, run: "echo broken; exit 2" }',
        '      - { name: Lint, run: "echo linted" }',
        '      - { name: Docs drift, instruction: "Check the docs.", fix: true }',
        '      - { name: Review, instruction: "Look again." }',
      ].join('\n'),
    )
    const client = await startTed()
    const task = await startTask(
      client,
      steps(
        { run: ['sh', '-c', 'echo x > a.txt'] },
        { run: ['ted', 'checks'] },
        { run: ['ted', 'checks', '--name', 'Typecheck'] },
        { endTurn: true },
      ),
    )

    const runs = await finishedRuns(client, task, 2)
    expect(runs.map((r) => [r.trigger, r.stage])).toEqual([
      ['agent', 'intake'],
      ['agent', 'intake'],
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
      return texts.length >= 3 ? texts : undefined
    }, 'the ted checks results')
    expect(results[1]?.code).toBe(1)
    expect(results[1]?.stdout).toContain('exit code 2')
    expect(results[1]?.stdout).toContain('broken')
    expect(results[1]?.stdout).toContain('– Lint · not run')
    expect(results[1]?.stdout).toContain(
      'Instruction Checks run at Validate. Ted starts an agent for each one; one that may fix runs before the commands, the others after them:\n\n- Docs drift (may fix)\n  Check the docs.\n\n- Review\n  Look again.',
    )
    expect(results[2]?.code).toBe(0)
    expect(results[2]?.stdout).toContain('✓ Typecheck')
    expect((await getTask(client, task.id))?.stage).toBe('intake')
  })

  test('a Check name the Factory doesn’t have is refused, and Work refuses every ted checks', async () => {
    await workflow('      - { name: Typecheck, run: "echo typed" }')
    const client = await startTed()
    const task = await startTask(
      client,
      steps(
        { everyMessage: [{ endTurn: true }] },
        { run: ['ted', 'checks', '--name', 'Nope'] },
        advance,
        { run: ['ted', 'checks'] },
        { run: ['ted', 'checks', '--name', 'Typecheck'] },
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
      return texts.length >= 4 ? texts : undefined
    }, 'the ted checks results')
    expect(results[0]?.code).not.toBe(0)
    expect(results[0]?.stderr).toContain('no check named “Nope”')
    expect(results[1]?.code).toBe(0)
    for (const refused of [results[2], results[3]]) {
      expect(refused?.code).not.toBe(0)
      expect(refused?.stderr).toContain('`ted checks` doesn’t run in Work')
      expect(refused?.stderr).toContain(`when ${task.displayId} enters Validate`)
    }
    expect((await getTask(client, task.id))?.stage).toBe('work')
    expect(await checkRuns(client, task)).toEqual([])
  })
})

describe('the Checks’ sandbox', () => {
  const escapeCheck = (targets: string[]) =>
    `      - { name: Escape, run: "${targets.map((t) => `touch '${t}' 2>/dev/null`).join('; ')}; touch stub-inside; echo done" }`

  test.runIf(process.platform === 'darwin')(
    'a Check an agent starts writes its worktree, but can’t write TED_HOME or the home folder or read daemon.json',
    async (context) => {
      skipInsideTedSandbox(context)
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
    'the Checks Ted runs before Validate are sandboxed too, since they run the code the agent wrote',
    async (context) => {
      skipInsideTedSandbox(context)
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
      expect(run?.trigger).toBe('validate')
      expect(states(run)).toEqual([['Escape', 'passed']])
      await expect(readFile(path.join(home, 'planted'))).rejects.toThrow()
    },
  )

  test.for([false, true])(
    'repo Bypass only removes the Checks’ sandbox with local consent: %s',
    async (consent, context) => {
      if (!consent) skipInsideTedSandbox(context)
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
    async (context) => {
      skipInsideTedSandbox(context)
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
      expect(results[1]?.stderr).toContain('can’t sandbox checks and Apps')
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
