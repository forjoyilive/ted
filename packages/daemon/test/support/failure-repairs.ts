import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  Comment,
  FailureCase,
  FailureContext,
  Task,
  TaskBrief,
  ValidationObligations,
} from '@ted/protocol'
import { tedPaths } from '@ted/protocol'
import type { Json } from '@ted/protocol/parse'
import { expect } from 'vitest'
import { loadRunTokens } from '../../src/run-token.ts'
import { api, waitUntil } from '../helpers.ts'
import { approve, ctx, getTask, run, start, toSignoff } from '../merge-harness.ts'

const validateWaitMs = 60_000

export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing test fixture')
  return value
}

async function begin(check = false, command = 'test -f timezone.txt', extra: Json[] = []) {
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
        ...extra,
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
  let last: string | undefined
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
        settled: !value.statuses.includes('working') && !value.checksActive,
      }
      last = JSON.stringify({
        ...ready,
        stage: value.stage,
        runs: value.runs,
        repos: value.repos,
      })
      return Object.values(ready).every(Boolean) ? value : undefined
    },
    'idle Validate Lead, published revision and failure evidence',
    validateWaitMs,
  ).catch((error) => {
    throw new Error(`${String(error)}; last setup state: ${last}`)
  })
  const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
  const lead = api(required(ctx.daemon).port, tokens.issue(required(current.leadRunId)))
  const root = `/tasks/${task.id}`
  const post = async <T>(suffix: string, body: Json = {}): Promise<T> => {
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
  const resolve = (repair: Json) =>
    client.call('POST', `${root}/failures/${failure.id}/resolve`, {
      requestId,
      resolution: 'repair',
      repair,
    })
  return { client, current, lead, root, failure, requestId, resolve }
}

export const setup = async (check = false) => decide(await begin(check))

const leadHold = () => path.join(ctx.scratch, 'lead-hold')

const mergeBase = (origin: string) =>
  [
    `git fetch -q ${JSON.stringify(origin)} main`,
    'git -c user.name=T -c user.email=t@example.com merge -q -X theirs --no-edit FETCH_HEAD',
  ].join(' && ')

export type RepairMethod =
  | 'merge'
  | 'squash'
  | 'replaced-check'
  | 'dirty-worktree'
  | 'conflict'
  | 'unresolved-conflict'
  | 'failed-repair'

export const incorporated =
  'a %s repair is incorporated before fresh Checks, with the original failure retained'

export async function incorporates(method: RepairMethod) {
  const conflict = method === 'conflict' || method === 'unresolved-conflict'
  const begun = await begin(
    true,
    method === 'failed-repair' ? 'test ! -f source-change.txt || test -f timezone.txt' : undefined,
    method === 'conflict'
      ? [{ run: ['sh', '-c', mergeBase(ctx.origin)] }]
      : method === 'unresolved-conflict'
        ? [
            {
              run: ['sh', '-c', `while [ -e ${JSON.stringify(leadHold())} ]; do sleep 0.05; done`],
            },
          ]
        : [],
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
  if (method === 'unresolved-conflict') await writeFile(leadHold(), '')
  if (conflict) {
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
  await waitUntil(async () => (await getTask(s.client, repair.id)).stage === 'done', 'repair merge')
  const notes = async () =>
    (await s.client.ok<Comment[]>('GET', `${s.root}/comments`))
      .filter((c) => c.author.kind === 'ted')
      .map((c) => c.body)
  if (conflict) {
    const handedOff = await waitUntil(
      async () => {
        const body = (await notes()).find((b) => b.includes('TED asked the Task Lead to merge'))
        return body
      },
      'conflict handed to the Task Lead',
      validateWaitMs,
    )
    expect(handedOff).toContain('`timezone.txt`')
    const lead = await waitUntil(
      async () => {
        const t = await getTask(s.client, s.current.id)
        return t.leadRunId !== s.current.leadRunId ? t.leadRunId : undefined
      },
      'a Task Lead that receives the conflict',
      validateWaitMs,
    )
    const { run: started } = await s.client.ok<{ run: { prompt?: string } }>('GET', `/runs/${lead}`)
    expect(started.prompt).toContain('git merge ')
    expect(started.prompt).toContain('- timezone.txt')
  }
  if (method === 'unresolved-conflict') {
    const stopped = async (after: string | undefined) =>
      waitUntil(
        async () => {
          const t = await getTask(s.client, s.current.id)
          return t.status?.kind === 'stopped' && t.leadRunId !== after ? t : undefined
        },
        'conflict left to the user',
        validateWaitMs,
      )
    const { rm } = await import('node:fs/promises')
    await rm(leadHold())
    const first = await stopped(s.current.leadRunId)
    expect(first.stage).toBe('validate')
    expect(await s.client.ok('GET', `${s.root}/check-runs`)).toHaveLength(previousChecks.length)
    expect(
      (await s.client.ok<FailureCase[]>('GET', `${s.root}/failures`))[0]?.repairProgress,
    ).toBeUndefined()
    const held = (await notes()).find((b) => b.includes('still conflicts'))
    expect(held).toContain('`timezone.txt`')
    expect(held).toContain(
      'The Task Lead didn’t resolve it. Resume to have the Task Lead try again. Or merge main',
    )
    await writeFile(leadHold(), '')
    await s.client.ok('POST', `${s.root}/resume`, {})
    await waitUntil(
      async () => {
        const t = await getTask(s.client, s.current.id)
        const lead = t.runs.find((r) => r.id === t.leadRunId)
        return t.leadRunId !== first.leadRunId && lead?.state === 'working' ? t : undefined
      },
      'the conflict handed to the Task Lead again',
      validateWaitMs,
    )
    await s.client.ok('POST', `${s.root}/stop`, {})
    await rm(leadHold())
    await waitUntil(async () => {
      const t = await getTask(s.client, s.current.id)
      return t.status?.kind === 'stopped' ? t : undefined
    }, 'the user’s stop')
    await run('sh', ['-c', mergeBase(ctx.origin)], { cwd: affectedWorktree })
    await s.client.ok('POST', `${s.root}/resume`, {})
  }
  if (method === 'dirty-worktree') {
    const handedOff = await waitUntil(
      async () => (await notes()).find((b) => b.includes('TED asked the Task Lead to commit them')),
      'uncommitted changes handed to the Task Lead',
      validateWaitMs,
    )
    expect(handedOff).toContain('`local-draft.txt`')
    const lead = await waitUntil(
      async () => {
        const t = await getTask(s.client, s.current.id)
        return t.leadRunId !== s.current.leadRunId ? t.leadRunId : undefined
      },
      'a Task Lead that receives the uncommitted changes',
      validateWaitMs,
    )
    const { run: started } = await s.client.ok<{ run: { prompt?: string } }>('GET', `/runs/${lead}`)
    expect(started.prompt).toContain('- local-draft.txt')
    expect(started.prompt).toContain('Never discard or reset them')
    const held = await waitUntil(
      async () => {
        const t = await getTask(s.client, s.current.id)
        return t.status?.kind === 'stopped' ? t : undefined
      },
      'unsafe incorporation held',
      validateWaitMs,
    )
    expect(held.stage).toBe('validate')
    expect(await s.client.ok('GET', `${s.root}/check-runs`)).toHaveLength(previousChecks.length)
    const history = await s.client.ok<FailureCase[]>('GET', `${s.root}/failures`)
    expect(history[0]?.repairProgress).toBeUndefined()
    expect((await s.client.ok<TaskBrief>('GET', `${s.root}/brief`)).text).toContain(
      'has uncommitted changes. The Task Lead left them uncommitted. TED can’t bring the repair in over them. Resume to have the Task Lead try again.',
    )
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
  await waitUntil(
    async () => {
      const failures = await s.client.ok<FailureCase[]>('GET', `${s.root}/failures`)
      return failures[0]?.verifications?.length ? failures : undefined
    },
    'fresh Check verifying the repair',
    validateWaitMs,
  )
  expect(
    await readFile(path.join(required(s.current.repos[0]).worktree, 'timezone.txt'), 'utf8'),
  ).toBe('restored\n')
  const failures = await s.client.ok<FailureCase[]>('GET', `${s.root}/failures`)
  expect(failures[0]?.originalCheck?.state).toBe('failed')
  expect(failures[0]?.resolutions[0]?.repairTask?.id).toBe(repair.id)
  const checks = await s.client.ok<{ id: string; outcome: string }[]>('GET', `${s.root}/check-runs`)
  expect(checks.some((c) => c.outcome === 'passed')).toBe(true)
  expect(new Set(checks.map((c) => c.id)).size).toBeGreaterThan(1)
}
