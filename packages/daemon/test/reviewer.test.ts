import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  Comment,
  Factory,
  RunSummary,
  RunWithConversation,
  Task,
  ThreadEvent,
} from '@ted/protocol'
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
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-reviewer-'))
  origin = await makeOriginRepo(scratch)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

const slow = 60_000

async function start(workflow: string, { codexSignedOut = false } = {}) {
  await commitToOrigin(scratch, { '.ted/workflow.yaml': workflow })
  if (codexSignedOut) {
    await writeFile(path.join(home, 'stub-codex.json'), JSON.stringify({ signedIn: false }))
  }
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
  await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  return { ...client, ok }
}

type Client = Awaited<ReturnType<typeof start>>

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })

async function startTask(client: Client, ...list: unknown[]): Promise<Task> {
  const task = await client.ok<Task>('POST', '/tasks', { title: steps(...list), factory: 'NB' })
  await client.ok('POST', `/tasks/${task.id}/start`)
  return task
}

const getTask = async (client: Client, id: string) => {
  const task = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

const leadConversation = async (client: Client, task: Task): Promise<RunWithConversation> => {
  const { leadRunId } = await getTask(client, task.id)
  if (!leadRunId) throw new Error(`no Task Lead Run for ${task.displayId}`)
  return client.getRun(leadRunId)
}

interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

const commandResults = async (client: Client, task: Task): Promise<CommandResult[]> =>
  assistantTexts((await leadConversation(client, task)).conversation).flatMap((text) => {
    try {
      const parsed = JSON.parse(text) as CommandResult
      return typeof parsed.code === 'number' ? [parsed] : []
    } catch {
      return []
    }
  })

const userMessages = async (client: Client, task: Task) =>
  (await leadConversation(client, task)).conversation.flatMap((e) => {
    const line = JSON.parse(e.line) as { type: string; message?: { content?: unknown } }
    return line.type === 'user' && typeof line.message?.content === 'string'
      ? [line.message.content]
      : []
  })

const threadEvents = (client: Client, task: Task) =>
  client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)

const comments = (client: Client, task: Task) =>
  client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)

const waitForStage = (client: Client, task: Task, stage: string, timeoutMs = 20_000) =>
  waitUntil(
    async () => {
      const t = await getTask(client, task.id)
      return t.stage === stage ? t : undefined
    },
    `${task.displayId} to reach ${stage}`,
    timeoutMs,
  )

const waitForAsk = (client: Client, task: Task) =>
  waitUntil(
    async () =>
      (await comments(client, task)).find(
        (c) => c.kind === 'question' && c.author.kind === 'ted' && c.answer === undefined,
      ),
    'TED to ask the human',
    30_000,
  )

async function promptFile(name: string, ...list: unknown[]) {
  const file = path.join(scratch, name)
  await writeFile(file, `# Review the diff\n\n${steps(...list)}\n`)
  return file
}

const runIdOf = 'grep -o "[0-9a-f-]\\{36\\}" | head -1'
const startAndWait = (args: string) =>
  `out=$(ted run start ${args}) || exit $?; echo "$out" | head -1; ted run wait "$(echo "$out" | ${runIdOf})"`

const validateFlow = 'version: 1\norder: [intake, work, validate, review, merge]\n'

describe('the reviewer', () => {
  test(
    'the default reviewer is the other agent kind; the Validate event names it with the ✓ row’s Review and Visual',
    async () => {
      const client = await start(validateFlow)
      const prompt = await promptFile(
        'review.md',
        { say: 'Two notes, nothing blocking' },
        {
          endTurn: true,
        },
      )
      const task = await startTask(
        client,
        { run: ['ted', 'outcome', 'advance'] },
        { run: ['ted', 'outcome', 'advance'] },
        { run: ['sh', '-c', startAndWait(`--reviewer --prompt-file ${prompt}`)] },
        {
          run: [
            'ted',
            'outcome',
            'advance',
            '--review',
            'pass',
            '--review-notes',
            '2',
            '--visual',
            'pass',
          ],
        },
        { endTurn: true },
      )
      await waitForStage(client, task, 'review')
      const results = await commandResults(client, task)
      expect(results[2]?.code).toBe(0)
      expect(results[2]?.stdout).toMatch(/^Started sub-agent “Reviewer · Validate”/)
      expect(results[2]?.stdout).toContain('Two notes, nothing blocking')

      const runs = await client.ok<RunSummary[]>('GET', `/tasks/${task.id}/runs`)
      expect(runs.find((r) => r.name === 'Reviewer · Validate')).toMatchObject({
        agent: 'codex',
        role: 'sub-agent',
      })
      const passed = (await threadEvents(client, task)).find((e) => e.validate === 'passed')
      expect(passed).toMatchObject({
        text: 'Validate passed · Reviewed by Codex',
        tone: 'done',
        judgments: [
          { name: 'Review', passed: true, notes: 2 },
          { name: 'Visual', passed: true },
        ],
      })
    },
    slow,
  )

  test(
    'an unset reviewer falls back to the Task Lead’s kind when the other can’t run, and says so',
    async () => {
      const client = await start(validateFlow, { codexSignedOut: true })
      const prompt = await promptFile('review.md', { say: 'Fine' }, { endTurn: true })
      const task = await startTask(
        client,
        { run: ['ted', 'outcome', 'advance'] },
        { run: ['ted', 'outcome', 'advance'] },
        { run: ['sh', '-c', startAndWait(`--reviewer --prompt-file ${prompt}`)] },
        { run: ['ted', 'outcome', 'advance'] },
        { endTurn: true },
      )
      await waitForStage(client, task, 'review')
      const runs = await client.ok<RunSummary[]>('GET', `/tasks/${task.id}/runs`)
      expect(runs.find((r) => r.name === 'Reviewer · Validate')?.agent).toBe('claude')
      const passed = (await threadEvents(client, task)).find((e) => e.validate === 'passed')
      expect(passed).toMatchObject({
        text: 'Validate passed · Reviewed by Claude (Codex unavailable)',
        judgments: [{ name: 'Review', passed: true }],
      })
    },
    slow,
  )

  test(
    'an explicit reviewer that can’t run waits for its agent instead of falling back',
    async () => {
      const client = await start(`${validateFlow}reviewer: { agent: codex, effort: high }\n`, {
        codexSignedOut: true,
      })
      const prompt = await promptFile('review.md', { say: 'Fine' }, { endTurn: true })
      const task = await startTask(
        client,
        { run: ['ted', 'outcome', 'advance'] },
        { run: ['ted', 'outcome', 'advance'] },
        { run: ['ted', 'run', 'start', '--reviewer', '--prompt-file', prompt] },
        {
          run: ['ted', 'run', 'start', '--reviewer', '--agent', 'claude', '--prompt-file', prompt],
        },
        { endTurn: true },
      )
      const results = await waitUntil(
        async () => {
          const r = await commandResults(client, task)
          return r.length >= 4 ? r : undefined
        },
        'four commands',
        20_000,
      )
      expect(results[2]?.stdout).toMatch(
        /^Started sub-agent “Reviewer · Validate” \(Run [0-9a-f-]{36}\), queued for a free slot\./,
      )
      expect(results[3]).toMatchObject({ code: 1 })
      expect(results[3]?.stderr).toContain('come from the `reviewer` setting')
      const runs = await client.ok<RunSummary[]>('GET', `/tasks/${task.id}/runs`)
      expect(runs.some((r) => r.name === 'Reviewer · Validate')).toBe(false)
      const slots = await client.ok<{ queue: { kind: string; name?: string }[] }>('GET', '/slots')
      expect(slots.queue).toContainEqual(
        expect.objectContaining({ kind: 'sub-agent', name: 'Reviewer · Validate' }),
      )
    },
    slow,
  )
})

const findingsFor = (verdict: string, firstValidate: number) =>
  steps(
    {
      run: [
        'sh',
        '-c',
        [
          'f="n-$TED_RUN"; n=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$f";',
          `if [ $n -ge ${firstValidate} ] && [ $((n % 2)) -eq ${firstValidate % 2} ];`,
          'then ted outcome back --to work --findings "FINDINGS";',
          'else ted outcome advance; fi',
        ].join(' '),
      ],
    },
    { say: `The same Finding again.\nVerdict: ${verdict}` },
    { endTurn: true },
  )

async function loopTask(client: Client, verdict: string, firstValidate = 3): Promise<Task> {
  const file = path.join(scratch, `findings-${verdict}.md`)
  const findings = findingsFor(verdict, firstValidate).replace('FINDINGS', file)
  await writeFile(file, `- The export button does nothing.\n\n${findings}\n`)
  const script = JSON.parse(findings).steps[0]
  return startTask(client, { everyMessage: [script, { endTurn: true }] }, script, { endTurn: true })
}

describe('the Validate loop check', () => {
  test(
    'the limit gets a fresh assessment after early convergence and still waits for the human',
    async () => {
      const client = await start(
        `${validateFlow}stages:\n  validate: { max_back: 2, loop_check: 1 }\n`,
      )
      const task = await loopTask(client, 'converging')
      const ask = await waitForAsk(client, task)
      const runs = await client.ok<RunSummary[]>('GET', `/tasks/${task.id}/runs`)
      expect(runs.filter((r) => r.name === 'Loop check · Validate')).toHaveLength(2)
      expect(ask.body).toContain('Making progress')
      expect(ask.body).toContain('Recommended: Try again')
      expect(ask.body).toContain('leaves the Findings open')
      expect(ask.body).not.toContain('The export button does nothing.')
      expect(ask.body.length).toBeLessThan(800)
      expect((await getTask(client, task.id)).stage).toBe('validate')
      const history = await threadEvents(client, task)
      expect(history.filter((e) => e.text.startsWith('Validate sent this back'))).toHaveLength(2)
      expect(
        history.find((e) => e.text === 'Validate wants to send this Task back to Work')?.findings,
      ).toContain('The export button does nothing.')

      await daemon?.stop()
      daemon = await startDaemon({
        home,
        version: '9.9.9',
        claudeBin: stubClaudePath,
        codexBin: stubCodexPath,
      })
      const restarted = api(daemon.port, { appKey: daemon.appToken })
      const saved = await restarted.call('GET', `/tasks/${task.id}/comments`)
      expect(saved.status).toBe(200)
      expect(saved.body).toContainEqual(expect.objectContaining({ id: ask.id, body: ask.body }))
      const replayed = await restarted.call('GET', `/tasks/${task.id}/events`)
      expect(replayed.status).toBe(200)
      expect(replayed.body).toEqual(history)
    },
    slow,
  )

  test(
    'a pending limit assessment survives restart and still asks after converging',
    async () => {
      const client = await start(
        `${validateFlow}stages:\n  validate: { max_back: 1, loop_check: 3 }\n`,
      )
      const release = path.join(scratch, 'release-review')
      await writeFile(
        path.join(home, 'stub-codex.json'),
        JSON.stringify({ turnStartWaitFor: release }),
      )
      const task = await loopTask(client, 'converging')
      await waitUntil(
        async () =>
          (await threadEvents(client, task)).some(
            (e) => e.text === 'TED is checking whether Validate’s 2 rounds are converging',
          ),
        'the pending limit assessment',
        20_000,
      )
      expect((await comments(client, task)).some((c) => c.kind === 'question')).toBe(false)
      await waitUntil(
        async () => {
          const runs = await client.ok<RunSummary[]>('GET', `/tasks/${task.id}/runs`)
          const check = runs.find(
            (r) => r.name === 'Loop check · Validate' && r.state !== 'finished',
          )
          return check && (await hostRecords(home, check.id)).some((r) => r.t === 'start')
        },
        'the loop check’s host to start',
        20_000,
      )
      await daemon?.stop()
      daemon = await startDaemon({
        home,
        version: '9.9.9',
        claudeBin: stubClaudePath,
        codexBin: stubCodexPath,
      })
      const restarted = api(daemon.port, { appKey: daemon.appToken })
      await writeFile(release, '')
      const ask = await waitUntil(
        async () => {
          const result = await restarted.call('GET', `/tasks/${task.id}/comments`)
          return (result.body as Comment[]).find((c) => c.kind === 'question')
        },
        'the assessment to ask after restart',
        20_000,
      )
      expect(ask.body).toContain('Making progress')
      const tasks = await restarted.call('GET', '/tasks')
      expect((tasks.body as Task[]).find((t) => t.id === task.id)?.stage).toBe('validate')
      const history = await restarted.call('GET', `/tasks/${task.id}/events`)
      expect(
        (history.body as ThreadEvent[]).filter((e) => e.text.startsWith('Validate sent this back')),
      ).toHaveLength(1)
    },
    slow,
  )

  test.each(['looping', 'unknown'])(
    'a %s limit assessment asks with a recommendation or explicit uncertainty',
    async (verdict) => {
      const client = await start(
        'version: 1\norder: [intake, design, work, validate, review, merge]\nstages:\n  design: { gate: false }\n  validate: { max_back: 1, loop_check: 3 }\n',
      )
      const task = await loopTask(client, verdict, 4)
      const ask = await waitForAsk(client, task)
      expect(ask.body).toContain(
        verdict === 'looping' ? 'Recommended: Back to Design' : 'couldn’t assess progress',
      )
      expect(ask.body).not.toContain('The export button does nothing.')
      expect(ask.body).not.toContain('Round 1:')
      expect((await getTask(client, task.id)).stage).toBe('validate')
      const runs = await client.ok<RunSummary[]>('GET', `/tasks/${task.id}/runs`)
      expect(runs.filter((r) => r.name === 'Loop check · Validate')).toHaveLength(1)
    },
    slow,
  )

  test(
    'at the third send-back a looping verdict asks the human, and the Task Lead can’t advance until they answer',
    async () => {
      const client = await start(
        `${validateFlow}stages:\n  validate: { max_back: 5, loop_check: 3 }\n`,
      )
      const task = await loopTask(client, 'looping')
      const ask = await waitForAsk(client, task)
      expect(ask).toMatchObject({
        stage: 'validate',
        title: 'Validate and Work are going round in circles',
        choices: ['Try again', 'Move to Review anyway'],
      })
      expect(ask.body).not.toContain('Round 1:')
      expect(ask.body).not.toContain('The export button does nothing.')
      expect(ask.body).toContain('Recommended: Try again')
      expect(ask.body).toContain('history')
      expect(ask.body.length).toBeLessThan(800)
      const pending = (await threadEvents(client, task)).find(
        (e) => e.text === 'Validate wants to send this Task back to Work',
      )
      expect(pending?.findings).toContain('The export button does nothing.')
      expect((await getTask(client, task.id)).stage).toBe('validate')

      const runs = await client.ok<RunSummary[]>('GET', `/tasks/${task.id}/runs`)
      const check = runs.find((r) => r.name === 'Loop check · Validate')
      expect(check).toMatchObject({ agent: 'codex', role: 'sub-agent' })
      const texts = (await threadEvents(client, task)).map((e) => e.text)
      expect(texts).toContain('TED is checking whether Validate’s 3 rounds are converging')
      expect(texts.some((t) => t.startsWith('Loop check: looping'))).toBe(true)
      expect(texts.filter((t) => t.startsWith('Validate sent this back to Work'))).toEqual([
        'Validate sent this back to Work (round 1 of 5)',
        'Validate sent this back to Work (round 2 of 5)',
      ])

      const refused = await waitUntil(
        async () =>
          (await commandResults(client, task)).find((r) =>
            r.stderr.includes('TED asked the human whether to keep sending NB-1 back'),
          ),
        'the Task Lead’s advance to be refused',
        20_000,
      )
      expect(refused.code).toBe(1)
      expect((await getTask(client, task.id)).stage).toBe('validate')

      await client.ok('POST', `/comments/${ask.id}/answer`, {
        action: 'answer',
        choice: 'Try again',
      })
      await waitUntil(
        async () =>
          (await threadEvents(client, task)).some(
            (e) =>
              e.text === 'Validate sent this back to Work (round 1 of 5)' && e.at > ask.createdAt,
          ),
        'the send-back after Try again',
        20_000,
      )
      await waitUntil(
        async () =>
          (await userMessages(client, task)).some((m) =>
            m.startsWith(
              'The human chose Try again, so Validate’s count of send-backs starts over.',
            ),
          ),
        'the Task Lead to hear about Try again',
        20_000,
      )
    },
    slow,
  )

  test(
    'a converging verdict sends the Task back to Work with the verdict added',
    async () => {
      const client = await start(
        `${validateFlow}stages:\n  validate: { max_back: 5, loop_check: 3 }\n`,
      )
      await writeFile(path.join(home, 'stub-codex.json'), JSON.stringify({ turnStartDelayMs: 500 }))
      const task = await loopTask(client, 'converging')
      await waitUntil(
        async () =>
          (await threadEvents(client, task)).find(
            (e) => e.text === 'Validate sent this back to Work (round 3 of 5)',
          ),
        'the third send-back',
        30_000,
      )
      const texts = (await threadEvents(client, task)).map((e) => e.text)
      expect(texts.some((t) => t.startsWith('Loop check: converging'))).toBe(true)
      const message = await waitUntil(
        async () => (await userMessages(client, task)).find((m) => m.includes('# Loop check')),
        'the verdict to reach the Task Lead',
        20_000,
      )
      expect(message).toContain('Verdict: converging.')
      expect(message).toContain('TED moved this Task back to Work.')
    },
    slow,
  )

  test(
    'loop_check: false sends the third round back as usual; over max_back the loop ask offers Back to Design and Move on anyway',
    async () => {
      const client = await start(
        'version: 1\norder: [intake, design, work, validate, review, merge]\nstages:\n  design: { gate: false }\n  validate: { max_back: 3, loop_check: false }\n',
      )
      const file = path.join(scratch, 'findings.md')
      const script = [
        'f="n-$TED_RUN"; n=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$f";',
        'if [ $n -ge 11 ]; then :;',
        `elif [ $n -ge 4 ] && [ $((n % 2)) -eq 0 ]; then ted outcome back --to work --findings "${file}";`,
        'else ted outcome advance; fi',
      ].join(' ')
      await writeFile(file, '- The export button does nothing.\n')
      const run = { run: ['sh', '-c', script] }
      const task = await startTask(client, { everyMessage: [run, { endTurn: true }] }, run, {
        endTurn: true,
      })
      const ask = await waitForAsk(client, task)
      expect(ask).toMatchObject({
        title: 'Validate has sent this Task back 3 times, its limit',
        choices: ['Try again', 'Back to Design', 'Move to Review anyway'],
      })
      const texts = (await threadEvents(client, task)).map((e) => e.text)
      expect(texts.some((t) => t.includes('converging'))).toBe(false)
      expect(texts).toContain('Validate sent this back to Work (round 3 of 3)')
      const runs = await client.ok<RunSummary[]>('GET', `/tasks/${task.id}/runs`)
      expect(runs.some((r) => r.name === 'Loop check · Validate')).toBe(false)

      await client.ok('POST', `/comments/${ask.id}/answer`, {
        action: 'answer',
        choice: 'Move to Review anyway',
      })
      await waitForStage(client, task, 'review')
      const moved = await waitUntil(
        async () => (await userMessages(client, task)).find((m) => m.includes('# Open Findings')),
        'the open Findings to reach the Task Lead',
        20_000,
      )
      expect(moved).toContain('The export button does nothing.')
      expect(moved).toContain('TED moved this Task to Review.')
    },
    slow,
  )

  test(
    'Back to Design moves the Task to Design with the Findings, without counting',
    async () => {
      const client = await start(
        'version: 1\norder: [intake, design, work, validate, review, merge]\nstages:\n  design: { gate: false }\n  validate: { max_back: 1, loop_check: false }\n',
      )
      const file = path.join(scratch, 'findings.md')
      const script = [
        'f="n-$TED_RUN"; n=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$f";',
        'if [ $n -ge 7 ]; then :;',
        `elif [ $n -ge 4 ] && [ $((n % 2)) -eq 0 ]; then ted outcome back --to work --findings "${file}";`,
        'else ted outcome advance; fi',
      ].join(' ')
      await writeFile(file, '- The export button does nothing.\n')
      const run = { run: ['sh', '-c', script] }
      const task = await startTask(client, { everyMessage: [run, { endTurn: true }] }, run, {
        endTurn: true,
      })
      const ask = await waitForAsk(client, task)
      await client.ok('POST', `/comments/${ask.id}/answer`, {
        action: 'answer',
        choice: 'Back to Design',
        text: 'Rethink the export flow.',
      })
      await waitUntil(
        async () =>
          (await userMessages(client, task)).find((m) =>
            m.startsWith('The human sent this Task back to Design from Validate.'),
          ),
        'the Task Lead to hear about Design',
        20_000,
      )
      const texts = (await threadEvents(client, task)).map((e) => e.text)
      expect(texts).toContain('Validate sent this back to Design')
      expect((await getTask(client, task.id)).stage).toBe('design')
    },
    slow,
  )
})

describe('Validate’s count', () => {
  test(
    'a send-back from Review starts Validate’s count over',
    async () => {
      const client = await start(
        `${validateFlow}stages:\n  review: { gate: false }\n  validate: { max_back: 5, loop_check: false }\n`,
      )
      const file = path.join(scratch, 'findings.md')
      await writeFile(file, '- The export button does nothing.\n')
      const back = `ted outcome back --to work --findings "${file}"`
      const script = [
        'f="n-$TED_RUN"; n=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$f";',
        `case $n in 3|6|8) ${back};; 9|1[0-9]) :;; *) ted outcome advance;; esac`,
      ].join(' ')
      const run = { run: ['sh', '-c', script] }
      const task = await startTask(client, { everyMessage: [run, { endTurn: true }] }, run, {
        endTurn: true,
      })
      const texts = await waitUntil(
        async () => {
          const all = (await threadEvents(client, task)).map((e) => e.text)
          return all.filter((t) => t.includes('sent this back')).length >= 3 ? all : undefined
        },
        'three send-backs',
        30_000,
      )
      expect(texts.filter((t) => t.includes('sent this back'))).toEqual([
        'Validate sent this back to Work (round 1 of 5)',
        'Review sent this back to Work (round 1 of 3)',
        'Validate sent this back to Work (round 1 of 5)',
      ])
    },
    slow,
  )
})
