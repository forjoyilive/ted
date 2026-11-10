import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CheckRun, FailureCase, Task, ValidationObligations } from '@ted/protocol'
import { tedPaths } from '@ted/protocol'
import { expect, test } from 'vitest'
import { startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
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

async function passing({ changed = true, plan = checks, pullRequest = false } = {}) {
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
    api(ctx.daemon?.port ?? 0, token).call('POST', root + route, body)
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
  expect((await advance()).status).toBe(200)
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
      return value && !value.activity?.startsWith('Running Checks') ? value : undefined
    }, 'Check delivery finished')
  }
  await settled()
  return { task, root, repo, read, call, advance, runs, obligations, settled }
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
    const denied = await s.advance()
    expect(denied.status).toBe(409)
    expect(JSON.stringify(denied.body)).toContain('coverage')
    expect((await s.obligations()).satisfied).toBe(false)
    expect((await s.runs())[0]).toEqual(original[0])
    const rerun = await s.call('/checks')
    expect(rerun.status).toBe(201)
    await s.settled()
    expect((await s.runs()).at(-1)?.checks[0]?.state).toBe('failed')
    const failures = await s.read<FailureCase[]>(`${s.root}/failures`)
    expect(failures).toHaveLength(1)
    expect((await s.advance()).status).toBe(409)
  },
)

test('a changed Check plan becomes outstanding instead of inheriting prior completion', async () => {
  const s = await passing()
  const original = await s.runs()
  await commitToOrigin(ctx.scratch, {
    '.ted/workflow.yaml': workflow([...checks, { name: 'New Check', run: 'echo newly-required' }]),
  })
  expect((await s.advance()).status).toBe(409)
  const held = await s.obligations()
  expect(held.satisfied).toBe(false)
  expect(held.progress?.checks.map((c) => c.name)).toEqual(
    expect.arrayContaining(['Tests', 'New Check']),
  )
  expect(await s.runs()).toEqual(original)
  expect((await s.call('/checks')).status).toBe(201)
  await s.settled()
  expect((await s.obligations()).satisfied).toBe(true)
  expect((await s.advance()).status).toBe(200)
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
  expect((await s.advance()).status).toBe(409)
  expect((await s.obligations()).satisfied).toBe(false)
  expect((await s.call('/checks')).status).toBe(201)
  await s.settled()
  expect((await s.obligations()).satisfied).toBe(true)
  expect((await s.advance()).status).toBe(200)
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
  expect((await s.advance()).status).toBe(409)
  expect((await s.obligations()).satisfied).toBe(false)
  expect((await s.call('/checks')).status).toBe(201)
  await s.settled()
  expect((await s.advance()).status).toBe(200)
})

test('CI completion alone preserves completed local Check coverage', async () => {
  const s = await passing({ pullRequest: true })
  await waitUntil(
    async () =>
      (await s.read<Task[]>('/tasks')).find((t) => t.id === s.task.id)?.repos[0]?.pullRequest,
    'fixture PR',
  )
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
  await waitUntil(
    async () =>
      (await s.read<Task[]>('/tasks')).find((t) => t.id === s.task.id)?.repos[0]?.pullRequest,
    'fixture PR',
  )
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
  expect((await s.advance()).status).toBe(409)
  expect((await s.obligations()).satisfied).toBe(false)
})

test('newly resolved Checks hold advancement before posting a Validate Gate', async () => {
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
  const result = await s.advance()
  expect(result.status, JSON.stringify(result.body)).toBe(409)
  expect(JSON.stringify(result.body)).toContain('coverage')
  expect((await s.read<ValidationObligations>(`${s.root}/validation-obligations`)).satisfied).toBe(
    false,
  )
})
