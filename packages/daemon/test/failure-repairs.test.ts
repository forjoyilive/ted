import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  CheckRun,
  Comment,
  FailureCase,
  FailureContext,
  Task,
  TaskBrief,
  ValidationObligations,
} from '@ted/protocol'
import { tedPaths } from '@ted/protocol'
import { shortReference } from '@ted/protocol/reference'
import { expect, test } from 'vitest'
import { loadRunTokens } from '../src/run-token.ts'
import { api, waitUntil } from './helpers.ts'
import {
  approve,
  ctx,
  getTask,
  leadSteps,
  reviewSignoff,
  run,
  start,
  toSignoff,
  useMergeHarness,
} from './merge-harness.ts'

useMergeHarness()

const validateWaitMs = 60_000

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing test fixture')
  return value
}

async function begin(check = false, command = 'test -f timezone.txt') {
  const client = await start({
    ...(check && {
      workflow: [
        'stages:',
        '  validate:',
        '    checks:',
        `      - { name: Export, run: ${JSON.stringify(command)} }`,
      ],
    }),
    order: 'intake, validate, work, review, merge',
  })
  const gh = JSON.parse(await readFile(ctx.ghState, 'utf8'))
  const { writeFile } = await import('node:fs/promises')
  await writeFile(ctx.ghState, JSON.stringify({ ...gh, pr: { numbered: true } }))
  const task = await client.ok<Task>('POST', '/tasks', {
    title: JSON.stringify({
      steps: [
        { everyMessage: [{ endTurn: true }] },
        {
          run: [
            'sh',
            '-c',
            '[ -f source-change.txt ] || (echo change > source-change.txt && git add source-change.txt && git -c user.name=T -c user.email=t@example.com commit -qm change)',
          ],
        },
        { run: ['ted', 'outcome', 'advance'] },
        { endTurn: true },
      ],
    }),
    factory: 'NB',
    start: true,
  })
  return { client, task, check }
}

async function decide({ client, task, check }: Awaited<ReturnType<typeof begin>>) {
  let last: unknown
  const current = await waitUntil(
    async () => {
      const value = await getTask(client, task.id)
      const recorded =
        !check ||
        (await client.ok<FailureCase[]>('GET', `/tasks/${task.id}/failures`)).some(
          (f) => f.source.kind === 'factory-check',
        )
      const ready = {
        validate: value.stage === 'validate',
        idle: value.runs.find((run) => run.id === value.leadRunId)?.state === 'idle',
        published:
          value.repos.length > 0 && value.repos.every((repo) => repo.pullRequest && repo.pushed),
        recorded,
        settled: !value.statuses.includes('working'),
      }
      last = { ...ready, stage: value.stage, runs: value.runs, repos: value.repos }
      return Object.values(ready).every(Boolean) ? value : undefined
    },
    'idle Validate Lead, published revision and failure evidence',
    validateWaitMs,
  ).catch((error: unknown) => {
    throw new Error(`${String(error)}; last setup state: ${JSON.stringify(last)}`)
  })
  const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
  const lead = api(required(ctx.daemon).port, tokens.issue(required(current.leadRunId)))
  const root = `/tasks/${task.id}`
  const post = async <T>(suffix: string, body: unknown = {}): Promise<T> => {
    const result = await lead.call('POST', root + suffix, body)
    expect(result.status, JSON.stringify(result.body)).toBeLessThan(300)
    return result.body as T
  }
  const context = await post<FailureContext>('/failure-contexts')
  const existing = await client.ok<FailureCase[]>('GET', `${root}/failures`)
  const failure =
    existing[0] ??
    (await post<FailureCase>('/failures', {
      source: { kind: 'finding', runId: current.leadRunId, finding: 'Export timezone missing' },
      evidence: 'Reproduced on the default branch',
      contextId: context.id,
    }))
  await post(`/failures/${failure.id}/assessments`, {
    assessment: 'unrelated',
    recommendation: 'Wait for export repair',
  })
  const asked = await post<FailureCase>(`/failures/${failure.id}/decision`)
  const requestId = required(asked.decisions.at(-1)).commentId
  const resolve = (repair: unknown) =>
    client.call('POST', `${root}/failures/${failure.id}/resolve`, {
      requestId,
      resolution: 'repair',
      repair,
    })
  return { client, current, lead, root, failure, requestId, resolve }
}

const setup = async (check = false) => decide(await begin(check))

test('approved repair creation is idempotent, stops the Lead and retains failure and worktree', async () => {
  const s = await setup()
  const repair = {
    kind: 'new',
    title: 'Repair export timezone',
    description: 'Restore timezone labels; export Check must pass.',
    start: false,
  }
  const repo = required(s.current.repos[0])
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path.join(repo.worktree, 'source-change.txt'), 'Keep this local edit\n')
  const line = await s.client.ok<{ id: string }>('POST', `${s.root}/line-comments`, {
    repo: repo.name,
    path: 'source-change.txt',
    from: { new: 1 },
    to: { new: 1 },
    body: 'Preserve this behavior after the repair.',
  })
  const before = await s.client.ok<Task[]>('GET', '/tasks')
  expect(before).toHaveLength(1)
  expect(
    (
      await s.lead.call('POST', `${s.root}/failures/${s.failure.id}/resolve`, {
        requestId: s.requestId,
        resolution: 'repair',
        repair,
      })
    ).status,
  ).toBe(403)
  const results = await Promise.all([s.resolve(repair), s.resolve(repair)])
  expect(results.map((r) => r.status)).toEqual([200, 200])
  const after = await s.client.ok<Task[]>('GET', '/tasks')
  expect(after).toHaveLength(2)
  const created = required(after.find((t) => t.id !== s.current.id))
  expect(created).toMatchObject({ title: repair.title, stage: 'backlog' })
  expect(created.followUpOf).toBeUndefined()
  const waiting = await waitUntil(async () => {
    const t = await getTask(s.client, s.current.id)
    return t.runs.every((r) => r.state === 'finished') ? t : undefined
  }, 'repair wait to release the Lead')
  expect(waiting).toMatchObject({ stage: 'validate', blockedBy: [created.id] })
  expect(waiting.repos[0]?.worktree).toBe(s.current.repos[0]?.worktree)
  expect(await readFile(path.join(repo.worktree, 'source-change.txt'), 'utf8')).toBe(
    'Keep this local edit\n',
  )
  expect(
    (await s.client.ok<ValidationObligations>('GET', `${s.root}/validation-obligations`)).satisfied,
  ).toBe(false)
  const stored = await s.client.ok<FailureCase[]>('GET', `${s.root}/failures`)
  expect(stored[0]).toMatchObject({
    evidence: s.failure.evidence,
    contextId: s.failure.contextId,
    resolutions: [
      { resolution: 'repair', repairTask: { id: created.id, displayId: created.displayId } },
    ],
  })
  const comments = await s.client.ok<Comment[]>('GET', `${s.root}/comments`)
  expect(comments.find((c) => c.id === s.requestId)?.lineComments?.map((c) => c.id)).toContain(
    line.id,
  )
  expect(comments.find((c) => c.id === s.requestId)?.answer).toMatchObject({
    kind: 'answered',
    choice: 'Wait for a repair Task',
  })
  const brief = await s.client.ok<TaskBrief>('GET', `${s.root}/brief`)
  expect(brief.text).toContain(created.displayId)
  expect(brief.text).toContain(shortReference(s.failure.id))
  expect((await s.resolve({ ...repair, title: 'Different repair' })).status).toBe(409)
})

test('existing repair selection refuses self and cycles, leaves Backlog alone, and survives restart', async () => {
  const s = await setup()
  const repair = await s.client.ok<Task>('POST', '/tasks', {
    factory: 'NB',
    title: 'Existing repair',
  })
  expect((await s.resolve({ kind: 'existing', taskId: s.current.id })).status).toBe(409)
  await s.client.ok('POST', `/tasks/${repair.id}/blockers`, { by: s.current.id })
  expect((await s.resolve({ kind: 'existing', taskId: repair.id })).status).toBe(409)
  await s.client.ok('DELETE', `/tasks/${repair.id}/blockers/${s.current.id}`)
  expect((await s.resolve({ kind: 'existing', taskId: repair.id })).status).toBe(200)
  expect((await getTask(s.client, repair.id)).stage).toBe('backlog')
  await required(ctx.daemon).stop()
  const { startDaemon } = await import('../src/index.ts')
  const { stubClaudePath } = await import('./helpers.ts')
  ctx.daemon = await startDaemon({ home: ctx.home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(ctx.daemon.port, { appKey: ctx.daemon.appToken })
  const waiting = await waitUntil(async () => {
    const tasks = (await client.call('GET', '/tasks')).body as Task[]
    const task = tasks.find((t) => t.id === s.current.id)
    return task?.runs.every((r) => r.state === 'finished') ? task : undefined
  }, 'persisted repair wait to finish stopping its Lead')
  expect(waiting.stage).toBe('validate')
  expect(waiting.blockedBy).toEqual([repair.id])
  expect(waiting.runs.every((r) => r.state === 'finished')).toBe(true)
  expect((await client.call('GET', `${s.root}/validation-obligations`)).body).toMatchObject({
    satisfied: false,
  })
  const repeat = await client.call('POST', `${s.root}/failures/${s.failure.id}/resolve`, {
    requestId: s.requestId,
    resolution: 'repair',
    repair: { kind: 'existing', taskId: repair.id },
  })
  expect(repeat.status, JSON.stringify(repeat.body)).toBe(200)
  const history = (await client.call('GET', `${s.root}/failures`)).body as FailureCase[]
  expect(history[0]?.resolutions[0]?.repairTask).toEqual({
    id: repair.id,
    displayId: repair.displayId,
    title: repair.title,
  })
  expect((await client.call('GET', '/tasks')).body as Task[]).toHaveLength(2)
})

test.each(['archive', 'delete'] as const)(
  '%s of a repair never passes the failure and records why continuation stopped',
  async (action) => {
    const s = await setup()
    const repair = await s.client.ok<Task>('POST', '/tasks', {
      factory: 'NB',
      title: 'Temporary repair',
    })
    expect((await s.resolve({ kind: 'existing', taskId: repair.id })).status).toBe(200)
    if (action === 'archive')
      await s.client.ok('POST', `/tasks/${repair.id}/archive`, { blocked: 'unblock' })
    else {
      const { DaemonClient } = await import('@ted/protocol')
      await new DaemonClient(
        { port: required(ctx.daemon).port, token: '', pid: 0, version: 'test' },
        '',
        {
          appKey: required(ctx.daemon).appToken,
        },
      ).deleteTask(repair.id, { blocked: 'unblock' })
    }
    const affected = await getTask(s.client, s.current.id)
    expect(affected.status?.kind).toBe('stopped')
    expect(affected.stage).toBe('validate')
    expect(affected.blockedBy).toEqual([])
    expect(
      (await s.client.ok<ValidationObligations>('GET', `${s.root}/validation-obligations`))
        .satisfied,
    ).toBe(false)
    const brief = await s.client.ok<TaskBrief>('GET', `${s.root}/brief`)
    expect(brief.text).toContain(action === 'archive' ? 'archived' : 'deleted')
    expect(brief.text).toContain('without merging')
    expect(brief.text).toContain(repair.displayId)
  },
)

test.each([
  'merge',
  'squash',
  'replaced-check',
  'dirty-worktree',
  'conflict',
  'failed-repair',
] as const)(
  'a %s repair is incorporated before fresh Checks, with the original failure retained',
  async (method) => {
    const begun = await begin(
      true,
      method === 'failed-repair'
        ? 'test ! -f source-change.txt || test -f timezone.txt'
        : undefined,
    )
    const { client } = begun
    const repairedFile = method === 'failed-repair' ? 'unrelated.txt' : 'timezone.txt'
    const script = [
      `echo restored > ${repairedFile}`,
      ...(method === 'replaced-check'
        ? [
            "sed 's/name: Export/name: NewExport/' .ted/workflow.yaml > .ted/replacement",
            'mv .ted/replacement .ted/workflow.yaml',
          ]
        : []),
      `git add ${repairedFile} .ted/workflow.yaml`,
      'git -c user.name=T -c user.email=t@example.com commit -qm repair',
    ].join(' && ')
    const each = [
      {
        run: ['sh', '-c', `ted brief write --file '${client.briefFile}' && ted outcome advance`],
      },
      { endTurn: true },
    ]
    const steps = {
      steps: [
        { run: ['sh', '-c', script] },
        { everyMessage: each },
        { run: ['ted', 'outcome', 'advance'] },
        { endTurn: true },
      ],
    }
    const [s, { task: repair, signoff }] = await Promise.all([
      decide(begun),
      toSignoff(client, { title: JSON.stringify(steps) }),
    ])
    expect((await s.resolve({ kind: 'existing', taskId: repair.id })).status).toBe(200)
    const state = JSON.parse(await readFile(ctx.ghState, 'utf8'))
    const repairRepo = required((await getTask(s.client, repair.id)).repos[0])
    state.merge.prs = {
      ...state.merge.prs,
      [required(repairRepo.pullRequest).number]: { origin: ctx.origin, updateBase: true },
    }
    const { writeFile } = await import('node:fs/promises')
    await writeFile(ctx.ghState, JSON.stringify(state))
    const affectedWorktree = required(s.current.repos[0]).worktree
    if (method === 'dirty-worktree')
      await writeFile(path.join(affectedWorktree, 'local-draft.txt'), 'Keep this draft\n')
    if (method === 'conflict') {
      await writeFile(path.join(affectedWorktree, 'timezone.txt'), 'Conflicting local work\n')
      await run('git', ['add', 'timezone.txt'], { cwd: affectedWorktree })
      await run(
        'git',
        ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'local work'],
        { cwd: affectedWorktree },
      )
    }
    const previousChecks = await s.client.ok<{ id: string }[]>('GET', `${s.root}/check-runs`)
    if (method === 'squash') {
      const entered = path.join(ctx.scratch, 'merge-entered')
      const release = path.join(ctx.scratch, 'merge-release')
      const number = required(repairRepo.pullRequest).number
      state.merge.prs[number].updateBase = false
      state.mergeGate = { entered, release }
      await writeFile(ctx.ghState, JSON.stringify(state))
      const approval = approve(s.client, signoff)
      try {
        await waitUntil(() => readFile(entered, 'utf8').catch(() => undefined), 'repair merge held')
        const head = (
          await run('git', ['rev-parse', `refs/heads/${repairRepo.branch}`], { cwd: ctx.origin })
        ).stdout.trim()
        const tree = (
          await run('git', ['rev-parse', `${head}^{tree}`], { cwd: ctx.origin })
        ).stdout.trim()
        const base = (
          await run('git', ['rev-parse', 'refs/heads/main'], { cwd: ctx.origin })
        ).stdout.trim()
        const squashed = (
          await run(
            'git',
            [
              '-c',
              'user.name=T',
              '-c',
              'user.email=t@example.com',
              'commit-tree',
              tree,
              '-p',
              base,
              '-m',
              'Squashed repair',
            ],
            { cwd: ctx.origin },
          )
        ).stdout.trim()
        expect(squashed).not.toBe(head)
        await run('git', ['update-ref', 'refs/heads/main', squashed], { cwd: ctx.origin })
      } finally {
        await writeFile(release, '')
      }
      await approval
    } else await approve(s.client, signoff)
    await waitUntil(
      async () => (await getTask(s.client, repair.id)).stage === 'done',
      'repair merge',
    )
    if (method === 'dirty-worktree' || method === 'conflict') {
      const held = await waitUntil(async () => {
        const t = await getTask(s.client, s.current.id)
        return t.status?.kind === 'stopped' ? t : undefined
      }, 'unsafe incorporation held')
      expect(held.stage).toBe('validate')
      expect(await s.client.ok('GET', `${s.root}/check-runs`)).toHaveLength(previousChecks.length)
      const history = await s.client.ok<FailureCase[]>('GET', `${s.root}/failures`)
      expect(history[0]?.repairProgress).toBeUndefined()
      expect((await s.client.ok<TaskBrief>('GET', `${s.root}/brief`)).text).toContain(
        'incorporation is held',
      )
      if (method === 'conflict') {
        expect(await readFile(path.join(affectedWorktree, 'timezone.txt'), 'utf8')).toBe(
          'Conflicting local work\n',
        )
        return
      }
      const { rm } = await import('node:fs/promises')
      expect(await readFile(path.join(affectedWorktree, 'local-draft.txt'), 'utf8')).toBe(
        'Keep this draft\n',
      )
      await rm(path.join(affectedWorktree, 'local-draft.txt'))
      await s.client.ok('POST', `${s.root}/resume`, {})
    }
    if (method === 'failed-repair') {
      const result = await waitUntil(async () => {
        const history = await s.client.ok<FailureCase[]>('GET', `${s.root}/failures`)
        return history.length > 1 &&
          history.find((f) => f.id === s.failure.id)?.verifications?.at(-1)?.replacedBy
          ? history
          : undefined
      }, 'fresh failure after an ineffective repair')
      const original = result.find((f) => f.id === s.failure.id)
      const replacement = result.find((f) => f.id !== s.failure.id)
      expect(original?.verifications?.at(-1)?.replacedBy).toBe(replacement?.id)
      expect(original?.originalCheck?.state).toBe('failed')
      expect(
        (await s.client.ok<ValidationObligations>('GET', `${s.root}/validation-obligations`))
          .satisfied,
      ).toBe(false)
      return
    }
    if (method === 'replaced-check') {
      await waitUntil(async () => {
        const result = await s.client.ok<ValidationObligations>(
          'GET',
          `${s.root}/validation-obligations`,
        )
        return result.progress?.checks.some((c) => c.name === 'NewExport' && c.state === 'passed')
          ? result
          : undefined
      }, 'fresh replacement Check coverage')
      const affected = await getTask(s.client, s.current.id)
      const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
      const lead = api(required(ctx.daemon).port, tokens.issue(required(affected.leadRunId)))
      const verified = await lead.call('POST', `${s.root}/failures/${s.failure.id}/verification`, {
        evidence: 'The approved repair replaced Export with NewExport; its fresh execution passed.',
      })
      expect(verified.status, JSON.stringify(verified.body)).toBe(200)
    }
    await waitUntil(async () => {
      const failures = await s.client.ok<FailureCase[]>('GET', `${s.root}/failures`)
      return failures[0]?.verifications?.length ? failures : undefined
    }, 'fresh Check verifying the repair')
    expect(
      await readFile(path.join(required(s.current.repos[0]).worktree, 'timezone.txt'), 'utf8'),
    ).toBe('restored\n')
    const failures = await s.client.ok<FailureCase[]>('GET', `${s.root}/failures`)
    expect(failures[0]?.originalCheck?.state).toBe('failed')
    expect(failures[0]?.resolutions[0]?.repairTask?.id).toBe(repair.id)
    const checks = await s.client.ok<{ id: string; outcome: string }[]>(
      'GET',
      `${s.root}/check-runs`,
    )
    expect(checks.some((c) => c.outcome === 'passed')).toBe(true)
    expect(new Set(checks.map((c) => c.id)).size).toBeGreaterThan(1)
  },
  90_000,
)

test('approving a queued repair releases a single working-Run slot for ordinary repair work', async () => {
  const s = await setup()
  await s.client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
  const selected = {
    kind: 'new',
    title: JSON.stringify({ steps: [{ waitFor: path.join(ctx.scratch, 'release-repair') }] }),
    description: 'Repair the reported failure.',
    start: true,
  }
  expect((await s.resolve(selected)).status).toBe(200)
  const repair = await waitUntil(async () => {
    const tasks = await s.client.ok<Task[]>('GET', '/tasks')
    const t = tasks.find((t) => t.id !== s.current.id)
    return t?.runs[0]?.state === 'working' ? t : undefined
  }, 'ordinary repair Run in the released slot')
  expect(repair.stage).toBe('intake')
  const slots = await s.client.ok<{ working: number; holders: { taskId: string }[] }>(
    'GET',
    '/slots',
  )
  expect(slots.working).toBe(1)
  expect((await getTask(s.client, s.current.id)).runs.every((r) => r.state === 'finished')).toBe(
    true,
  )
})

test.each(['archive', 'delete'] as const)(
  '%s with blocker kept preserves waiting and the original repair identity',
  async (action) => {
    const s = await setup()
    const repair = await s.client.ok<Task>('POST', '/tasks', {
      factory: 'NB',
      title: 'Kept repair',
    })
    expect((await s.resolve({ kind: 'existing', taskId: repair.id })).status).toBe(200)
    if (action === 'archive')
      await s.client.ok('POST', `/tasks/${repair.id}/archive`, { blocked: 'keep' })
    else {
      const { DaemonClient } = await import('@ted/protocol')
      await new DaemonClient(
        { port: required(ctx.daemon).port, token: '', pid: 0, version: 'test' },
        '',
        {
          appKey: required(ctx.daemon).appToken,
        },
      ).deleteTask(repair.id, { blocked: 'keep' })
    }
    expect((await getTask(s.client, s.current.id)).blockedBy).toEqual([repair.id])
    const retained = await s.client.ok<FailureCase[]>('GET', `${s.root}/failures`)
    expect(retained[0]?.resolutions[0]?.repairTask).toMatchObject({
      id: repair.id,
      title: 'Kept repair',
    })
    expect((await s.client.ok<TaskBrief>('GET', `${s.root}/brief`)).text).toContain('still waiting')
    await s.client.ok('DELETE', `${s.root}/blockers/${repair.id}`)
    expect((await getTask(s.client, s.current.id)).status?.kind).toBe('stopped')
    expect(
      (await s.client.ok<ValidationObligations>('GET', `${s.root}/validation-obligations`))
        .satisfied,
    ).toBe(false)
  },
)

test('Merge uses the same repair remedy without allowing the Task Lead to advance it', async () => {
  const client = await start({
    merge: { checks: [{ name: 'Build', status: 'IN_PROGRESS', required: true }] },
    workflow: [
      'stages:',
      '  validate:',
      '    checks:',
      '      - { name: Tests, run: "test -f README.md" }',
    ],
  })
  const { writeFile } = await import('node:fs/promises')
  const gh = JSON.parse(await readFile(ctx.ghState, 'utf8'))
  await writeFile(ctx.ghState, JSON.stringify({ ...gh, pr: { numbered: true } }))
  const { task, signoff } = await toSignoff(client, {
    title: leadSteps(
      client,
      '[ -e work.txt ] || (echo change > work.txt && git add work.txt && git -c user.name=T -c user.email=t@example.com commit -qm work)',
    ),
  })
  await approve(client, signoff)
  const current = await waitUntil(async () => {
    const t = await getTask(client, task.id)
    return t.stage === 'merge' && t.runs[0]?.state === 'idle' ? t : undefined
  }, 'Merge lead')
  const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
  const lead = api(required(ctx.daemon).port, tokens.issue(required(current.leadRunId)))
  const root = `/tasks/${task.id}`
  const recorded = await lead.call('POST', `${root}/failures`, {
    source: { kind: 'finding', runId: current.leadRunId, finding: 'Separate environment failure' },
    evidence: 'Reproduced without the Task changes',
  })
  expect(recorded.status).toBe(201)
  const failure = recorded.body as FailureCase
  expect(
    (
      await lead.call('POST', `${root}/failures/${failure.id}/assessments`, {
        assessment: 'unrelated',
        recommendation: 'Wait for a separate repair',
      })
    ).status,
  ).toBe(200)
  const asked = await lead.call('POST', `${root}/failures/${failure.id}/decision`, {})
  expect(asked.status).toBe(201)
  const requestId = required((asked.body as FailureCase).decisions.at(-1)).commentId
  const result = await client.call('POST', `${root}/failures/${failure.id}/resolve`, {
    requestId,
    resolution: 'repair',
    repair: {
      kind: 'new',
      title: 'Repair environment',
      description: 'Repair the separate environment failure and verify it.',
      start: false,
    },
  })
  expect(result.status).toBe(200)
  const waiting = await getTask(client, task.id)
  expect(waiting.stage).toBe('merge')
  expect(waiting.runs.every((r) => r.state === 'finished')).toBe(true)
  expect(waiting.blockedBy).toHaveLength(1)
  expect(
    (await client.ok<ValidationObligations>('GET', `${root}/validation-obligations`)).satisfied,
  ).toBe(false)
  const selected = (result.body as FailureCase).resolutions.at(-1)?.repairTask
  const repairId = required(selected).id
  const each = [
    { run: ['sh', '-c', `ted brief write --file '${client.briefFile}' && ted outcome advance`] },
    { endTurn: true },
  ]
  await client.ok('PUT', `/tasks/${repairId}`, {
    title: JSON.stringify({
      steps: [
        {
          run: [
            'sh',
            '-c',
            'echo restored > timezone.txt && git add timezone.txt && git -c user.name=T -c user.email=t@example.com commit -qm repair',
          ],
        },
        { everyMessage: each },
        { run: ['ted', 'outcome', 'advance'] },
        { endTurn: true },
      ],
    }),
  })
  await client.ok('POST', `/tasks/${repairId}/start`)
  const repairSignoff = await reviewSignoff(client, repairId)
  const repairRepo = required((await getTask(client, repairId)).repos[0])
  const state = JSON.parse(await readFile(ctx.ghState, 'utf8'))
  state.merge.prs = {
    ...state.merge.prs,
    [required(repairRepo.pullRequest).number]: { origin: ctx.origin, updateBase: true, checks: [] },
  }
  await writeFile(ctx.ghState, JSON.stringify(state))
  await approve(client, repairSignoff)
  await waitUntil(
    async () => (await getTask(client, repairId)).stage === 'done',
    'the repair Task to merge',
  )
  const checked = await waitUntil(async () => {
    const history = await client.ok<FailureCase[]>('GET', `${root}/failures`)
    const incorporation = history.find((f) => f.id === failure.id)?.repairProgress?.at(-1)
    const checks = await client.ok<CheckRun[]>('GET', `${root}/check-runs`)
    return incorporation &&
      checks.some(
        (c) => c.trigger === 'merge' && c.outcome === 'passed' && c.startedAt >= incorporation.at,
      )
      ? incorporation
      : undefined
  }, 'fresh Merge Checks after incorporation')
  const resumed = await waitUntil(async () => {
    const t = await getTask(client, task.id)
    return t.runs.find((r) => r.id === t.leadRunId)?.state === 'idle' ? t : undefined
  }, 'replacement Merge lead')
  expect(resumed.stage).toBe('merge')
  expect(resumed.repos[0]?.pullRequest?.signedOff).toBe(current.repos[0]?.pullRequest?.signedOff)
  expect(
    (await run('git', ['show', 'HEAD:timezone.txt'], { cwd: required(resumed.repos[0]).worktree }))
      .stdout,
  ).toBe('restored\n')
  expect(checked.repos).toHaveLength(1)
  const replacement = api(required(ctx.daemon).port, tokens.issue(required(resumed.leadRunId)))
  expect((await replacement.call('POST', `${root}/outcome`, { outcome: 'advance' })).status).toBe(
    409,
  )
  await waitUntil(
    async () => !(await getTask(client, task.id)).statuses.includes('working') || undefined,
    'Ted to finish the Merge Checks before verifying',
  )
  expect(
    (
      await replacement.call('POST', `${root}/failures/${failure.id}/verification`, {
        evidence: 'Reproduced the original environment check after incorporation; it succeeds.',
      })
    ).status,
  ).toBe(200)
  const ready = JSON.parse(await readFile(ctx.ghState, 'utf8'))
  ready.merge.checks = []
  await writeFile(ctx.ghState, JSON.stringify(ready))
  await waitUntil(
    async () => (await getTask(client, task.id)).stage === 'done',
    'original signed-off PR merged',
  )
}, 150_000)
