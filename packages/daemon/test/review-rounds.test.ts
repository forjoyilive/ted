import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Factory, RunSummary, RunWithConversation, SendBack, Task } from '@ted/protocol'
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
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-review-rounds-'))
  origin = await makeOriginRepo(scratch)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

const slow = 90_000

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

const waitForStage = (client: Client, task: Task, stage: string) =>
  waitUntil(
    async () => ((await getTask(client, task.id)).stage === stage ? true : undefined),
    `${task.displayId} to reach ${stage}`,
    60_000,
  )

const reviewerPrompts = async (client: Client, task: Task) => {
  const runs = await client.ok<RunSummary[]>('GET', `/tasks/${task.id}/runs`)
  const reviewers = runs
    .filter((r) => r.name === 'Reviewer · Validate')
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  return Promise.all(reviewers.map(async (r) => userMessages(await client.getRun(r.id))[0] ?? ''))
}

const counter = 'f="n-$TED_RUN"; n=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$f";'
const runIdOf = 'grep -o "[0-9a-f-]\\{36\\}" | head -1'
const review = (prompt: string) =>
  `out=$(ted run start --reviewer --prompt-file ${prompt}); ted run wait "$(echo "$out" | ${runIdOf})";`
const commit = (file: string) =>
  `echo fixed > ${file}; git add ${file}; git -c user.name=Test -c user.email=test@example.com commit -qm fix;`

async function promptFile() {
  const file = path.join(scratch, 'review.md')
  await writeFile(
    file,
    `# Review the whole branch\n\n${steps({ say: 'Reviewed' }, { endTurn: true })}\n`,
  )
  return file
}

describe('Validate rounds', () => {
  test(
    'from round two TED scopes the one reviewer to the earlier Findings and the diff since the last reviewed commit',
    async () => {
      const client = await start({
        '.ted/workflow.yaml':
          'version: 1\norder: [intake, work, validate, review, merge]\nreviewer: { agent: same }\nstages:\n  validate: { max_back: 5, loop_check: false }\n',
      })
      const prompt = await promptFile()
      const findings = path.join(scratch, 'findings.md')
      await writeFile(findings, '1. The export button does nothing.\n')
      const task = await startTask(
        client,
        [
          counter,
          'case $n in',
          '1|2) ted outcome advance;;',
          `3) ${review(prompt)} ted outcome back --to work --findings "${findings}";;`,
          `4) ${commit('export.txt')} ted outcome advance;;`,
          `5) ${review(prompt)}`,
          `echo "SECOND: $(ted run start --reviewer --prompt-file ${prompt} 2>&1)";`,
          `echo "PLAIN: $(ted run start --agent codex --name 'Independent Codex review' --prompt-file ${prompt} 2>&1)";`,
          'ted outcome advance;;',
          'esac',
        ].join(' '),
      )
      await waitForStage(client, task, 'review')

      const [first, second, ...more] = await reviewerPrompts(client, task)
      expect(more).toEqual([])
      expect(first).toContain('# Your instructions from the Task Lead of NB-1')
      expect(first).not.toContain('TED set the scope of this review')
      expect(second).toContain('# Your instructions from TED')
      expect(second).not.toContain('# Your instructions from the Task Lead')
      expect(second).toContain('# Review of the fixes in NB-1, Validate round 2')
      expect(second).toContain('1. The export button does nothing.')
      expect(second).toMatch(/`git diff [0-9a-f]{40} [0-9a-f]{40}`\n {2}- export\.txt/)
      expect(second).toMatch(
        /<<<TASK LEAD [0-9a-f-]{36}>>>\n# Review the whole branch[\s\S]*<<<TASK LEAD [0-9a-f-]{36}>>>$/,
      )

      const output = await waitUntil(
        async () => {
          const text = await leadOutput(client, task)
          return text.includes('PLAIN:') ? text : undefined
        },
        'the Task Lead’s last command to report',
        20_000,
      )
      expect(output).toMatch(/SECOND: .*this Validate visit already has its reviewer \(Run /)
      expect(output).toContain('PLAIN: ted: in Validate the only sub-agent is TED’s reviewer')

      const messages = userMessages(await leadRun(client, task))
      const back = messages.find((m) => m.startsWith('TED moved this Task back to Work.'))
      expect(back).toContain('# Send-back 1 of 5 from Validate')
      expect(back).toContain('Fix the Findings above and nothing else.')
      const round = messages.find((m) => m.includes('# Validate round 2'))
      expect(round).toContain('Validate has sent it back 1 time, and the limit is 5')
      expect(round).toContain('TED gives it the earlier Findings and the diff since the commit')
      expect(round).toContain('1. The export button does nothing.')
      expect(messages.filter((m) => m.includes('# Validate round'))).toHaveLength(1)

      const sendBacks = await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)
      expect(sendBacks.map((b) => b.cause)).toEqual(['review'])
    },
    slow,
  )

  test(
    'a round after a failed Check has no earlier review, so its reviewer gets the Task Lead’s prompt',
    async () => {
      const flag = 'stub-failed-once'
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
          '    checks:',
          `      - { name: Tests, run: "if [ -e '${flag}' ]; then echo ok; else touch '${flag}'; exit 1; fi" }`,
          '',
        ].join('\n'),
      })
      const prompt = await promptFile()
      const task = await startTask(
        client,
        [
          counter,
          'case $n in',
          '1|2|3) ted outcome advance;;',
          `4) ${review(prompt)} ted outcome advance;;`,
          'esac',
        ].join(' '),
      )
      await waitForStage(client, task, 'review')

      const sendBacks = await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)
      expect(sendBacks.map((b) => b.cause)).toEqual(['check'])
      expect(await reviewerPrompts(client, task)).toEqual([
        expect.stringContaining('# Your instructions from the Task Lead of NB-1'),
      ])
      const messages = userMessages(await leadRun(client, task))
      const back = messages.find((m) => m.startsWith('TED moved this Task back to Work.'))
      expect(back).toContain('# Send-back 1 of 5 from Validate')
      expect(back).toContain('Fix what the failing Check reports and nothing else.')
      const round = messages.find((m) => m.includes('# Validate round 2'))
      expect(round).toContain('TED has no finished review from the last round to build on')
      expect(round).not.toContain('<<<FINDINGS')
    },
    slow,
  )

  test('a round after a base-conflict send-back gets a full review, not a review of the fixes', async () => {
    const client = await start({
      'export.txt': 'first\n',
      '.ted/workflow.yaml':
        'version: 1\norder: [intake, work, validate, review, merge]\nreviewer: { agent: same }\nstages:\n  validate: { max_back: 5, loop_check: false }\n',
    })
    const prompt = await promptFile()
    const findings = path.join(scratch, 'findings.md')
    await writeFile(findings, '1. The export button does nothing.\n')
    const validating = path.join(scratch, 'validating')
    const moved = path.join(scratch, 'moved')
    const refused = path.join(scratch, 'refused.out')
    const task = await startTask(
      client,
      [
        counter,
        'case $n in',
        '1|2) ted outcome advance;;',
        `3) ${review(prompt)} ted outcome back --to work --findings "${findings}";;`,
        `4) ${commit('export.txt')} ted outcome advance;;`,
        `5) touch "${validating}"; while [ ! -e "${moved}" ]; do sleep 0.1; done;`,
        `ted outcome advance > "${refused}" 2>&1;`,
        `ted outcome back --to work --cause base-conflict --findings "${findings}";;`,
        `6) sha=$(grep -o "[0-9a-f]\\{40\\}" "${refused}" | head -1);`,
        'git -c user.name=Test -c user.email=test@example.com merge -q -X ours -m merge "$sha";',
        'ted outcome advance;;',
        `7) ${review(prompt)} ted outcome advance;;`,
        'esac',
      ].join(' '),
    )
    await waitUntil(
      () =>
        access(validating).then(
          () => true,
          () => undefined,
        ),
      'the Task Lead to reach the second Validate',
      60_000,
    )
    await commitToOrigin(scratch, { 'export.txt': 'main\n' })
    await writeFile(moved, '')
    await waitForStage(client, task, 'review')

    const sendBacks = await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)
    expect(sendBacks.map((b) => [b.cause, b.counted])).toEqual([
      ['review', true],
      ['base-conflict', false],
    ])
    const [first, second, ...more] = await reviewerPrompts(client, task)
    expect(more).toEqual([])
    expect(first).toContain('# Your instructions from the Task Lead of NB-1')
    expect(second).toContain('# Your instructions from the Task Lead of NB-1')
    expect(second).not.toContain('TED set the scope of this review')
    const rounds = userMessages(await leadRun(client, task)).filter((m) =>
      m.includes('# Validate round 2'),
    )
    expect(rounds).toHaveLength(2)
    expect(rounds[0]).toContain('This round checks the fixes.')
    expect(rounds[1]).toContain('conflict with the base branch')
    expect(rounds[1]).toContain('this round reviews the whole change again')
    expect(rounds[1]).not.toContain('This round checks the fixes.')
  }, 120_000)
})
