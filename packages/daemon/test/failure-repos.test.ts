import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  Banner,
  Comment,
  FailureCase,
  FailureContext,
  ValidationObligations,
} from '@ted/protocol'
import { tedPaths } from '@ted/protocol'
import { expect, test } from 'vitest'
import { loadRunTokens } from '../src/run-token.ts'
import { api, waitUntil } from './helpers.ts'
import { ctx, getTask, readGh, run, start, toSignoff, useMergeHarness } from './merge-harness.ts'

useMergeHarness()
test.each(['acceptance', 'obligations', 'gate', 'merge'])(
  '%s excludes concurrent repo membership changes',
  async (boundary) => {
    const beforeEnv = { ...process.env }
    const secondary = path.join(ctx.scratch, 'acme', 'api.git')
    const seed = path.join(ctx.scratch, 'api-seed')
    await mkdir(secondary, { recursive: true })
    await mkdir(seed)
    await run('git', ['init', '--bare', '--initial-branch=main'], { cwd: secondary })
    await run('git', ['init', '--initial-branch=main'], { cwd: seed })
    await writeFile(path.join(seed, 'README.md'), '# API\n')
    await run('git', ['add', 'README.md'], { cwd: seed })
    await run(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'],
      { cwd: seed },
    )
    await run('git', ['push', secondary, 'main'], { cwd: seed })
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = `url.file://${ctx.scratch}/.insteadOf`
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/'
    let pending: Promise<{ status: number; body: unknown }> | undefined
    const entered = path.join(ctx.scratch, 'entered')
    const release = path.join(ctx.scratch, 'release')
    try {
      const client = await start({
        mergePollMs: 60_000,
        workflow: [
          'repos:',
          '  - name: widgets',
          '  - name: api',
          '    remote: https://github.com/acme/api.git',
        ],
      })
      const state = await readGh()
      const paths = {
        'repos/acme/api': {
          body: { full_name: 'acme/api', default_branch: 'main', permissions: { push: true } },
        },
        'repos/acme/api/commits?per_page=1': { body: [] },
      }
      await writeFile(
        ctx.ghState,
        JSON.stringify({
          ...state,
          paths,
          merge: { ...state.merge, origins: { 'acme/api': secondary } },
        }),
      )
      for (const b of await client.ok<Banner[]>('GET', '/banners'))
        if (b.problem === 'repo-in-workflow')
          await client.ok('POST', `/banners/${encodeURIComponent(b.id)}/action`, {})
      const script = [
        `[ -e '${client.mergingFile}' ] && exit 0`,
        `(cd widgets && echo $$ >> work.txt && git add work.txt && git -c user.name=T -c user.email=t@example.com commit -qm work)`,
        `ted brief write --file '${client.briefFile}'`,
        'ted outcome advance',
      ].join('\n')
      const each = [{ run: ['sh', '-c', script] }, { endTurn: true }]
      const { task, signoff } = await toSignoff(client, {
        title: JSON.stringify({ steps: [{ everyMessage: each }, ...each] }),
      })
      await writeFile(client.mergingFile, '')
      const current = await getTask(client, task.id)
      const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
      const lead = api(ctx.daemon?.port ?? 0, tokens.issue(current.leadRunId ?? ''))
      const root = `/tasks/${task.id}`
      const post = async <T>(suffix: string, body: unknown = {}) => {
        const res = await lead.call('POST', root + suffix, body)
        expect(res.status, JSON.stringify(res.body)).toBeLessThan(300)
        return res.body as T
      }
      const context = await post<FailureContext>('/failure-contexts')
      const value = await post<FailureCase>('/failures', {
        source: { kind: 'finding', runId: current.leadRunId, finding: 'Original failure' },
        evidence: 'Observed before repo addition',
        contextId: context.id,
      })
      await post(`/failures/${value.id}/assessments`, {
        assessment: 'unrelated',
        recommendation: 'Accept exact tested context',
      })
      const asked = await post<FailureCase>(`/failures/${value.id}/decision`)
      const resolve = () =>
        client.call('POST', `${root}/failures/${value.id}/resolve`, {
          requestId: asked.decisions.at(-1)?.commentId,
          resolution: 'accepted',
        })
      if (boundary !== 'acceptance') expect((await resolve()).status).toBe(200)
      await writeFile(
        ctx.ghState,
        JSON.stringify({
          ...(await readGh()),
          ...(boundary === 'merge'
            ? { mergeGate: { entered, release } }
            : { graphqlGate: { entered, release, after: boundary === 'acceptance' ? 1 : 0 } }),
        }),
      )
      pending =
        boundary === 'acceptance'
          ? resolve()
          : boundary === 'gate' || boundary === 'merge'
            ? client.call('POST', `/comments/${signoff.id}/answer`, { action: 'approve' })
            : client.call('GET', `${root}/validation-obligations`)
      await waitUntil(() => readFile(entered, 'utf8').catch(() => undefined), 'gated GitHub read')
      try {
        const added = await client.call('PUT', `${root}/repos`, { add: ['api'] })
        expect(added.status).toBe(409)
        expect(
          (await getTask(client, task.id)).repos.filter((r) => !r.removed).map((r) => r.repo),
        ).toEqual(['acme/widgets'])
      } finally {
        await writeFile(release, '')
      }
      const response = await pending
      expect(response.status).toBe(200)
      if (boundary === 'obligations')
        expect(response.body).toMatchObject({
          satisfied: true,
          cases: [{ disposition: 'accepted' }],
        })
      if (boundary === 'merge') {
        await waitUntil(
          async () => (await getTask(client, task.id)).stage === 'done',
          'merge completion',
        )
        return
      }
      if (boundary === 'gate') return
      expect((await client.call('PUT', `${root}/repos`, { add: ['api'] })).status).toBe(200)
      const stored = await client.ok<FailureCase[]>('GET', `${root}/failures`)
      expect(stored[0]?.invalidations).toHaveLength(1)
      expect(stored[0]?.resolutions).toHaveLength(1)
      expect(
        await client.ok<ValidationObligations>('GET', `${root}/validation-obligations`),
      ).toMatchObject({ satisfied: false, cases: [{ disposition: 'invalidated' }] })
      expect(
        (await client.call('POST', `/comments/${signoff.id}/answer`, { action: 'approve' })).status,
      ).toBe(409)
      expect(
        (await client.ok<Comment[]>('GET', `${root}/comments`)).find((c) => c.id === signoff.id)
          ?.answer,
      ).toBeUndefined()
    } finally {
      await writeFile(release, '')
      await pending?.catch(() => {})
      process.env = { ...beforeEnv }
    }
  },
  60_000,
)
