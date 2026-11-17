import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Banner } from '@ted/protocol'
import { expect, test } from 'vitest'
import { commitToOrigin, waitUntil } from './helpers.ts'
import {
  approve,
  commitStep,
  ctx,
  getTask,
  merges,
  quietGuard,
  readGh,
  run,
  setGh,
  start,
  toSignoff,
  useMergeHarness,
  waitForStage,
} from './merge-harness.ts'
import {
  ask,
  cases,
  checks,
  comments,
  failed,
  lead,
  long,
  obligations,
  polls,
  rebased,
  resolve,
  runs,
} from './support/merge-check-decisions.ts'

useMergeHarness()

test(
  'an unrelated failure holds Merge without repeated execution or questions; each later failure needs its own decision',
  async () => {
    const { client, task, failure } = await rebased()
    expect(failure.source.kind).toBe('post-rebase-check')
    expect(failure.contextId).toBeTruthy()
    expect(failure.validation).toBe(true)
    expect((await getTask(client, task.id)).stage).toBe('merge')
    const request = await ask(client, task, failure)
    const before = await comments(client, task)
    await polls(client)
    expect(await runs(client, task)).toHaveLength(1)
    expect(await comments(client, task)).toHaveLength(before.length)
    expect(await merges()).toEqual([])
    const agent = await lead(client, task)
    expect(
      (await agent.call('POST', `/tasks/${task.id}/outcome`, { outcome: 'advance' })).status,
    ).toBe(409)
    expect((await resolve(client, task, failure, request, 'accepted')).status).toBe(200)
    const later = await failed(client, task, 2)
    expect(later.id).not.toBe(failure.id)
    expect((await obligations(client, task)).satisfied).toBe(false)
    expect((await runs(client, task)).map((r) => r.checks.map((c) => c.state))).toEqual([
      ['passed', 'failed', 'not-run'],
      ['failed'],
    ])
    expect(await merges()).toEqual([])
    await polls(client)
    expect(await runs(client, task)).toHaveLength(2)
    const second = await ask(client, task, later)
    expect((await resolve(client, task, later, second, 'accepted')).status).toBe(200)
    await waitForStage(client, task, 'done')
    expect(await runs(client, task)).toHaveLength(2)
    expect(await merges()).toHaveLength(1)
    expect((await runs(client, task))[0]?.outcome).toBe('failed')
  },
  long,
)

test(
  'a second rebase invalidates a prior acceptance and reruns the full current Check plan before the Merge sign-off',
  async () => {
    const { client, task, failure } = await rebased(true)
    const t = await getTask(client, task.id)
    await writeFile(path.join(t.repos[0]?.worktree ?? '', 'stub-later-fixed'), '')
    const request = await ask(client, task, failure)
    expect((await resolve(client, task, failure, request, 'accepted')).status).toBe(200)
    const signoff = await waitUntil(
      async () =>
        (await comments(client, task)).find(
          (c) => c.stage === 'merge' && c.kind === 'signoff' && !c.answer,
        ),
      'Merge sign-off after accepted Check',
    )
    await commitToOrigin(ctx.scratch, { 'another-base-change': 'A second rebase.\n' })
    await setGh({ mergeState: 'BEHIND' })
    await approve(client, signoff)
    const fresh = await failed(client, task, 2)
    const execution = (await runs(client, task)).at(-1)
    expect(fresh.id).not.toBe(failure.id)
    expect(fresh.source).toMatchObject({
      kind: 'post-rebase-check',
      checkRunId: execution?.id,
    })
    expect(fresh.source).not.toEqual(failure.source)
    expect(fresh.contextId).not.toBe(failure.contextId)
    expect(
      (await cases(client, task)).find((value) => value.id === failure.id)?.invalidations,
    ).toHaveLength(1)
    expect(execution?.checks.map((c) => c.name)).toEqual(['Prefix', 'First', 'Later'])
    expect((await resolve(client, task, failure, request, 'accepted')).status).toBe(409)
    expect(await merges()).toEqual([])
    expect((await readGh()).merge.merged).not.toBe(true)
  },
  long,
)

test(
  'a post-rebase failure in one repo holds both repos until local obligations are satisfied',
  async () => {
    const saved = { ...process.env }
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = `url.file://${ctx.scratch}/.insteadOf`
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/'
    try {
      const client = await start({
        workflow: [
          'repos:',
          '  - name: widgets',
          '  - name: api',
          '    remote: https://github.com/acme/api.git',
          'stages:',
          '  validate:',
          '    checks:',
          ...checks,
          '      - { name: API, repo: api, run: "test -e work.txt" }',
        ],
      })
      const apiOrigin = path.join(ctx.scratch, 'acme/api.git')
      await run('git', ['clone', '--bare', ctx.origin, apiOrigin])
      await writeFile(
        ctx.ghState,
        JSON.stringify({
          ...(await readGh()),
          merge: {
            origin: ctx.origin,
            origins: { 'acme/widgets': ctx.origin, 'acme/api': apiOrigin },
            prs: { '7': { mergeState: 'BEHIND' }, '8': { mergeState: 'CLEAN' } },
          },
          pr: { numbers: { 'acme/widgets': 7, 'acme/api': 8 } },
          paths: {
            'repos/acme/api': {
              body: { full_name: 'acme/api', default_branch: 'main', permissions: { push: true } },
            },
            'repos/acme/api/commits?per_page=1': { body: [] },
          },
        }),
      )
      for (const banner of await client.ok<Banner[]>('GET', '/banners')) {
        if (banner.problem === 'repo-in-workflow')
          await client.ok('POST', `/banners/${encodeURIComponent(banner.id)}/action`, {})
      }
      const commit = (repo: string) =>
        `(cd ${repo} && { [ -e stub-built ] || { ${commitStep.run[2]}; touch stub-built; }; })`
      const script = [
        quietGuard(client),
        commit('widgets'),
        commit('api'),
        `ted brief write --file '${client.briefFile}'`,
        'ted outcome advance',
      ].join('\n')
      const each = [{ run: ['sh', '-c', script] }, { endTurn: true }]
      const { task, signoff } = await toSignoff(client, {
        title: JSON.stringify({
          steps: [{ everyMessage: each }, { run: ['ted', 'task', 'repos', 'add', 'api'] }, ...each],
        }),
      })
      await waitUntil(
        async () =>
          (await getTask(client, task.id)).repos.every((r) => r.pullRequest?.state === 'ready'),
        'both repos ready',
      )
      await commitToOrigin(ctx.scratch, { 'base-only': 'Base regression.\n' })
      await approve(client, signoff)
      const failure = await failed(client, task)
      await polls(client)
      expect((await getTask(client, task.id)).repos).toHaveLength(2)
      expect(await merges()).toEqual([])
      const current = await getTask(client, task.id)
      await writeFile(
        path.join(
          current.repos.find((r) => r.name === 'widgets')?.worktree ?? '',
          'stub-later-fixed',
        ),
        '',
      )
      const request = await ask(client, task, failure)
      expect((await resolve(client, task, failure, request, 'accepted')).status).toBe(200)
      await waitUntil(
        async () => (await runs(client, task)).at(-1)?.outcome === 'passed',
        'the remaining Checks to pass',
      )
      await waitUntil(async () => (await merges()).length === 2, 'both pull requests to merge')
      await waitForStage(client, task, 'done')
      expect((await merges()).map((args) => args[args.indexOf('--repo') + 1])).toEqual([
        'acme/widgets',
        'acme/api',
      ])
      expect((await runs(client, task)).at(-1)?.checks.at(-1)).toMatchObject({
        name: 'API',
        state: 'passed',
      })
    } finally {
      process.env = saved
    }
  },
  long,
)
