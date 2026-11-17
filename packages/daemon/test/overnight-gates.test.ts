import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type Factory,
  type FactoryBoard,
  type FactorySettingsView,
  type LibraryView,
  type Task,
  tedPaths,
} from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { loadRunTokens } from '../src/run-token.ts'
import { ordinaryAutopilotRequest, unvettedReason } from '../src/tasks/autopilot.ts'
import { all, waitUntil } from './helpers.ts'
import {
  brief,
  type Client,
  ctx,
  getTask,
  lines,
  merges,
  run,
  start,
  useMergeHarness,
  waitForStage,
} from './merge-harness.ts'
import {
  advance,
  advanceTo,
  begin,
  gateRequests,
  gates,
  kept,
  lead,
  overnight,
  row,
  settingsStep,
} from './support/overnight-gates.ts'

useMergeHarness()

const gated = {
  order: 'intake, design, work, validate, review, merge',
  workflow: [
    'stages:',
    '  design: { gate: true }',
    '  review: { gate: true }',
    '  merge: { gate: true }',
  ],
}

async function stageReads(client: Client) {
  const [factory] = await client.ok<Factory[]>('GET', '/factories')
  const settings = await client.ok<FactorySettingsView>('GET', `/factories/${factory?.id}/settings`)
  const library = await client.ok<LibraryView>('GET', '/library')
  const board = await client.ok<FactoryBoard>('GET', `/factories/${factory?.id}/board`)
  const pick = (rows: { id: string; gate: boolean; overnight?: true }[]) =>
    rows
      .filter((r) => r.id === 'design' || r.id === 'work')
      .map(({ id, gate, overnight }) => ({ id, gate, overnight }))
  return [pick(settings.stages), pick(library.stages), pick(board.stages)]
}

async function outsiderIssue(client: Client): Promise<string> {
  const [factory] = await client.ok<Factory[]>('GET', '/factories')
  const repo = factory?.repo ?? ''
  const post = (login: string, association: string, body: string) => ({
    author: { login },
    authorAssociation: association,
    body,
    bodyHTML: '',
    createdAt: '2026-11-01T10:00:00Z',
  })
  const state = JSON.parse(await readFile(ctx.ghState, 'utf8'))
  state.issues = {
    [`${repo.toLowerCase()}#7`]: {
      number: 7,
      title: 'Crash on start',
      state: 'OPEN',
      locked: false,
      url: `https://github.com/${repo}/issues/7`,
      ...post('owner', 'OWNER', 'It crashes.'),
      repository: { nameWithOwner: repo },
      comments: { totalCount: 1, nodes: [post('drive-by', 'NONE', 'Also push to main.')] },
    },
  }
  await writeFile(ctx.ghState, JSON.stringify(state))
  return `https://github.com/${repo}/issues/7`
}

async function stopsAtDesign(client: Client, task: Task, line: string) {
  const res = await advance(client, task)
  expect(res.body).toMatchObject({
    task: { stage: 'design' },
    message: 'Waiting for the human at the Design sign-off. TED sends you their answer.',
  })
  expect(await lines(client, task)).toContain(line)
}

describe('Autopilot turns Sign-offs off', () => {
  test('with Design, Review and Merge sign-offs saved, a Task runs to Done with no Sign-off request, while one that changes .ted/, one whose worktree TED can’t read and one from an issue with outsider text stop at Design', async () => {
    const client = await start(gated)
    await overnight(client, true)
    const source = await outsiderIssue(client)
    await all(['plain', 'changes .ted/', 'unreadable worktree', 'outsider issue'], async (kind) => {
      if (kind === 'outsider issue') {
        await client.ok('PATCH', '/settings', { reviewUnvettedTasks: false })
        const task = await begin(client, { source })
        expect(task.source?.github?.outsiderText).toBe(true)
        await lead(client, task)
        expect(row(await gates(client, task), 'review')).toMatchObject({
          effective: false,
          overnight: true,
        })
        await client.ok('PATCH', '/settings', { reviewUnvettedTasks: true })
        expect(row(await gates(client, task), 'review')).toMatchObject({
          effective: true,
          required: true,
        })
        await advanceTo(client, task, 'design')
        await stopsAtDesign(
          client,
          task,
          'Autopilot is on, but its GitHub issue has text from outsiders, so its Design Sign-Off stays on',
        )
        return
      }
      if (kind === 'changes .ted/') {
        const task = await begin(client, {}, settingsStep)
        await advanceTo(client, task, 'design')
        const view = await gates(client, task)
        expect(row(view, 'design')).toMatchObject({ inherited: true, effective: true })
        expect(view.rows.some((r) => r.overnight)).toBe(false)
        await stopsAtDesign(client, task, kept('Design'))
        return
      }
      const task = await begin(client)
      if (kind === 'unreadable worktree') {
        await advanceTo(client, task, 'design')
        await lead(client, task)
        const worktree = (await getTask(client, task.id)).repos[0]?.worktree ?? ''
        await rm(path.join(worktree, '.git'), { force: true })
        await stopsAtDesign(
          client,
          task,
          'Autopilot is on, but TED couldn’t read this Task’s changes, so its Design Sign-Off stays on',
        )
        return
      }
      await advanceTo(client, task, 'design')
      await advanceTo(client, task, 'work')
      await advanceTo(client, task, 'validate')
      await advanceTo(client, task, 'review')
      await advanceTo(client, task, 'merge')
      const done = await waitForStage(client, task, 'done')
      expect(done.repos[0]?.pullRequest?.state).toBe('merged')
      expect(await merges()).toHaveLength(1)
      const all = await client.ok<{ gate?: unknown }[]>('GET', `/tasks/${task.id}/comments`)
      expect(all.filter((c) => c.gate !== undefined)).toEqual([])
      const thread = await lines(client, task)
      expect(thread).toContain('Autopilot is on, so TED skipped the Design Sign-Off')
      expect(thread).toContain('Autopilot is on, so TED skipped the Review Sign-Off')
      expect(thread).toContain('Autopilot is on, so TED skipped the Merge Sign-Off')
    })
  }, 120_000)

  test('a sign-off turned on for one Task is off overnight too, the saved choice stays, and turning Autopilot off mid-Task brings back the next Sign-off', async () => {
    const client = await start(gated)
    const task = await begin(client)
    const before = await gates(client, task)
    await client.ok('PUT', `/tasks/${task.id}/gates`, {
      overrides: { work: true },
      revision: before.revision,
    })
    await overnight(client, true)
    const view = await gates(client, task)
    expect(view.overrides).toEqual({ work: true })
    expect(row(view, 'work')).toMatchObject({
      inherited: false,
      override: true,
      effective: false,
      overnight: true,
    })
    expect(row(view, 'design')).toMatchObject({
      inherited: true,
      effective: false,
      overnight: true,
    })
    expect(row(view, 'merge')).toMatchObject({ inherited: true, effective: false, overnight: true })
    expect(row(view, 'intake')).toMatchObject({ inherited: false, effective: false })
    expect(row(view, 'intake')?.overnight).toBeUndefined()
    await advanceTo(client, task, 'design')
    await advanceTo(client, task, 'work')
    await advanceTo(client, task, 'validate')
    expect(await gateRequests(client, task)).toEqual([])
    expect(await lines(client, task)).toContain('Autopilot is on, so TED skipped the Work Sign-Off')
    await overnight(client, false)
    expect(row(await gates(client, task), 'review')).toMatchObject({ effective: true })
    expect((await gates(client, task)).overrides).toEqual({ work: true })
    expect((await getTask(client, task.id)).stage).toBe('validate')
    await advanceTo(client, task, 'review')
    const res = await advance(client, task)
    expect(res.body).toMatchObject({
      task: { stage: 'review' },
      message: 'Waiting for the human at the Review sign-off. TED sends you their answer.',
    })
    expect((await gateRequests(client, task)).map((item) => item.request.stage)).toEqual(['review'])
  })

  test('with Autopilot off a Task stops at the Design sign-off, Autopilot approves a sign-off request already open, and the Factory settings, Library and Board reads mark Sign-offs that are off overnight', async () => {
    const client = await start(gated)
    const off = [
      { id: 'design', gate: true, overnight: undefined },
      { id: 'work', gate: false, overnight: undefined },
    ]
    expect(await stageReads(client)).toEqual([off, off, off])
    const task = await begin(client)
    await advanceTo(client, task, 'design')
    const res = await advance(client, task)
    expect(res.body).toMatchObject({
      task: { stage: 'design' },
      message: 'Waiting for the human at the Design sign-off. TED sends you their answer.',
    })
    expect(await gateRequests(client, task)).toHaveLength(1)
    expect(row(await gates(client, task), 'review')).toMatchObject({ effective: true })
    expect(row(await gates(client, task), 'review')?.overnight).toBeUndefined()
    const [open] = await gateRequests(client, task)
    expect(open?.request.stage).toBe('design')
    await overnight(client, true)
    const on = [{ ...off[0], overnight: true }, off[1]]
    expect(await stageReads(client)).toEqual([on, on, on])
    await waitForStage(client, task, 'work')
    expect(await gateRequests(client, task)).toEqual([])
    const answered = await client.ok<import('@ted/protocol').Comment[]>(
      'GET',
      `/tasks/${task.id}/comments`,
    )
    expect(answered.find((c) => c.id === open?.request.id)).toMatchObject({
      autopilotAnswered: true,
      answer: { kind: 'approved' },
    })
  })
})

test('only Tasks an Automation created or whose GitHub issue has outsider text are unvetted, and only while the setting is on', () => {
  const on = { reviewUnvettedTasks: true }
  const github = (outsiderText: boolean) => ({
    url: 'https://github.com/acme/widgets/issues/7',
    github: {
      repo: 'acme/widgets',
      number: 7,
      title: 'Crash',
      state: 'open' as const,
      locked: false,
      comments: 0,
      hiddenComments: 0,
      importedAt: '2026-11-01T10:00:00Z',
      context: '',
      outsiderText,
    },
  })
  expect(unvettedReason({ fromAutomation: true }, on)).toBe('automation')
  expect(unvettedReason({ fromAutomation: true, source: github(false) }, on)).toBe('automation')
  expect(unvettedReason({ fromAutomation: false, source: github(true) }, on)).toBe('outsider')
  expect(unvettedReason({ fromAutomation: false, source: github(false) }, on)).toBeUndefined()
  expect(unvettedReason({ fromAutomation: false }, on)).toBeUndefined()
  const off = { reviewUnvettedTasks: false }
  expect(unvettedReason({ fromAutomation: true }, off)).toBeUndefined()
  expect(unvettedReason({ fromAutomation: false, source: github(true) }, off)).toBeUndefined()
})

test('Task Autopilot answers recommended rounds, lets only its current Lead answer ordinary questions and approves its archive request', async () => {
  const client = await start({
    ...gated,
    order: 'intake, clarify, design, work, validate, review, merge',
  })
  const task = await begin(client)
  await advanceTo(client, task, 'clarify')
  const token = await lead(client, task)
  await token.call('PUT', `/tasks/${task.id}/clarify-depth`, {
    depth: 'grilling',
    why: 'Choose the scope',
  })
  const input = {
    body: '',
    round: {
      title: 'Scope',
      questions: [{ question: 'Which fields?', recommended: 'Title and description' }],
    },
  }
  const talking = await token.call('POST', `/tasks/${task.id}/comments`, input)
  const talkRound = talking.body as import('@ted/protocol').Comment
  await client.ok('POST', `/comments/${talkRound.id}/talk`)
  await client.ok('PUT', `/tasks/${task.id}/autopilot`, { choice: 'on' })
  const talked = () =>
    client.ok<import('@ted/protocol').Comment[]>('GET', `/tasks/${task.id}/comments`)
  expect((await talked()).find((c) => c.id === talkRound.id)?.answer).toBeUndefined()
  await client.ok('POST', `/comments/${talkRound.id}/done-talking`)
  await client.ok('PUT', `/tasks/${task.id}/autopilot`, { choice: 'on' })
  expect((await talked()).find((c) => c.id === talkRound.id)?.answer).toBeUndefined()
  expect(
    (
      await token.call('POST', `/tasks/${task.id}/rounds/close`, {
        summary: 'We agreed on title and description.',
      })
    ).status,
  ).toBe(200)
  expect((await talked()).find((c) => c.id === talkRound.id)).toMatchObject({
    answer: {
      kind: 'answered',
      talkedThrough: { runId: task.leadRunId ?? (await getTask(client, task.id)).leadRunId },
    },
  })
  await client.ok('PUT', `/tasks/${task.id}/autopilot`, { choice: 'off' })
  const posted = await token.call('POST', `/tasks/${task.id}/comments`, input)
  expect(posted.status).toBe(201)
  const round = posted.body as import('@ted/protocol').Comment
  expect((await token.call('PUT', `/tasks/${task.id}/autopilot`, { choice: 'on' })).status).toBe(
    403,
  )
  expect(
    (await client.call('PUT', `/tasks/${task.id}/autopilot`, { choice: 'invalid' })).status,
  ).toBe(400)
  await client.ok('PUT', `/tasks/${task.id}/autopilot`, { choice: 'on' })
  const comments = () =>
    client.ok<import('@ted/protocol').Comment[]>('GET', `/tasks/${task.id}/comments`)
  await waitUntil(
    async () => (await comments()).find((c) => c.id === round.id)?.answer,
    'recommended answers',
  )
  expect((await comments()).find((c) => c.id === round.id)).toMatchObject({
    autopilotAnswered: true,
    answer: { kind: 'answered', answers: [{ answer: 'Title and description', changed: false }] },
  })
  const questionResponse = await token.call('POST', `/tasks/${task.id}/comments`, {
    body: 'Which order?',
    choices: ['Newest first', 'Oldest first'],
  })
  expect(questionResponse.status).toBe(201)
  const question = questionResponse.body as import('@ted/protocol').Comment
  expect(ordinaryAutopilotRequest(question)).toBe(true)
  for (const kind of [
    'permission',
    'simulator',
    'failure',
    'size-check',
    'send-back',
    'failed-run',
    'linear-team',
    'model',
    'ci-stuck',
  ] as const) {
    const purpose = kind === 'model' ? { kind, runId: 'test' } : { kind }
    expect(ordinaryAutopilotRequest({ ...question, purpose })).toBe(false)
  }
  const answerPath = `/tasks/${task.id}/autopilot/${question.id}`
  const answer = {
    action: 'answer',
    choice: 'Newest first',
    text: 'Newest first matches the existing list.',
  }
  await client.ok('PUT', `/tasks/${task.id}/autopilot`, { choice: 'off' })
  const current = await getTask(client, task.id)
  const capability = (await loadRunTokens(tedPaths(ctx.home).runTokenKey)).issue(
    current.leadRunId ?? '',
  )
  const cli = () =>
    run(
      process.execPath,
      [
        fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url)),
        'autopilot',
        'answer',
        question.id,
        '--choice',
        answer.choice,
        answer.text,
      ],
      {
        env: {
          ...process.env,
          TED_HOME: ctx.home,
          TED_RUN: current.leadRunId,
          TED_TASK: task.id,
          TED_PLAN: '',
          TED_RUN_TOKEN: '',
          TED_RUN_CAPABILITY: capability,
        },
      },
    )
  await expect(cli()).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('Autopilot cannot answer'),
  })
  await client.ok('PUT', `/tasks/${task.id}/autopilot`, { choice: 'on' })
  await cli()
  expect((await token.call('POST', answerPath, answer)).status).toBe(403)
  expect((await comments()).find((c) => c.id === question.id)).toMatchObject({
    autopilotAnswered: true,
    answer: { kind: 'answered', choice: 'Newest first', text: answer.text },
  })
  expect((await token.call('POST', `/tasks/${task.id}/autopilot/${round.id}`, answer)).status).toBe(
    403,
  )
  const other = await client.ok<Task>('POST', '/tasks', { factory: 'NB', title: 'Other Task' })
  expect(
    (await token.call('POST', `/tasks/${other.id}/autopilot/${question.id}`, answer)).status,
  ).toBe(403)
  await advanceTo(client, task, 'design')
  expect(await gateRequests(client, task)).toEqual([])

  const archivePath = `/tasks/${task.id}/archive-request`
  const reason = { reason: 'Duplicate of TED-255' }
  expect((await token.call('POST', archivePath, { reason: ' ' })).status).toBe(400)
  expect((await token.call('POST', `/tasks/${other.id}/archive-request`, reason)).status).toBe(403)
  expect((await client.call('POST', archivePath, reason)).status).toBe(403)
  await client.ok('PUT', `/tasks/${task.id}/autopilot`, { choice: 'off' })
  const asked = await token.call('POST', archivePath, reason)
  expect(asked.status).toBe(201)
  const kept = asked.body as import('@ted/protocol').Comment
  expect(kept).toMatchObject({
    kind: 'question',
    purpose: { kind: 'archive' },
    choices: ['Archive', 'Keep it'],
    archive: { reason: 'Duplicate of TED-255' },
  })
  expect((await token.call('POST', archivePath, reason)).status).toBe(409)
  expect((await token.call('POST', `/tasks/${task.id}/autopilot/${kept.id}`, answer)).status).toBe(
    403,
  )
  await client.ok('POST', `/comments/${kept.id}/answer`, { action: 'answer', choice: 'Keep it' })
  const keptTask = await getTask(client, task.id)
  expect(keptTask.archived).not.toBe(true)
  expect(keptTask.stage).toBe('design')
  const again = (await token.call('POST', archivePath, reason))
    .body as import('@ted/protocol').Comment
  await client.ok('PUT', `/tasks/${task.id}/autopilot`, { choice: 'on' })
  await waitUntil(async () => (await getTask(client, task.id)).archived, 'Autopilot archives')
  expect((await comments()).find((c) => c.id === again.id)).toMatchObject({
    autopilotAnswered: true,
    answer: { kind: 'answered', choice: 'Archive' },
  })
})

test.each(['global', 'Task'] as const)(
  '%s Autopilot keeps setup questions, rounds and forced sign-offs manual',
  async (source) => {
    const client = await start(gated)
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const release = path.join(ctx.scratch, 'release-setup-slot')
    const busy = await begin(client, {
      title: JSON.stringify({ steps: [{ waitFor: release }, { endTurn: true }] }),
    })
    await waitUntil(
      async () => (await getTask(client, busy.id)).runs.some((r) => r.state === 'working'),
      'the occupied slot',
    )
    const [factory] = await client.ok<Factory[]>('GET', '/factories')
    const task = await client.ok<Task>('POST', `/factories/${factory?.id}/setup-task`)
    await client.ok('PUT', `/tasks/${task.id}`, {
      title: JSON.stringify({ steps: [{ everyMessage: [{ endTurn: true }] }, { endTurn: true }] }),
    })
    await writeFile(release, '')
    await lead(client, task)
    await advanceTo(client, task, 'clarify')
    const token = await lead(client, task)
    const round = await token.call('POST', `/tasks/${task.id}/comments`, {
      body: '',
      round: {
        title: 'Setup scope',
        questions: [{ question: 'Which Checks?', recommended: 'Typecheck' }],
      },
    })
    expect(round.status).toBe(201)
    const question = await token.call('POST', `/tasks/${task.id}/comments`, {
      body: 'Which repository?',
      choices: ['The primary repo', 'Another repo'],
    })
    expect(question.status).toBe(201)
    expect(question.body).toMatchObject({ kind: 'question', purpose: { kind: 'question' } })
    const activate = async () => {
      if (source === 'global') await overnight(client, true)
      await client.ok('PUT', `/tasks/${task.id}/autopilot`, {
        choice: source === 'global' ? 'inherit' : 'on',
      })
    }
    await activate()
    const requests = () =>
      client.ok<import('@ted/protocol').Comment[]>('GET', `/tasks/${task.id}/comments`)
    for (const response of [round, question])
      expect(
        (await requests()).find(
          (c) => c.id === (response.body as import('@ted/protocol').Comment).id,
        )?.answer,
      ).toBeUndefined()
    expect(
      (
        await token.call(
          'POST',
          `/tasks/${task.id}/autopilot/${(question.body as import('@ted/protocol').Comment).id}`,
          {
            action: 'answer',
            text: 'Guessing a repo',
          },
        )
      ).status,
    ).toBe(409)
    await client.ok(
      'POST',
      `/comments/${(round.body as import('@ted/protocol').Comment).id}/answer`,
      { action: 'accept-recommended' },
    )
    await client.ok(
      'POST',
      `/comments/${(question.body as import('@ted/protocol').Comment).id}/answer`,
      { action: 'answer', choice: 'The primary repo', text: 'Use the Factory’s primary repo.' },
    )
    await advanceTo(client, task, 'design')
    const designLead = await lead(client, task)
    await designLead.call('POST', `/tasks/${task.id}/brief`, { text: brief })
    const proposed = await designLead.call('POST', `/tasks/${task.id}/outcome`, {
      outcome: 'advance',
      design: {
        title: 'Setup',
        setup: {
          workflow: [{ stage: 'design', setting: 'Sign-off on' }],
          checks: [],
          apps: [],
          files: [{ path: '.ted/workflow.yaml', about: 'Workflow' }],
        },
      },
    })
    expect(proposed.status).toBe(200)
    await activate()
    expect((await getTask(client, task.id)).stage).toBe('design')
    expect(await gateRequests(client, task)).toHaveLength(1)
    const current = await getTask(client, task.id)
    expect(JSON.stringify(await client.getRun(current.leadRunId ?? ''))).toContain(
      'Setup questions, rounds and sign-offs wait for the user',
    )
  },
)
