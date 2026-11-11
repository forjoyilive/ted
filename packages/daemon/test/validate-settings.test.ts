import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  Factory,
  RunSummary,
  RunWithConversation,
  SendBack,
  Task,
  ThreadEvent,
} from '@ted/protocol'
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
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-validate-settings-'))
  origin = await makeOriginRepo(scratch)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

const slow = 120_000

async function start(files: Record<string, string>) {
  await commitToOrigin(scratch, files)
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

async function startTask(client: Client, script: string): Promise<Task> {
  const run = { run: ['sh', '-c', script] }
  const title = steps({ everyMessage: [run, { endTurn: true }] }, run, { endTurn: true })
  const task = await client.ok<Task>('POST', '/tasks', { title, factory: 'NB' })
  await client.ok('POST', `/tasks/${task.id}/start`)
  return task
}

const getTask = async (client: Client, id: string) => {
  const task = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

const userMessages = (run: RunWithConversation) =>
  run.conversation.flatMap((e) => {
    const line = JSON.parse(e.line) as { type: string; message?: { content?: unknown } }
    return line.type === 'user' && typeof line.message?.content === 'string'
      ? [line.message.content]
      : []
  })

const leadRun = async (client: Client, task: Task) => {
  const { leadRunId } = await getTask(client, task.id)
  if (!leadRunId) throw new Error(`no Task Lead Run for ${task.displayId}`)
  return client.getRun(leadRunId)
}

const leadOutput = async (client: Client, task: Task) =>
  assistantTexts((await leadRun(client, task)).conversation)
    .flatMap((text) => {
      try {
        return [(JSON.parse(text) as { stdout: string }).stdout]
      } catch {
        return []
      }
    })
    .join('\n')

const outputWith = (client: Client, task: Task, mark: string) =>
  waitUntil(
    async () => {
      const text = await leadOutput(client, task)
      return text.includes(mark) ? text : undefined
    },
    `the Task Lead to print ${mark}`,
    20_000,
  )

const waitForStage = (client: Client, task: Task, stage: string) =>
  waitUntil(
    async () => ((await getTask(client, task.id)).stage === stage ? true : undefined),
    `${task.displayId} to reach ${stage}`,
    90_000,
  )

const taskRuns = (client: Client, task: Task) =>
  client.ok<RunSummary[]>('GET', `/tasks/${task.id}/runs`)

const reviewerPrompts = async (client: Client, task: Task) => {
  const reviewers = (await taskRuns(client, task))
    .filter((r) => r.name === 'Reviewer · Validate')
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  return Promise.all(reviewers.map(async (r) => userMessages(await client.getRun(r.id))[0] ?? ''))
}

const counter = 'f="n-$TED_RUN"; n=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$f";'
const runIdOf = 'grep -o "[0-9a-f-]\\{36\\}" | head -1'
const review = (prompt: string) =>
  `out=$(ted run start --reviewer --prompt-file ${prompt}); ted run wait "$(echo "$out" | ${runIdOf})";`
const save = (file: string) =>
  `git add ${file}; git -c user.name=Test -c user.email=test@example.com commit -qm fix;`
const commit = (file: string) => `echo fixed > ${file}; ${save(file)}`

async function promptFile() {
  const file = path.join(scratch, 'review.md')
  await writeFile(
    file,
    `# Review the whole branch\n\n${steps({ say: 'Reviewed' }, { endTurn: true })}\n`,
  )
  return file
}

const flow =
  'version: 1\norder: [intake, work, validate, review, merge]\nreviewer: { agent: same }\n'

describe('stages.validate.p1_only_from', () => {
  test(
    'from its round, a send-back from Validate needs a declared P1 Finding, and a Run can’t change the setting from its worktree',
    async () => {
      const client = await start({
        '.ted/workflow.yaml': `${flow}stages:\n  validate: { max_back: 5, loop_check: false, p1_only_from: 2 }\n`,
      })
      const prompt = await promptFile()
      const findings = path.join(scratch, 'findings.md')
      await writeFile(findings, '1. The export button does nothing.\n')
      const own = `${flow}stages:\n  validate: { max_back: 5, loop_check: false, p1_only_from: false, sub_agents: true }\n`
      const task = await startTask(
        client,
        [
          counter,
          'case $n in',
          '1) ted outcome advance;;',
          `2) printf '%s' '${own}' > .ted/workflow.yaml; ${save('.ted/workflow.yaml')} ted outcome advance;;`,
          `3) ${review(prompt)} ted outcome back --to work --findings "${findings}";;`,
          `4) ${commit('export.txt')} ted outcome advance;;`,
          `5) ${review(prompt)}`,
          `echo "NOSEV: $(ted outcome back --to work --findings "${findings}" 2>&1)";`,
          `echo "PLAIN: $(ted run start --agent claude --name Extra --prompt-file ${prompt} 2>&1)";`,
          `ted outcome back --to work --findings "${findings}" --severity p1;;`,
          `6) ${commit('export2.txt')} ted outcome advance;;`,
          `7) ${review(prompt)} ted outcome advance;;`,
          'esac',
        ].join(' '),
      )
      await waitForStage(client, task, 'review')

      const output = await outputWith(client, task, 'PLAIN:')
      const refused = output.split('\n').find((line) => line.startsWith('NOSEV: ')) ?? ''
      expect(refused).toContain('this is Validate round 2')
      expect(refused).toContain('`stages.validate.p1_only_from: 2`')
      expect(refused).toContain('with `--severity p1`')
      expect(refused).toContain('`ted outcome advance --review pass --review-notes <n>`')
      expect(output).toContain('PLAIN: ted: in Validate the only sub-agent is TED’s reviewer')
      expect(output).toContain('`stages.validate.sub_agents: true`')
      expect((await taskRuns(client, task)).some((r) => r.name === 'Extra')).toBe(false)

      const sendBacks = await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)
      expect(sendBacks.map((b) => [b.cause, b.round, b.severity])).toEqual([
        ['review', 1, undefined],
        ['review', 2, 'p1'],
      ])
      const events = await client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)
      const lines = events.map((e) => e.text).filter((text) => text.includes('sent this back'))
      expect(lines).toHaveLength(2)
      expect(lines[0]).not.toContain('P1 declared')
      expect(lines[1]).toMatch(/\(round 2 of 5\).* · P1 declared$/)

      const [first, second, third, ...more] = await reviewerPrompts(client, task)
      expect(more).toEqual([])
      expect(first).toContain('# Your instructions from the Task Lead of NB-1')
      expect(first).not.toContain('## Severity')
      for (const [prompted, round] of [
        [second, 2],
        [third, 3],
      ] as const) {
        expect(prompted).toContain('# Your instructions from TED')
        expect(prompted).toContain(`# Review of the fixes in NB-1, Validate round ${round}`)
        expect(prompted).toContain('## Severity')
        expect(prompted).toContain(
          'From Validate round 2 this Factory sends a Task back to Work only for a P1 Finding.',
        )
      }

      const rounds = userMessages(await leadRun(client, task)).filter((m) =>
        m.includes('# Validate round'),
      )
      expect(rounds).toHaveLength(2)
      for (const round of rounds) {
        expect(round).toContain('This Factory sets `stages.validate.p1_only_from: 2`')
        expect(round).toContain('add `--severity p1` to `ted outcome back`')
        expect(round).not.toContain('A new Finding about code the fixes didn’t touch is a note')
      }
    },
    slow,
  )

  test(
    'a failed Check still sends the Task back in those rounds, and a full review carries TED’s severity rule',
    async () => {
      const count = 'stub-count'
      const client = await start({
        '.gitignore': 'stub-*\n',
        '.ted/workflow.yaml': [
          'version: 1',
          'order: [intake, work, validate, review, merge]',
          'reviewer: { agent: same }',
          'stages:',
          '  validate:',
          '    max_back: 5',
          '    loop_check: false',
          '    p1_only_from: 2',
          '    checks:',
          `      - { name: Tests, run: "c=$(cat ${count} 2>/dev/null || echo 0); c=$((c+1)); echo $c > ${count}; [ $c -gt 2 ]" }`,
          '',
        ].join('\n'),
      })
      const prompt = await promptFile()
      const task = await startTask(
        client,
        [
          counter,
          'case $n in',
          '1|2|3|4) ted outcome advance;;',
          `5) ${review(prompt)} ted outcome advance;;`,
          'esac',
        ].join(' '),
      )
      await waitForStage(client, task, 'review')

      const sendBacks = await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)
      expect(sendBacks.map((b) => [b.cause, b.round, b.severity])).toEqual([
        ['check', 1, undefined],
        ['check', 2, undefined],
      ])
      const prompts = await reviewerPrompts(client, task)
      expect(prompts).toHaveLength(1)
      const [prompted = ''] = prompts
      expect(prompted).toContain('# Your instructions from TED')
      expect(prompted).not.toContain('# Your instructions from the Task Lead')
      expect(prompted).toContain('# Review of NB-1, Validate round 3')
      expect(prompted).not.toContain('TED set the scope of this review')
      expect(prompted).toContain('## Severity')
      expect(prompted).toMatch(
        /<<<TASK LEAD [0-9a-f-]{36}>>>\n# Review the whole branch[\s\S]*<<<TASK LEAD [0-9a-f-]{36}>>>$/,
      )
      const round = userMessages(await leadRun(client, task)).find((m) =>
        m.includes('# Validate round 3'),
      )
      expect(round).toContain('TED has no finished review from the last round to build on')
      expect(round).toContain('This Factory sets `stages.validate.p1_only_from: 2`')
    },
    slow,
  )
})

describe('stages.validate.sub_agents', () => {
  test(
    'true lets the Task Lead start another sub-agent in Validate, and the visit still gets one reviewer',
    async () => {
      const client = await start({
        '.ted/workflow.yaml': `${flow}stages:\n  validate: { max_back: 5, loop_check: false, sub_agents: true }\n`,
      })
      const prompt = await promptFile()
      const task = await startTask(
        client,
        [
          counter,
          'case $n in',
          '1|2) ted outcome advance;;',
          `3) plain=$(ted run start --agent claude --name 'Slow tests' --prompt-file ${prompt});`,
          `ted run wait "$(echo "$plain" | ${runIdOf})";`,
          review(prompt),
          `echo "SECOND: $(ted run start --reviewer --prompt-file ${prompt} 2>&1)";`,
          `echo "FLAGS: $(ted run start --reviewer --agent codex --prompt-file ${prompt} 2>&1)";`,
          'ted outcome advance;;',
          'esac',
        ].join(' '),
      )
      await waitForStage(client, task, 'review')

      const output = await outputWith(client, task, 'FLAGS:')
      expect(output).toMatch(/SECOND: .*this Validate visit already has its reviewer \(Run /)
      expect(output).toMatch(/FLAGS: .*come from the `reviewer` setting/)
      const runs = await taskRuns(client, task)
      const plain = runs.find((r) => r.name === 'Slow tests')
      expect(plain?.parentRunId).toBe((await getTask(client, task.id)).leadRunId)
      expect(userMessages(await client.getRun(plain?.id ?? ''))[0]).toContain(
        '# Your instructions from the Task Lead of NB-1',
      )
      expect(runs.filter((r) => r.name === 'Reviewer · Validate')).toHaveLength(1)
    },
    slow,
  )
})
