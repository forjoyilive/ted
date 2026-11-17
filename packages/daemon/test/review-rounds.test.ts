import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  BaseConflictFound,
  Factory,
  RunSummary,
  RunWithConversation,
  SendBack,
  Task,
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
const runIdOf = 'grep -o "[0-9a-f]\\{6\\}" | head -1'
const review = (prompt: string) =>
  `out=$(ted run start --reviewer --prompt-file ${prompt}); ted run wait "$(echo "$out" | ${runIdOf})";`
const commit = (file: string) =>
  `echo fixed > ${file}; git add ${file}; git -c user.name=Test -c user.email=test@example.com commit -qm fix;`

const late = (out: string) =>
  `echo late > late.txt; git add late.txt; git -c user.name=Test -c user.email=test@example.com commit -qm late; ted outcome advance > "${out}" 2>&1; git reset -q --hard HEAD~1;`

async function expectRefusedAfterReview(out: string) {
  const refused = await readFile(out, 'utf8')
  expect(refused).toMatch(
    /NB-1’s code changed after this Validate visit’s reviewer \(Run [0-9a-f]{6}\)/,
  )
  expect(refused).toMatch(
    /- widgets: the reviewer read [0-9a-f]{40}, and HEAD is now [0-9a-f]{40}\./,
  )
  expect(refused).toContain('Each Validate visit gets one review')
  expect(refused).toContain('`ted outcome back --to work --findings <file>`')
}

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
      const moved = path.join(scratch, 'moved.out')
      const task = await startTask(
        client,
        [
          counter,
          'case $n in',
          '1|2) ted outcome advance;;',
          `3) ${review(prompt)} ted outcome back --to work --findings "${findings}";;`,
          `4) ${commit('export.txt')}`,
          'git replace --graft HEAD "$(git rev-list --max-parents=0 HEAD | head -1)";',
          'ted outcome advance;;',
          `5) ${review(prompt)}`,
          `echo "SECOND: $(ted run start --reviewer --prompt-file ${prompt} 2>&1)";`,
          `echo "PLAIN: $(ted run start --agent codex --name 'Independent Codex review' --prompt-file ${prompt} 2>&1)";`,
          `${late(moved)} ted outcome advance;;`,
          'esac',
        ].join(' '),
      )
      await waitForStage(client, task, 'review')

      await expectRefusedAfterReview(moved)
      const [first, second, ...more] = await reviewerPrompts(client, task)
      expect(more).toEqual([])
      expect(first).toContain('# Your instructions from the Task Lead of NB-1')
      expect(first).not.toContain('TED set the scope of this review')
      expect(second).toContain('# Your instructions from TED')
      expect(second).not.toContain('# Your instructions from the Task Lead')
      expect(second).toContain('# Review of the fixes in NB-1, Validate round 2')
      expect(second).toContain('1. The export button does nothing.')
      expect(second).toMatch(
        /`GIT_GRAFT_FILE=\/dev\/null\/grafts GIT_SHALLOW_FILE=\/dev\/null git --no-replace-objects [^`]* diff --no-ext-diff --no-textconv [^`]* [0-9a-f]{40} [0-9a-f]{40}`\. Files changed:\n {2}(<<<FILES [0-9a-f-]{36}>>>)\n {2}- export\.txt\n {2}\1\n/,
      )
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
      expect(output).toContain('`stages.validate.sub_agents: true`')

      const messages = userMessages(await leadRun(client, task))
      const back = messages.find((m) => m.startsWith('TED moved this Task back to Work.'))
      expect(back).toContain('# Send-back 1 of 5 from Validate')
      expect(back).toContain('Fix the findings above and nothing else.')
      const round = messages.find((m) => m.includes('# Validate round 2'))
      expect(round).toContain('Validate has sent it back 1 time, and the limit is 5')
      expect(round).toContain('TED gives it the earlier findings and the diff since the commit')
      expect(round).toContain('1. The export button does nothing.')
      expect(messages.filter((m) => m.includes('# Validate round'))).toHaveLength(1)

      const sendBacks = await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)
      expect(sendBacks.map((b) => b.cause)).toEqual(['review'])
    },
    slow,
  )

  test(
    'a round with no finished review before it is a full review, and the Task Lead is told any Finding can be blocking',
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
          `3) ted outcome back --to work --findings "${findings}";;`,
          `4) ${commit('export.txt')} ted outcome advance;;`,
          `5) ${review(prompt)} ${late(path.join(scratch, 'moved.out'))} ted outcome advance;;`,
          'esac',
        ].join(' '),
      )
      await waitForStage(client, task, 'review')

      await expectRefusedAfterReview(path.join(scratch, 'moved.out'))
      const sendBacks = await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)
      expect(sendBacks.map((b) => b.cause)).toEqual(['review'])
      expect(await reviewerPrompts(client, task)).toEqual([
        expect.stringContaining('# Your instructions from the Task Lead of NB-1'),
      ])
      const messages = userMessages(await leadRun(client, task))
      const back = messages.find((m) => m.startsWith('TED moved this Task back to Work.'))
      expect(back).toContain('# Send-back 1 of 5 from Validate')
      expect(back).toContain('TED runs the Factory’s checks before the Task leaves Work')
      const round = messages.find((m) => m.includes('# Validate round 2'))
      expect(round).toContain('TED has no finished review from the last round to build on')
      expect(round).toContain('this round reviews the whole change again')
      expect(round).toContain('a problem anywhere in the change can be blocking')
      expect(round).not.toContain('This round checks the fixes.')
      expect(round).not.toContain('is a note, not a blocking finding')
      expect(round).toContain('1. The export button does nothing.')
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

  const flow =
    'version: 1\norder: [intake, work, validate, review, merge]\nreviewer: { agent: same }\nstages:\n  validate: { max_back: 5, loop_check: false }\n'
  const mergeBase = (refused: string) =>
    `sha=$(grep -o "[0-9a-f]\\{40\\}" "${refused}" | head -1); git -c user.name=Test -c user.email=test@example.com merge -q -X ours -m merge "$sha";`
  const reached = (file: string, what: string) =>
    waitUntil(
      () =>
        access(file).then(
          () => true,
          () => undefined,
        ),
      what,
      60_000,
    )

  test('after a base-conflict send-back from Review, TED scopes the reviewer to the conflict resolution', async () => {
    const client = await start({ 'export.txt': 'first\n', '.ted/workflow.yaml': flow })
    const prompt = await promptFile()
    const findings = path.join(scratch, 'findings.md')
    await writeFile(findings, 'The branch conflicts with main.\n')
    const reviewing = path.join(scratch, 'reviewing')
    const moved = path.join(scratch, 'moved')
    const refused = path.join(scratch, 'refused.out')
    const task = await startTask(
      client,
      [
        counter,
        'case $n in',
        '1) ted outcome advance;;',
        `2) ${commit('export.txt')} ted outcome advance;;`,
        `3) ${review(prompt)} ted outcome advance;;`,
        `4) touch "${reviewing}"; while [ ! -e "${moved}" ]; do sleep 0.1; done;`,
        `ted outcome advance > "${refused}" 2>&1;`,
        `ted outcome back --to work --cause base-conflict --findings "${findings}";;`,
        `5) ${mergeBase(refused)} ted outcome advance;;`,
        `6) ${review(prompt)} ${late(path.join(scratch, 'moved.out'))} ted outcome advance; touch "${path.join(scratch, 'second')}";;`,
        'esac',
      ].join(' '),
    )
    await reached(reviewing, 'the Task Lead to reach Review')
    await commitToOrigin(scratch, { 'export.txt': 'main\n', 'other.txt': 'from main\n' })
    await writeFile(moved, '')
    await reached(path.join(scratch, 'second'), 'the second Validate to finish')
    await waitForStage(client, task, 'review')

    await expectRefusedAfterReview(path.join(scratch, 'moved.out'))
    const sendBacks = await client.ok<SendBack[]>('GET', `/tasks/${task.id}/send-backs`)
    expect(sendBacks.map((b) => [b.from, b.cause, b.counted])).toEqual([
      ['review', 'base-conflict', false],
    ])
    const conflicts = await client.ok<BaseConflictFound[]>(
      'GET',
      `/tasks/${task.id}/base-conflicts`,
    )
    expect(conflicts).toMatchObject([
      { stage: 'review', repo: 'widgets', base: 'main', fileCount: 1, files: ['export.txt'] },
      {
        stage: 'review',
        repo: 'widgets',
        base: 'main',
        fileCount: 1,
        files: ['export.txt'],
        sendBackId: sendBacks[0]?.id,
      },
    ])
    expect(conflicts[0]).not.toHaveProperty('sendBackId')
    const tip = conflicts[1]?.tip ?? ''
    expect(tip).toMatch(/^[0-9a-f]{40}$/)

    const [first, second, ...more] = await reviewerPrompts(client, task)
    expect(more).toEqual([])
    expect(first).toContain('# Your instructions from the Task Lead of NB-1')
    expect(second).toContain('# Your instructions from TED')
    expect(second).toContain('# Review of the conflict resolution in NB-1')
    expect(second).toMatch(
      /git --no-replace-objects [^`]* show --no-ext-diff [^`]* --remerge-diff [0-9a-f]{40}`/,
    )
    expect(second).toContain(`brought in base commit ${tip}. Files that conflicted:`)
    expect(second).toContain('    - export.txt')
    expect(second).not.toContain('other.txt')
    expect(second).toContain('keeps both sides’ behaviour')
    expect(second).toMatch(
      /<<<FINDINGS [0-9a-f-]{36}>>>\n## Sent back from Review\n\nThe branch conflicts with main\./,
    )
    expect(second).toMatch(
      /<<<TASK LEAD [0-9a-f-]{36}>>>\n# Review the whole branch[\s\S]*<<<TASK LEAD [0-9a-f-]{36}>>>$/,
    )
    const messages = userMessages(await leadRun(client, task))
    const round = messages.filter((m) => m.includes('# Validate after a base conflict'))
    expect(round).toHaveLength(1)
    expect(round[0]).toContain('This round checks how the conflict was resolved')
    expect(messages.some((m) => m.includes('# Validate round'))).toBe(false)
  }, 150_000)

  test('a base merged in at Work between two rounds stays out of the fixes the reviewer reads', async () => {
    const client = await start({ 'export.txt': 'first\n', '.ted/workflow.yaml': flow })
    const prompt = await promptFile()
    const findings = path.join(scratch, 'findings.md')
    await writeFile(findings, '1. The export button does nothing.\n')
    const working = path.join(scratch, 'working')
    const moved = path.join(scratch, 'moved')
    const refused = path.join(scratch, 'refused.out')
    const task = await startTask(
      client,
      [
        counter,
        'case $n in',
        '1) ted outcome advance;;',
        `2) ${commit('export.txt')} ted outcome advance;;`,
        `3) ${review(prompt)} ted outcome back --to work --findings "${findings}";;`,
        `4) touch "${working}"; while [ ! -e "${moved}" ]; do sleep 0.1; done;`,
        `ted outcome advance > "${refused}" 2>&1;`,
        `${mergeBase(refused)} ${commit('fix.txt')} ted outcome advance;;`,
        `5) ${review(prompt)} ted outcome advance;;`,
        'esac',
      ].join(' '),
    )
    await reached(working, 'the Task Lead to come back to Work')
    await commitToOrigin(scratch, { 'export.txt': 'main\n', 'other.txt': 'from main\n' })
    await writeFile(moved, '')
    await waitForStage(client, task, 'review')

    const conflicts = await client.ok<BaseConflictFound[]>(
      'GET',
      `/tasks/${task.id}/base-conflicts`,
    )
    expect(conflicts).toMatchObject([{ stage: 'work', files: ['export.txt'] }])
    expect(conflicts[0]).not.toHaveProperty('sendBackId')
    const [, second] = await reviewerPrompts(client, task)
    expect(second).toContain('# Review of the fixes in NB-1, Validate round 2')
    expect(second).toMatch(
      /git --no-replace-objects [^`]* log -p --no-ext-diff [^`]* --reverse --first-parent --remerge-diff [0-9a-f]{40}\.\.[0-9a-f]{40}`/,
    )
    expect(second).toContain('not what the base branch brought in')
    expect(second).toContain('  - fix.txt')
    expect(second).toContain('  - export.txt')
    expect(second).not.toContain('other.txt')
    expect(second).not.toMatch(/ diff --no-ext-diff [^`]* [0-9a-f]{40} [0-9a-f]{40}`/)
  }, 150_000)
})
