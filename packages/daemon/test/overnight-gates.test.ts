import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type CheckRun,
  type Factory,
  type FactoryBoard,
  type FactorySettingsView,
  type FailureCase,
  type InboxItem,
  type LibraryView,
  type Task,
  type TaskGates,
  tedPaths,
} from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { loadRunTokens } from '../src/run-token.ts'
import { api, waitUntil } from './helpers.ts'
import {
  branchHead,
  brief,
  type Client,
  commitStep,
  ctx,
  getTask,
  lines,
  merges,
  readGh,
  run,
  setGh,
  start,
  useMergeHarness,
  waitForStage,
} from './merge-harness.ts'

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

const settingsStep = {
  run: [
    'sh',
    '-c',
    'echo "# reviewed" >> .ted/workflow.yaml && git add .ted && git -c user.name=T -c user.email=t@example.com commit -qm settings',
  ],
}

async function begin(
  client: Client,
  extra: Record<string, unknown> = {},
  step: unknown = commitStep,
): Promise<Task> {
  const task = await client.ok<Task>('POST', '/tasks', {
    title: JSON.stringify({
      steps: [{ everyMessage: [{ endTurn: true }] }, step, { endTurn: true }],
    }),
    factory: 'NB',
    ...extra,
  })
  const { overnightMode } = await client.ok<{ overnightMode: boolean }>('GET', '/settings')
  if (!overnightMode) await client.ok('POST', `/tasks/${task.id}/start`)
  return task
}

async function lead(client: Client, task: Task) {
  const runId = await waitUntil(async () => {
    const { leadRunId } = await getTask(client, task.id)
    if (!leadRunId) return undefined
    return (await client.getRun(leadRunId)).run.state === 'idle' ? leadRunId : undefined
  }, 'an idle Task Lead')
  const token = (await loadRunTokens(tedPaths(ctx.home).runTokenKey)).issue(runId)
  return api(ctx.daemon?.port ?? 0, token)
}

async function advance(client: Client, task: Task) {
  const run = await lead(client, task)
  expect((await run.call('POST', `/tasks/${task.id}/brief`, { text: brief })).status).toBe(201)
  return waitUntil(async () => {
    const res = await run.call('POST', `/tasks/${task.id}/outcome`, { outcome: 'advance' })
    return JSON.stringify(res.body).includes('Checks; wait for their results') ? undefined : res
  }, 'the Checks to finish')
}

async function advanceTo(client: Client, task: Task, stage: string) {
  const res = await advance(client, task)
  expect(res.body).toMatchObject({ task: { stage } })
}

const gateRequests = async (client: Client, task: Task) =>
  (await client.ok<InboxItem[]>('GET', '/inbox')).filter(
    (item) => item.task.id === task.id && item.request.gate !== undefined,
  )

const overnight = (client: Client, on: boolean) =>
  client.ok('PATCH', '/settings', { overnightMode: on })

const gates = (client: Client, task: Task) => client.ok<TaskGates>('GET', `/tasks/${task.id}/gates`)

const row = (view: TaskGates, stage: string) => view.rows.find((r) => r.stage === stage)

describe('overnight mode turns Gates off', () => {
  test('a Task with Design, Review and Merge Gates runs to Done with no Gate request', async () => {
    const client = await start(gated)
    await overnight(client, true)
    const task = await begin(client)
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
    expect(thread).toContain('Overnight mode is on, so TED skipped the Design Gate')
    expect(thread).toContain('Overnight mode is on, so TED skipped the Review Gate')
    expect(thread).toContain('Overnight mode is on, so TED skipped the Merge Gate')
  })

  test('a Gate turned on for one Task is off overnight too, the saved choice stays, and turning overnight mode off mid-Task brings back the next Gate', async () => {
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
    expect(await lines(client, task)).toContain(
      'Overnight mode is on, so TED skipped the Work Gate',
    )
    await overnight(client, false)
    expect(row(await gates(client, task), 'review')).toMatchObject({ effective: true })
    expect((await gates(client, task)).overrides).toEqual({ work: true })
    expect((await getTask(client, task.id)).stage).toBe('validate')
    await advanceTo(client, task, 'review')
    const res = await advance(client, task)
    expect(res.body).toMatchObject({
      task: { stage: 'review' },
      message: 'Waiting for the human at the Review Gate. TED sends you their answer.',
    })
    expect((await gateRequests(client, task)).map((item) => item.request.stage)).toEqual(['review'])
  })

  test('with overnight mode off a Task stops at the Design Gate, and a Gate request open when the mode turns on stays open', async () => {
    const client = await start(gated)
    const task = await begin(client)
    await advanceTo(client, task, 'design')
    const res = await advance(client, task)
    expect(res.body).toMatchObject({
      task: { stage: 'design' },
      message: 'Waiting for the human at the Design Gate. TED sends you their answer.',
    })
    expect(await gateRequests(client, task)).toHaveLength(1)
    expect(row(await gates(client, task), 'review')).toMatchObject({ effective: true })
    expect(row(await gates(client, task), 'review')?.overnight).toBeUndefined()
    const [open] = await gateRequests(client, task)
    expect(open?.request.stage).toBe('design')
    await overnight(client, true)
    expect(row(await gates(client, task), 'design')).toMatchObject({ effective: true })
    expect(row(await gates(client, task), 'design')?.overnight).toBeUndefined()
    const again = await advance(client, task)
    expect(again.status).toBe(409)
    expect(JSON.stringify(again.body)).toContain('already waiting at the Design Gate')
    expect((await getTask(client, task.id)).stage).toBe('design')
    const still = await gateRequests(client, task)
    expect(still.map((item) => item.request.id)).toEqual([open?.request.id])
    expect(still[0]?.request.answer).toBeUndefined()
    await client.ok('POST', `/comments/${open?.request.id}/answer`, { action: 'approve' })
    await waitForStage(client, task, 'work')
  })

  test('the Factory settings, Library and Board reads mark Gates that are off overnight', async () => {
    const client = await start(gated)
    const [factory] = await client.ok<Factory[]>('GET', '/factories')
    const read = async () => {
      const settings = await client.ok<FactorySettingsView>(
        'GET',
        `/factories/${factory?.id}/settings`,
      )
      const library = await client.ok<LibraryView>('GET', '/library')
      const board = await client.ok<FactoryBoard>('GET', `/factories/${factory?.id}/board`)
      const pick = (rows: { id: string; gate: boolean; overnight?: true }[]) =>
        rows
          .filter((r) => r.id === 'design' || r.id === 'work')
          .map(({ id, gate, overnight }) => ({ id, gate, overnight }))
      return [pick(settings.stages), pick(library.stages), pick(board.stages)]
    }
    const off = [
      { id: 'design', gate: true, overnight: undefined },
      { id: 'work', gate: false, overnight: undefined },
    ]
    expect(await read()).toEqual([off, off, off])
    await overnight(client, true)
    const on = [
      { id: 'design', gate: true, overnight: true },
      { id: 'work', gate: false, overnight: undefined },
    ]
    expect(await read()).toEqual([on, on, on])
  })
})

async function verifyCurrent(client: Client, task: Task) {
  const token = await lead(client, task)
  const id = await waitUntil(async () => {
    const response = await token.call('POST', `/tasks/${task.id}/checks`, {})
    if (response.status === 409 && JSON.stringify(response.body).includes('already moving'))
      return undefined
    expect(response.status, JSON.stringify(response.body)).toBe(201)
    return (response.body as CheckRun).id
  }, 'start current coverage when the merge watcher releases the Task')
  await waitUntil(async () => {
    const runs = await client.ok<CheckRun[]>('GET', `/tasks/${task.id}/check-runs`)
    return runs.find((r) => r.id === id)?.outcome === 'passed'
  }, 'fresh coverage for the changed worktree')
}

describe('overnight mode and a Task that changes .ted/', () => {
  const open = { order: 'intake, work, validate, merge' }
  const kept = (stage: string) =>
    `Overnight mode is on, but this Task changes .ted/, so its ${stage} Gate stays on`

  test('with every Gate off in the Workflow, it stops for the human before Merge', async () => {
    const client = await start(open)
    await overnight(client, true)
    const task = await begin(client, {}, settingsStep)
    await advanceTo(client, task, 'work')
    await advanceTo(client, task, 'validate')
    await advanceTo(client, task, 'review')
    const res = await advance(client, task)
    expect(res.body).toMatchObject({
      task: { stage: 'review' },
      message: 'Waiting for the human at the Review Gate. TED sends you their answer.',
    })
    const [request] = await gateRequests(client, task)
    expect(request?.request.stage).toBe('review')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(await merges()).toEqual([])
    expect(await lines(client, task)).toContain(kept('Review'))
    const view = await gates(client, task)
    expect(row(view, 'review')).toMatchObject({ effective: true, required: true })
    expect(view.rows.some((r) => r.overnight)).toBe(false)

    await client.ok('POST', `/comments/${request?.request.id}/answer`, { action: 'approve' })
    const done = await waitForStage(client, task, 'done')
    expect(done.repos[0]?.pullRequest?.state).toBe('merged')
    expect(await merges()).toHaveLength(1)
  })

  test('the same Task that only edits other files runs to Done unattended', async () => {
    const client = await start(open)
    await overnight(client, true)
    const task = await begin(client)
    await advanceTo(client, task, 'work')
    await advanceTo(client, task, 'validate')
    await advanceTo(client, task, 'merge')
    const done = await waitForStage(client, task, 'done')
    expect(done.repos[0]?.pullRequest?.state).toBe('merged')
    expect(await gateRequests(client, task)).toEqual([])
    const all = await client.ok<{ gate?: unknown }[]>('GET', `/tasks/${task.id}/comments`)
    expect(all.filter((c) => c.gate !== undefined)).toEqual([])
  })

  test('a Design Gate saved in the Workflow stays on for it', async () => {
    const client = await start(gated)
    await overnight(client, true)
    const task = await begin(client, {}, settingsStep)
    await advanceTo(client, task, 'design')
    const view = await gates(client, task)
    expect(row(view, 'design')).toMatchObject({ inherited: true, effective: true })
    expect(view.rows.some((r) => r.overnight)).toBe(false)
    const res = await advance(client, task)
    expect(res.body).toMatchObject({
      task: { stage: 'design' },
      message: 'Waiting for the human at the Design Gate. TED sends you their answer.',
    })
    expect(await lines(client, task)).toContain(kept('Design'))
  })

  test('a worktree TED can’t read keeps the Gates on', async () => {
    const client = await start(gated)
    await overnight(client, true)
    const task = await begin(client)
    await advanceTo(client, task, 'design')
    await lead(client, task)
    const worktree = (await getTask(client, task.id)).repos[0]?.worktree ?? ''
    await rm(path.join(worktree, '.git'), { force: true })
    const res = await advance(client, task)
    expect(res.body).toMatchObject({
      task: { stage: 'design' },
      message: 'Waiting for the human at the Design Gate. TED sends you their answer.',
    })
    expect(await lines(client, task)).toContain(
      'Overnight mode is on, but TED couldn’t read this Task’s changes, so its Design Gate stays on',
    )
  })

  const ci = { '.github/workflows/ci.yml': 'on: pull_request\n' }
  const pending = { checks: [{ name: 'test', status: 'IN_PROGRESS' }] }
  const passed = { checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] }
  const waitingForCi = (client: Client, task: Task) =>
    waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current.stage === 'merge' && current.status?.kind === 'waiting-for-github'
        ? current
        : undefined
    }, 'Waiting for CI')
  const lateSettingsCommit = (worktree: string) =>
    run('sh', ['-c', settingsStep.run[2] ?? ''], { cwd: worktree })
  const mergeCard = (client: Client, task: Task) =>
    waitUntil(
      async () => (await gateRequests(client, task)).find((i) => i.request.stage === 'merge'),
      'the Merge sign-off',
    )

  test('a .ted/ commit made after the Review approval is not merged without a new sign-off', async () => {
    const client = await start({ ...open, files: ci, merge: pending })
    await overnight(client, true)
    const task = await begin(client, {}, settingsStep)
    await advanceTo(client, task, 'work')
    await advanceTo(client, task, 'validate')
    await advanceTo(client, task, 'review')
    await advance(client, task)
    const [review] = await gateRequests(client, task)
    await client.ok('POST', `/comments/${review?.request.id}/answer`, { action: 'approve' })
    const waiting = await waitingForCi(client, task)
    const repo = waiting.repos[0]
    const reviewed = repo?.pullRequest?.signedOff
    expect(reviewed).toBeDefined()
    await lateSettingsCommit(repo?.worktree ?? '')
    await verifyCurrent(client, task)

    await setGh(passed)
    const card = await mergeCard(client, task)
    expect(await merges()).toEqual([])
    expect(await lines(client, task)).toContain(kept('Merge'))

    await client.ok('POST', `/comments/${card.request.id}/answer`, { action: 'approve' })
    const done = await waitForStage(client, task, 'done')
    expect(done.repos[0]?.pullRequest?.state).toBe('merged')
    expect(await merges()).toHaveLength(1)
    expect(await branchHead(repo?.branch ?? '')).toBe(reviewed)
  })

  test('a .ted/ commit that appears after the Task entered Merge holds the merge for sign-off', async () => {
    const client = await start({ ...open, files: ci, merge: pending })
    await overnight(client, true)
    const task = await begin(client)
    await advanceTo(client, task, 'work')
    await advanceTo(client, task, 'validate')
    await advanceTo(client, task, 'merge')
    const waiting = await waitingForCi(client, task)
    expect(await gateRequests(client, task)).toEqual([])
    await lateSettingsCommit(waiting.repos[0]?.worktree ?? '')
    await verifyCurrent(client, task)

    await setGh(passed)
    const card = await mergeCard(client, task)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await merges()).toEqual([])
    expect((await getTask(client, task.id)).stage).toBe('merge')
    expect(await lines(client, task)).toContain(kept('Merge'))

    await client.ok('POST', `/comments/${card.request.id}/answer`, { action: 'approve' })
    await waitForStage(client, task, 'done')
    expect(await merges()).toHaveLength(1)
  })

  const plainMerges = async () =>
    (await merges()).filter((m) => !m.includes('--auto') && !m.includes('--disable-auto'))

  test('GitHub auto-merge is turned off when a .ted/ commit appears while CI is pending', async () => {
    const client = await start({
      ...open,
      files: ci,
      merge: {
        mergeState: 'BLOCKED',
        autoMergeAllowed: true,
        checks: [{ name: 'test', status: 'IN_PROGRESS', required: true }],
      },
    })
    await overnight(client, true)
    const task = await begin(client)
    await advanceTo(client, task, 'work')
    await advanceTo(client, task, 'validate')
    await advanceTo(client, task, 'merge')
    const auto = await waitUntil(async () => {
      const current = await getTask(client, task.id)
      return current.repos[0]?.pullRequest?.autoMerge ? current : undefined
    }, 'auto-merge to be on')
    expect((await readGh()).merge.autoMerge).toBeDefined()
    await lateSettingsCommit(auto.repos[0]?.worktree ?? '')

    await waitUntil(
      async () => (await readGh()).merge.autoMerge === undefined,
      'auto-merge to be turned off',
    )
    expect((await merges()).at(-1)).toContain('--disable-auto')
    await waitUntil(
      async () =>
        (await getTask(client, task.id)).repos[0]?.pullRequest?.autoMerge === undefined ||
        undefined,
      'the Task to record auto-merge as off',
    )

    await verifyCurrent(client, task)
    await setGh({
      mergeState: 'CLEAN',
      checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', required: true }],
    })
    await mergeCard(client, task)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await plainMerges()).toEqual([])
    expect((await readGh()).merge.autoMerge).toBeUndefined()
    expect((await getTask(client, task.id)).stage).toBe('merge')
  })

  test('a .ted/ commit that lands right before the merge call still gets a Merge sign-off', async () => {
    const flip = { worktree: '', done: false }
    const client = await start({
      ...open,
      files: ci,
      merge: pending,
      daemon: {
        beforeMerge: async () => {
          if (flip.worktree === '' || flip.done) return
          flip.done = true
          await lateSettingsCommit(flip.worktree)
        },
      },
    })
    await overnight(client, true)
    const task = await begin(client)
    await advanceTo(client, task, 'work')
    await advanceTo(client, task, 'validate')
    await advanceTo(client, task, 'merge')
    const waiting = await waitingForCi(client, task)
    flip.worktree = waiting.repos[0]?.worktree ?? ''

    await setGh(passed)
    await waitUntil(async () => flip.done, 'late settings edit before the merge')
    await verifyCurrent(client, task)
    await mergeCard(client, task)
    expect(flip.done).toBe(true)
    expect(await merges()).toEqual([])
    expect((await getTask(client, task.id)).stage).toBe('merge')
  })

  test('an uncommitted .ted/ edit made at Merge holds the merge for sign-off', async () => {
    const client = await start({ ...open, files: ci, merge: pending })
    await overnight(client, true)
    const task = await begin(client)
    await advanceTo(client, task, 'work')
    await advanceTo(client, task, 'validate')
    await advanceTo(client, task, 'merge')
    const waiting = await waitingForCi(client, task)
    await new Promise((resolve) => setTimeout(resolve, 300))
    await writeFile(path.join(waiting.repos[0]?.worktree ?? '', '.ted', 'notes.md'), 'Edited.\n')
    await verifyCurrent(client, task)

    await setGh(passed)
    await mergeCard(client, task)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await merges()).toEqual([])
    expect(await lines(client, task)).toContain(kept('Merge'))
  })

  test('a Review approval given after the worktree moved on binds nothing', async () => {
    const client = await start(open)
    await overnight(client, true)
    const task = await begin(client, {}, settingsStep)
    await advanceTo(client, task, 'work')
    await advanceTo(client, task, 'validate')
    await advanceTo(client, task, 'review')
    await advance(client, task)
    const [review] = await gateRequests(client, task)
    await waitUntil(
      async () => (await getTask(client, task.id)).repos[0]?.pullRequest?.state === 'ready',
      'the pull request to be ready',
    )
    const repo = (await getTask(client, task.id)).repos[0]
    const requested = repo?.pushed?.commit
    await lateSettingsCommit(repo?.worktree ?? '')
    await verifyCurrent(client, task)

    await client.ok('POST', `/comments/${review?.request.id}/answer`, { action: 'approve' })
    const card = await mergeCard(client, task)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await merges()).toEqual([])
    const listed = (await getTask(client, task.id)).repos[0]?.pullRequest?.signedOff
    expect(listed).toBe(requested)

    await client.ok('POST', `/comments/${card.request.id}/answer`, { action: 'approve' })
    await waitForStage(client, task, 'done')
    expect(await merges()).toHaveLength(1)
    expect(await branchHead(repo?.branch ?? '')).toBe(listed)
  })

  test('verified failure history cannot delay disabling auto-merge for a late settings edit', async () => {
    const client = await start({
      ...open,
      files: ci,
      workflow: [
        'stages:',
        '  validate:',
        '    checks:',
        '      - { name: Tests, run: "if [ -e stub-retried ]; then exit 0; else touch stub-retried; exit 1; fi" }',
      ],
      merge: {
        mergeState: 'BLOCKED',
        autoMergeAllowed: true,
        checks: [{ name: 'test', status: 'IN_PROGRESS', required: true }],
      },
    })
    await overnight(client, true)
    const task = await begin(client)
    await advanceTo(client, task, 'work')
    await advanceTo(client, task, 'validate')
    const token = await lead(client, task)
    const post = async <T>(route: string, body = {}): Promise<T> => {
      const res = await token.call('POST', `/tasks/${task.id}${route}`, body)
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300)
      return res.body as T
    }
    const finding = await waitUntil(
      async () => (await client.ok<FailureCase[]>('GET', `/tasks/${task.id}/failures`)).at(-1),
      'failed Check recorded',
    )
    await post(`/failures/${finding.id}/assessments`, {
      assessment: 'uncertain',
      recommendation: 'Retry the transient fixture failure.',
    })
    const asked = await post<FailureCase>(`/failures/${finding.id}/decision`)
    await client.ok('POST', `/comments/${asked.decisions.at(-1)?.commentId}/answer`, {
      action: 'answer',
      choice: 'Retry',
    })
    await waitUntil(
      async () =>
        (await client.ok<{ satisfied: boolean }>('GET', `/tasks/${task.id}/validation-obligations`))
          .satisfied,
      'retry verifies the historical failure',
    )
    await advanceTo(client, task, 'merge')
    const auto = await waitUntil(async () => {
      const value = await getTask(client, task.id)
      return value.repos[0]?.pullRequest?.autoMerge ? value : undefined
    }, 'auto-merge enabled')
    await lateSettingsCommit(auto.repos[0]?.worktree ?? '')
    await waitUntil(
      async () => (await readGh()).merge.autoMerge === undefined,
      'auto-merge disabled despite verified failure history',
    )
    expect((await merges()).at(-1)).toContain('--disable-auto')
    const obligations = await client.ok<{ satisfied: boolean }>(
      'GET',
      `/tasks/${task.id}/validation-obligations`,
    )
    expect(obligations.satisfied).toBe(false)
    expect(await plainMerges()).toEqual([])
  })
})
