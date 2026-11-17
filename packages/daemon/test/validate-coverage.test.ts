import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CheckRun, FailureCase, SendBack, Task, ValidationObligations } from '@ted/protocol'
import { tedPaths } from '@ted/protocol'
import { expect, test } from 'vitest'
import { startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { openStore } from '../src/store/index.ts'
import { api, commitToOrigin, stubClaudePath, waitUntil } from './helpers.ts'
import { ctx, getTask, run, setGh, start, useMergeHarness } from './merge-harness.ts'

useMergeHarness()

const checks = [{ name: 'Tests', run: 'test "$(cat work.txt)" = implemented' }]
const workflow = (plan = checks, extra: string[] = []) =>
  [
    'version: 1',
    'order: [intake, work, validate, review]',
    ...extra,
    'stages:',
    '  validate:',
    `    checks: ${JSON.stringify(plan)}`,
    '',
  ].join('\n')

async function passing({
  changed = true,
  plan = checks,
  pullRequest = false,
  enterValidate = true,
} = {}) {
  const client = await start({
    order: 'intake, work, validate, review',
    workflow: ['stages:', '  validate:', `    checks: ${JSON.stringify(plan)}`],
    files: { 'work.txt': 'implemented\n' },
    ...(pullRequest && {
      merge: { checks: [{ id: 'ci-stable-attempt', name: 'CI', status: 'IN_PROGRESS' }] },
    }),
  })
  const task = await client.ok<Task>('POST', '/tasks', {
    title: '{"steps":[{"endTurn":true}]}',
    factory: 'NB',
    start: true,
  })
  const current = await waitUntil(async () => {
    const value = await getTask(client, task.id)
    return value.runs[0]?.state === 'idle' ? value : undefined
  }, 'idle Task Lead')
  const root = `/tasks/${task.id}`
  const token = (await loadRunTokens(tedPaths(ctx.home).runTokenKey)).issue(current.leadRunId ?? '')
  const app = () => api(ctx.daemon?.port ?? 0, { appKey: ctx.daemon?.appToken ?? '' })
  const call = (route: string, body = {}) =>
    waitUntil(async () => {
      const result = await api(ctx.daemon?.port ?? 0, token).call('POST', root + route, body)
      return result.status === 409 && /Ted is (already )?running/.test(JSON.stringify(result.body))
        ? undefined
        : result
    }, 'Ted to finish handing over the Checks')
  const read = async <T>(route: string): Promise<T> => {
    const result = await app().call('GET', route)
    expect(result.status).toBe(200)
    return result.body as T
  }
  const runs = () => read<CheckRun[]>(`${root}/check-runs`)
  const obligations = () => read<ValidationObligations>(`${root}/validation-obligations`)
  const advance = () => call('/outcome', { outcome: 'advance' })
  const repo = current.repos[0]
  if (!repo) throw new Error('Worktree missing')
  if (pullRequest) {
    const head = (await run('git', ['rev-parse', 'HEAD'], { cwd: repo.worktree })).stdout.trim()
    const commit = (
      await run(
        'git',
        [
          '-c',
          'user.name=T',
          '-c',
          'user.email=t@example.com',
          'commit-tree',
          `${head}^{tree}`,
          '-p',
          head,
          '-m',
          'fixture revision',
        ],
        { cwd: repo.worktree },
      )
    ).stdout.trim()
    await run('git', ['update-ref', 'HEAD', commit], { cwd: repo.worktree })
  }
  if (changed) await writeFile(path.join(repo.worktree, 'feature.txt'), 'implemented\n')
  expect((await advance()).status).toBe(200)
  if (enterValidate) {
    expect((await advance()).status).toBe(200)
    await waitUntil(async () => {
      const progress = (await obligations()).progress
      return (await getTask(client, task.id)).stage === 'validate' && progress && !progress.pending
    }, 'the hand-off Checks to move the Task to Validate and count as its coverage')
  }
  const settled = async () => {
    await waitUntil(async () => {
      const value = (await runs()).at(-1)
      if (plan.length === 0) {
        const result = await obligations()
        return result.progress && !result.progress.pending ? result : undefined
      }
      return value?.finishedAt ? value : undefined
    }, 'Validate Checks completed')
    await waitUntil(async () => {
      const value = (await read<Task[]>('/tasks')).find((t) => t.id === task.id)
      return value && !value.activity?.startsWith('Running checks') ? value : undefined
    }, 'Check delivery finished')
  }
  if (enterValidate) await settled()
  const stage = async () => (await read<Task[]>('/tasks')).find((t) => t.id === task.id)?.stage
  const advanceAfterChecks = async () => {
    const result = await advance()
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    expect(JSON.stringify(result.body)).toContain('running the checks')
    await settled()
  }
  return {
    task,
    app,
    root,
    repo,
    read,
    call,
    advance,
    advanceAfterChecks,
    runs,
    obligations,
    settled,
    stage,
  }
}

test('unchanged passing coverage advances', async () => {
  const s = await passing()
  expect((await s.runs())[0]?.checks[0]?.state).toBe('passed')
  expect((await s.advance()).status).toBe(200)
})

test.each([false, true])(
  'a code change holds old passing coverage (restart: %s)',
  async (restart) => {
    const s = await passing()
    const original = await s.runs()
    await writeFile(path.join(s.repo.worktree, 'work.txt'), 'regressed\n')
    if (restart) {
      await ctx.daemon?.stop()
      ctx.daemon = await startDaemon({
        home: ctx.home,
        version: '9.9.9',
        claudeBin: stubClaudePath,
      })
    }
    await s.advanceAfterChecks()
    expect((await s.runs())[0]).toEqual(original[0])
    expect((await s.runs()).at(-1)?.checks[0]?.state).toBe('failed')
    const failures = await s.read<FailureCase[]>(`${s.root}/failures`)
    expect(failures).toHaveLength(1)
    expect(await s.stage()).toBe('validate')
    const refused = await s.advance()
    expect(refused.status).toBe(409)
    expect(JSON.stringify(refused.body)).toContain('A check failed')
  },
)

test('a changed Check plan runs before advancing instead of inheriting prior completion', async () => {
  const s = await passing()
  const original = await s.runs()
  await commitToOrigin(ctx.scratch, {
    '.ted/workflow.yaml': workflow([...checks, { name: 'New Check', run: 'echo newly-required' }]),
  })
  await s.advanceAfterChecks()
  const runs = await s.runs()
  expect(runs.length).toBe(original.length + 1)
  expect(runs.at(-1)?.checks.map((c) => c.name)).toEqual(['Tests', 'New Check'])
  await waitUntil(async () => (await s.stage()) === 'review', 'the Task to move on')
})

test('stopping the Task while its out-of-date Checks run drops the waiting move', async () => {
  const s = await passing()
  await commitToOrigin(ctx.scratch, {
    '.ted/workflow.yaml': workflow([...checks, { name: 'Slow Check', run: 'sleep 3' }]),
  })
  const held = await s.advance()
  expect(held.status, JSON.stringify(held.body)).toBe(200)
  expect((await s.app().call('POST', `${s.root}/stop`)).status).toBe(200)
  expect((await s.app().call('POST', `${s.root}/resume`, {})).status).toBe(200)
  await s.settled()
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(await s.stage()).toBe('validate')
})

test('changing a repo’s command environment invalidates coverage even with the same Check names', async () => {
  const s = await passing()
  await commitToOrigin(ctx.scratch, {
    '.ted/workflow.yaml': workflow(checks, [
      'repos:',
      '  - name: widgets',
      '    worktree:',
      '      env: { CHECK_CONTEXT: revised }',
    ]),
  })
  await s.advanceAfterChecks()
  expect((await s.obligations()).satisfied).toBe(true)
  await waitUntil(async () => (await s.stage()) === 'review', 'the Task to move on')
})

test('legitimate no-change skips advance without manufacturing a pass', async () => {
  const s = await passing({ changed: false })
  expect((await s.runs())[0]?.checks[0]?.state).toBe('skipped')
  expect((await s.obligations()).satisfied).toBe(true)
  expect((await s.advance()).status).toBe(200)
  expect((await s.runs())[0]?.checks[0]?.state).toBe('skipped')
})

test('a new Check added after an empty plan still must run', async () => {
  const s = await passing({ plan: [] })
  expect(await s.runs()).toEqual([])
  await commitToOrigin(ctx.scratch, { '.ted/workflow.yaml': workflow() })
  await s.advanceAfterChecks()
  expect((await s.runs()).at(-1)?.outcome).toBe('passed')
  await waitUntil(async () => (await s.stage()) === 'review', 'the Task to move on')
})

test('CI completion alone preserves completed local Check coverage', async () => {
  const s = await passing({ pullRequest: true })
  const tasks = await s.read<Task[]>('/tasks')
  expect(tasks.find((t) => t.id === s.task.id)?.repos[0]?.pullRequest).toBeUndefined()
  await s.obligations()
  expect((await s.call('/checks')).status).toBe(201)
  await s.settled()
  const original = await s.runs()
  expect((await s.obligations()).satisfied).toBe(true)
  await setGh({
    checks: [{ id: 'ci-stable-attempt', name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  })
  const result = await s.advance()
  expect(result.status, JSON.stringify(result.body)).toBe(200)
  expect(await s.runs()).toEqual(original)
  await setGh({ rollup: 'missing' })
  expect((await s.obligations()).satisfied).toBe(true)
})

test('passing later-stage Checks can refresh changed local coverage', async () => {
  const s = await passing({ pullRequest: true })
  const tasks = await s.read<Task[]>('/tasks')
  expect(tasks.find((t) => t.id === s.task.id)?.repos[0]?.pullRequest).toBeUndefined()
  await s.obligations()
  expect((await s.call('/checks')).status).toBe(201)
  await s.settled()
  expect((await s.obligations()).satisfied).toBe(true)
  expect((await s.advance()).status).toBe(200)
  expect((await s.read<Task[]>('/tasks')).find((t) => t.id === s.task.id)?.stage).toBe('review')
  await writeFile(path.join(s.repo.worktree, 'feature.txt'), 'revised code\n')
  expect((await s.obligations()).satisfied).toBe(false)
  const count = (await s.runs()).length
  expect((await s.call('/checks')).status).toBe(201)
  await waitUntil(async () => {
    const runs = await s.runs()
    return runs.length > count && runs.at(-1)?.outcome === 'passed'
  }, 'Review Check rerun passes')
  const result = await s.obligations()
  expect(result.satisfied, JSON.stringify(result)).toBe(true)
})

test('moving the remote base alone preserves actual passing local execution', async () => {
  const s = await passing()
  const original = await s.runs()
  await commitToOrigin(ctx.scratch, { 'other.txt': 'remote-only change\n' })
  expect((await s.advance()).status).toBe(200)
  expect(await s.runs()).toEqual(original)
})

test('a no-change skip cannot cover a newly applicable Check after local code changes', async () => {
  const s = await passing({ changed: false })
  expect((await s.runs())[0]?.checks[0]?.state).toBe('skipped')
  await writeFile(path.join(s.repo.worktree, 'work.txt'), 'implemented again\n')
  await s.advanceAfterChecks()
  expect((await s.runs()).at(-1)?.checks[0]?.state).toBe('failed')
  expect((await s.obligations()).satisfied).toBe(false)
  expect(await s.stage()).toBe('validate')
})

test('newly resolved Checks run before Ted posts a Validate Gate', async () => {
  const s = await passing()
  expect(
    (
      await s.call('/brief', {
        text: '## Goal\nVerify coverage.\n\n## Decisions so far\nNone.\n\n## Current state\nChecks ran.\n\n## Open questions\nNone.\n\n## Next step\nReview.',
      })
    ).status,
  ).toBe(201)
  await commitToOrigin(ctx.scratch, {
    '.ted/workflow.yaml': workflow([
      ...checks,
      { name: 'New Check', run: 'echo required' },
    ]).replace('  validate:\n', '  validate:\n    gate: true\n'),
  })
  await s.advanceAfterChecks()
  expect((await s.runs()).at(-1)?.checks.map((c) => c.name)).toEqual(['Tests', 'New Check'])
  expect((await s.read<ValidationObligations>(`${s.root}/validation-obligations`)).satisfied).toBe(
    true,
  )
  await waitUntil(async () => {
    const comments = await s.read<{ kind: string; answer?: unknown }[]>(`${s.root}/comments`)
    return comments.some((c) => c.kind === 'signoff' && c.answer === undefined)
  }, 'the Validate sign-off')
})

test('reading a completed Task preserves its historical validation summary', async () => {
  const s = await passing()
  const before = await s.obligations()
  expect(before.satisfied).toBe(true)
  await ctx.daemon?.stop()
  ctx.daemon = undefined
  const store = await openStore({ directory: tedPaths(ctx.home).store })
  store.changeStage(s.task.id, 'done')
  store.worktreeRemoved(s.task.id, s.repo.name)
  await store.persisted()
  await store.close()
  ctx.daemon = await startDaemon({ home: ctx.home, version: '9.9.9', claudeBin: stubClaudePath })
  const after = await s.obligations()
  expect(after.progress).toEqual(before.progress)
  expect(after.satisfied).toBe(true)
})

test.each(['failure', 'empty', 'skip'])(
  'restart reconstructs a Validate entry before progress creation: %s',
  async (mode) => {
    const s = await passing({
      enterValidate: false,
      changed: mode !== 'skip',
      plan: mode === 'empty' ? [] : [{ name: 'Tests', run: 'exit 1' }],
    })
    await ctx.daemon?.stop()
    ctx.daemon = undefined
    const store = await openStore({ directory: tedPaths(ctx.home).store })
    expect(store.failures.progress(s.task.id)).toBeUndefined()
    store.changeStage(s.task.id, 'validate', {
      layers: [],
      order: [
        { stage: 'intake', enabled: true },
        { stage: 'work', enabled: true },
        { stage: 'validate', enabled: true },
        { stage: 'review', enabled: true },
      ],
    })
    await store.persisted()
    await store.close()
    ctx.daemon = await startDaemon({ home: ctx.home, version: '9.9.9', claudeBin: stubClaudePath })
    if (mode === 'failure') expect((await s.advance()).status).toBe(409)
    const result = await waitUntil(async () => {
      const value = await s.obligations()
      return value.progress && !value.progress.pending ? value : undefined
    }, 'reconstructed validation completes')
    expect(result.progress?.checks.map((c) => c.state)).toEqual(
      mode === 'empty' ? [] : [mode === 'skip' ? 'skipped' : 'failed'],
    )
    if (mode === 'failure') {
      expect(result.satisfied).toBe(false)
      expect((await s.runs()).at(-1)?.outcome).toBe('failed')
      expect((await s.advance()).status).toBe(409)
    } else {
      await waitUntil(async () => (await s.obligations()).satisfied, 'legitimate coverage settled')
      expect((await s.advance()).status).toBe(200)
    }
  },
)

test('later forward movement holds missing Validate coverage and a full rerun can repair it', async () => {
  const s = await passing({ enterValidate: false })
  await ctx.daemon?.stop()
  ctx.daemon = undefined
  const store = await openStore({ directory: tedPaths(ctx.home).store })
  store.changeStage(s.task.id, 'validate', {
    layers: [],
    order: [
      { stage: 'validate', enabled: true },
      { stage: 'review', enabled: true },
    ],
  })
  store.changeStage(s.task.id, 'review')
  await store.persisted()
  await store.close()
  ctx.daemon = await startDaemon({ home: ctx.home, version: '9.9.9', claudeBin: stubClaudePath })
  expect(await s.runs()).toEqual([])
  await s.advanceAfterChecks()
  expect((await s.obligations()).satisfied).toBe(true)
  expect((await s.runs()).at(-1)?.outcome).toBe('passed')
})

test('restart preserves an already persisted Finding Fix even without Check progress', async () => {
  const s = await passing({ enterValidate: false })
  await ctx.daemon?.stop()
  ctx.daemon = undefined
  const store = await openStore({ directory: tedPaths(ctx.home).store })
  store.changeStage(s.task.id, 'validate', {
    layers: [],
    order: [
      { stage: 'work', enabled: true },
      { stage: 'validate', enabled: true },
      { stage: 'review', enabled: true },
    ],
  })
  const at = new Date().toISOString()
  const runId = store.getTask(s.task.id)?.leadRunId ?? ''
  let value = store.failures.save(
    {
      id: 'persisted-fix',
      taskId: s.task.id,
      validation: true,
      source: { kind: 'finding', runId, finding: 'Extra verification failed' },
      recordedBy: runId,
      provenance: 'task-lead-reported',
      evidence: 'The fixture service failed.',
      createdAt: at,
      assessments: [],
      additions: [],
      decisions: [],
      resolutions: [],
      invalidations: [],
    },
    'recorded',
  )
  value = store.failures.save(
    {
      ...value,
      assessments: [
        {
          id: 'fix-assessment',
          assessment: 'uncertain',
          recommendation: 'Fix in this Task.',
          runId,
          at,
        },
      ],
    },
    'assessed',
  )
  value = store.postFailureDecision(value, 'Fix this failure?')
  const requestId = value.decisions.at(-1)?.commentId
  if (!requestId) throw new Error('missing request')
  store.resolveFailure(
    {
      ...value,
      resolutions: [{ requestId, assessmentId: 'fix-assessment', resolution: 'fix', at }],
    },
    requestId,
    { kind: 'answered', choice: 'Fix in this Task', at },
    [],
  )
  await store.persisted()
  await store.close()
  ctx.daemon = await startDaemon({ home: ctx.home, version: '9.9.9', claudeBin: stubClaudePath })
  await waitUntil(
    async () => (await s.read<Task[]>('/tasks')).find((t) => t.id === s.task.id)?.stage === 'work',
    'persisted Fix completed',
  )
  expect(await s.runs()).toEqual([])
  expect(await s.read<SendBack[]>(`${s.root}/send-backs`)).toMatchObject([
    { counted: true, round: 1 },
  ])
})
