import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type Comment,
  type FailureCase,
  type FailureContext,
  type LineComment,
  type RunChat,
  type Task,
  tedPaths,
  type ValidationObligations,
} from '@ted/protocol'
import { expect, test } from 'vitest'
import { startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { api, commitToOrigin, stubClaudePath, tokenFor, waitUntil } from './helpers.ts'
import { ctx, getTask, run, start, useMergeHarness } from './merge-harness.ts'

useMergeHarness()

async function setup(workflow?: string[]) {
  const client = await start({ order: 'intake, work, merge', ...(workflow && { workflow }) })
  const task = await client.ok<Task>('POST', '/tasks', {
    title: '{"steps":[{"endTurn":true}]}',
    factory: 'NB',
    start: true,
  })
  const current = await waitUntil(async () => {
    const t = await getTask(client, task.id)
    return t.runs[0]?.state === 'idle' ? t : undefined
  }, 'idle lead')
  const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
  const lead = api(ctx.daemon?.port ?? 0, tokens.issue(current.leadRunId ?? ''))
  const root = `/tasks/${task.id}`
  async function ok<T>(route: string, body: unknown = {}): Promise<T> {
    const result = await lead.call('POST', root + route, body)
    expect(result.status, JSON.stringify(result.body)).toBeLessThan(300)
    return result.body as T
  }
  const capture = () => ok<FailureContext>('/failure-contexts')
  const record = (contextId?: string) =>
    ok<FailureCase>('/failures', {
      source: { kind: 'finding', runId: current.leadRunId, finding: 'Original Finding' },
      evidence: 'Reproduced in the stub',
      ...(contextId && { contextId }),
    })
  const assess = (value: FailureCase) =>
    ok<FailureCase>(`/failures/${value.id}/assessments`, {
      assessment: 'unrelated',
      recommendation: 'Accept for this context',
    })
  const request = async (value: FailureCase) => {
    await assess(value)
    return ok<FailureCase>(`/failures/${value.id}/decision`)
  }
  const resolve = (value: FailureCase, resolution = 'accepted', reason?: string) =>
    client.call('POST', `${root}/failures/${value.id}/resolve`, {
      requestId: value.decisions.at(-1)?.commentId,
      resolution,
      ...(reason && { reason }),
    })
  const obligations = () =>
    client.ok<ValidationObligations>('GET', `${root}/validation-obligations`)
  return {
    client,
    task: current,
    lead,
    tokens,
    root,
    ok,
    capture,
    record,
    assess,
    request,
    resolve,
    obligations,
  }
}

test('assessment, request and acceptance are separate, and each case holds independently', async () => {
  const s = await setup()
  const context = await s.capture()
  const one = await s.record(context.id)
  const two = await s.record(context.id)
  expect((await s.obligations()).blockers.sort()).toEqual([one.id, two.id].sort())
  expect((await s.lead.call('POST', `${s.root}/failures/${one.id}/decision`, {})).status).toBe(409)
  const decision = await s.request(one)
  const id = decision.decisions[0]?.commentId ?? ''
  expect(
    (await s.client.ok<Comment[]>('GET', `${s.root}/comments`)).find((c) => c.id === id)?.answer,
  ).toBeUndefined()
  const discussion = await s.client.call('POST', `/comments/${id}/answer`, {
    action: 'answer',
    text: 'Please explain the evidence.',
  })
  expect(discussion.status).toBe(200)
  expect((discussion.body as Comment).answer).toBeUndefined()
  expect((await s.obligations()).satisfied).toBe(false)
  const verify = await s.lead.call('POST', `${s.root}/failures/${one.id}/verification`, {
    evidence: 'It passes now.',
  })
  expect(verify.status).toBe(409)
  expect(JSON.stringify(verify.body)).toContain('`stages.work.lead_closes_failures: true`')
  expect((await s.resolve(decision)).status).toBe(200)
  expect((await s.obligations()).blockers).toEqual([two.id])
  expect((await s.resolve(decision)).status).toBe(409)
  const second = await s.request(two)
  expect((await s.resolve(second, 'fixed')).status).toBe(400)
  expect((await s.resolve(second, 'fixed', 'A separate rerun passed.')).status).toBe(200)
  const state = await s.obligations()
  expect(state.satisfied).toBe(true)
  expect(state.cases.map((c) => c.disposition).sort()).toEqual(['accepted', 'fixed'])
  const stored = await s.client.ok<FailureCase[]>('GET', `${s.root}/failures`)
  expect(stored[0]?.source).toEqual(one.source)
  expect(stored[0]?.evidence).toBe(one.evidence)
})

test('with stages.work.lead_closes_failures on, the Task Lead closes its own Finding with passing evidence and its question is withdrawn', async () => {
  const s = await setup(['stages:', '  work: { lead_closes_failures: true }'])
  const decision = await s.request(await s.record((await s.capture()).id))
  const route = `/failures/${decision.id}/verification`
  const closed = await s.ok<FailureCase>(route, {
    evidence: 'Ran the test again after the upstream fix; it passes.',
  })
  expect(closed.verifications).toHaveLength(1)
  const comments = await s.client.ok<Comment[]>('GET', `${s.root}/comments`)
  expect(comments.find((c) => c.id === decision.decisions[0]?.commentId)?.answer).toMatchObject({
    kind: 'withdrawn',
  })
  expect(comments.some((c) => c.title === 'Failure repair verified')).toBe(true)
  expect((await s.lead.call('POST', s.root + route, { evidence: 'Again.' })).status).toBe(409)

  const accepted = await s.request(await s.record((await s.capture()).id))
  expect((await s.resolve(accepted)).status).toBe(200)
  const relabel = await s.lead.call('POST', `${s.root}/failures/${accepted.id}/verification`, {
    evidence: 'Passes now.',
  })
  expect(relabel.status).toBe(409)
  const state = await s.obligations()
  expect(state.satisfied).toBe(true)
  expect(state.cases.map((c) => [c.id, c.disposition]).sort()).toEqual(
    [
      [decision.id, 'fixed'],
      [accepted.id, 'accepted'],
    ].sort(),
  )
})

test('direct and Comment failure resolutions deliver attached line comments to the live Task Lead', async () => {
  const s = await setup()
  for (const entry of ['direct', 'comment']) {
    const repo = s.task.repos[0]
    if (!repo) throw new Error('missing Task repo')
    await writeFile(path.join(repo.worktree, 'steering.txt'), 'new line\n')
    const context = await s.capture()
    const value = await s.record(context.id)
    const asked = await s.request(value)
    const requestId = asked.decisions.at(-1)?.commentId
    if (!requestId) throw new Error('missing decision request')
    const body =
      'Preserve this behavior. Bearer abcdefghijklmnopqrstuvwxyz https://user:password@example.com/'
    const draft = await s.client.ok<LineComment>('POST', `${s.root}/line-comments`, {
      repo: repo.name,
      path: 'steering.txt',
      from: { new: 1 },
      to: { new: 1 },
      body,
    })
    const resolve = () =>
      entry === 'direct'
        ? s.resolve(asked)
        : s.client.call('POST', `/comments/${requestId}/answer`, {
            action: 'answer',
            choice: 'Accept this failure',
          })
    expect((await resolve()).status).toBe(200)
    expect((await s.obligations()).satisfied).toBe(true)
    const comments = await s.client.ok<Comment[]>('GET', `${s.root}/comments`)
    const answered = comments.find((c) => c.id === requestId)
    expect(answered?.lineComments?.[0]).toMatchObject({
      id: draft.id,
      body,
      sent: { commentId: requestId },
    })
    expect(
      (await s.client.ok<LineComment[]>('GET', `${s.root}/line-comments`)).filter((c) => !c.sent),
    ).toEqual([])
    const resolutionMessages = async () =>
      (await s.client.getRun(s.task.leadRunId ?? '')).conversation.flatMap((event) => {
        const line = JSON.parse(event.line) as {
          type: string
          message?: { content?: unknown }
        }
        return line.type === 'user' &&
          typeof line.message?.content === 'string' &&
          line.message.content.includes(`The human resolved failure request ${requestId}`)
          ? [line.message.content]
          : []
      })
    const message = await waitUntil(
      async () => (await resolutionMessages())[0],
      'resolution and line comments delivered to the live Task Lead',
    )
    expect(message).toContain('Accept this failure')
    expect(message).toContain('Line comments (1):')
    expect(message).toContain(`steering.txt line 1, repo ${repo.name}, commit ${draft.commit}`)
    expect(message).toContain('+new line')
    expect(message).toContain('Preserve this behavior.')
    expect(message).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(message).not.toContain('user:password')
    expect((await resolve()).status).toBe(409)
    expect(await resolutionMessages()).toHaveLength(1)
  }
})

test('a binary change, a new HEAD, changed Check definitions and a changed Check environment each invalidate acceptance; returning to old content never revives consent', async () => {
  const s = await setup()
  const worktree = s.task.repos[0]?.worktree ?? ''
  const stored = () =>
    s.client.ok<FailureCase[]>('GET', `${s.root}/failures`).then((v) => v[0] as FailureCase)
  const acceptAgain = async (contextId: string) => {
    await s.ok(`/failures/${decision.id}/evidence`, {
      evidence: 'Reproduced again in the changed context',
      contextId,
    })
    const asked = await s.request(await stored())
    expect((await s.resolve(asked)).status).toBe(200)
    expect((await s.obligations()).cases).toMatchObject([
      { disposition: 'accepted', context: 'current' },
    ])
  }
  const context = await s.capture()
  const decision = await s.request(await s.record(context.id))
  expect((await s.resolve(decision)).status).toBe(200)

  const file = path.join(worktree, 'new.bin')
  await writeFile(file, new Uint8Array([0, 1, 2, 255]))
  expect((await s.obligations()).cases[0]?.disposition).toBe('invalidated')
  await rm(file)
  expect((await s.obligations()).cases[0]).toMatchObject({
    disposition: 'invalidated',
    context: 'current',
  })
  expect((await s.resolve(decision)).status).toBe(409)
  const fresh = await s.request(await stored())
  expect((await s.resolve(fresh)).status).toBe(200)
  expect((await stored()).invalidations).toHaveLength(1)

  await run(
    'git',
    [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.com',
      'commit',
      '--allow-empty',
      '-qm',
      'New ancestry',
    ],
    { cwd: worktree },
  )
  const moved = await s.capture()
  expect(moved.repos[0]?.tree).toBe(context.repos[0]?.tree)
  expect(moved.repos[0]?.head).not.toBe(context.repos[0]?.head)
  expect((await s.obligations()).cases[0]?.disposition).toBe('invalidated')
  expect((await stored()).invalidations).toHaveLength(2)
  await acceptAgain(moved.id)

  await commitToOrigin(ctx.scratch, {
    '.ted/workflow.yaml':
      'version: 1\norder: [intake, work, merge]\nstages:\n  validate:\n    checks:\n      - { name: Verify, run: "echo changed", timeout: 2m }\n',
  })
  await s.client.ok('GET', `/factories/${s.task.factoryId}/settings?refresh=first`)
  const changed = await s.capture()
  expect(changed.repos[0]?.tree).toBe(context.repos[0]?.tree)
  expect(changed.repos[0]?.tree).toBe(moved.repos[0]?.tree)
  expect(changed.repos[0]?.head).toBe(moved.repos[0]?.head)
  expect(changed.checks).not.toBe(context.checks)
  expect(changed.checks).not.toBe(moved.checks)
  expect((await s.obligations()).cases[0]?.disposition).toBe('invalidated')
  expect((await stored()).invalidations).toHaveLength(3)
  await acceptAgain(changed.id)

  await ctx.daemon?.stop()
  process.env.FAILURE_TEST_ENV = 'changed-sensitive-environment'
  try {
    ctx.daemon = await startDaemon({ home: ctx.home, version: '9.9.9', claudeBin: stubClaudePath })
    const client = api(ctx.daemon.port, { appKey: ctx.daemon.appToken })
    const result = await client.call('GET', `${s.root}/validation-obligations`)
    expect(result.body).toMatchObject({ satisfied: false, cases: [{ disposition: 'invalidated' }] })
    const failures = await client.call('GET', `${s.root}/failures`)
    expect((failures.body as FailureCase[])[0]?.invalidations).toHaveLength(4)
    expect(JSON.stringify(failures.body)).not.toContain('changed-sensitive-environment')
  } finally {
    delete process.env.FAILURE_TEST_ENV
  }
})

test.each(['changed', 'unavailable'])(
  'capturing %s context invalidates acceptance before acknowledgement and replay retains the hold',
  async (observation) => {
    const s = await setup()
    const context = await s.capture()
    const decision = await s.request(await s.record(context.id))
    expect((await s.resolve(decision)).status).toBe(200)
    const worktree = s.task.repos[0]?.worktree ?? ''
    const file = path.join(worktree, 'changed.bin')
    const moved = `${worktree}-unavailable`
    if (observation === 'changed') await writeFile(file, new Uint8Array([0, 1, 255]))
    else await rename(worktree, moved)
    let observed: FailureCase[] = []
    try {
      const response = await s.lead.call('POST', `${s.root}/failure-contexts`, {})
      expect(response.status).toBe(observation === 'changed' ? 201 : 500)
      observed = await s.client.ok<FailureCase[]>('GET', `${s.root}/failures`)
    } finally {
      if (observation === 'changed') await rm(file)
      else await rename(moved, worktree)
    }
    expect(observed[0]?.invalidations).toHaveLength(1)
    expect(observed[0]?.resolutions).toEqual(
      decision.resolutions.concat([expect.objectContaining({ resolution: 'accepted' })]),
    )
    await s.client.ok('POST', `${s.root}/stop`)
    await ctx.daemon?.stop()
    const directory = path.join(tedPaths(ctx.home).store, 'ted')
    for (const file of await readdir(directory)) {
      if (file.startsWith('state')) await rm(path.join(directory, file), { force: true })
    }
    ctx.daemon = await startDaemon({ home: ctx.home, version: '9.9.9', claudeBin: stubClaudePath })
    const client = api(ctx.daemon.port, { appKey: ctx.daemon.appToken })
    expect(await client.call('GET', `${s.root}/failures`)).toMatchObject({ body: observed })
    expect(await client.call('GET', `${s.root}/validation-obligations`)).toMatchObject({
      status: 200,
      body: {
        satisfied: false,
        blockers: [decision.id],
        cases: [{ disposition: 'invalidated', context: 'current' }],
      },
    })
    expect(
      (
        await client.call('POST', `${s.root}/failures/${decision.id}/resolve`, {
          requestId: decision.decisions.at(-1)?.commentId,
          resolution: 'accepted',
        })
      ).status,
    ).toBe(409)
  },
)

test('authorization separates lead, sub-agent, own-Task and human operations, and an explicit failure holds forward movement before a Gate can be approved', async () => {
  const s = await setup()
  const briefFile = path.join(ctx.scratch, 'advance-brief.md')
  await writeFile(
    briefFile,
    '## Goal\nTest\n## Decisions so far\nNone\n## Current state\nReady\n## Open questions\nNone\n## Next step\nAdvance\n',
  )
  await s.lead.call('PUT', `${s.root}/brief`, { text: await readFile(briefFile, 'utf8') })
  const unassessed = await s.record()
  const advance = await s.lead.call('POST', `${s.root}/outcome`, { outcome: 'advance' })
  expect(advance.status).toBe(409)
  expect((await getTask(s.client, s.task.id)).stage).toBe('intake')

  const context = await s.capture()
  const decision = await s.request(await s.record(context.id))
  expect((await s.lead.call('GET', `${s.root}/failure-contexts/${context.id}`)).body).toEqual(
    context,
  )
  const route = `${s.root}/failures/${decision.id}`
  const file = api(ctx.daemon?.port ?? 0, await tokenFor(ctx.home))
  for (const caller of [s.lead, file]) {
    expect(
      (
        await caller.call('POST', `${route}/resolve`, {
          requestId: decision.decisions[0]?.commentId,
          resolution: 'accepted',
        })
      ).status,
    ).toBe(403)
  }
  for (const caller of [s.client, file]) {
    expect(
      (
        await caller.call('POST', `${route}/assessments`, {
          assessment: 'regression',
          recommendation: 'Fix',
        })
      ).status,
    ).toBe(403)
  }
  const other = await s.client.ok<Task>('POST', '/tasks', { title: 'other', factory: 'NB' })
  expect((await s.lead.call('GET', `/tasks/${other.id}/failures`)).status).toBe(403)
  expect(
    (
      await s.lead.call('POST', `${s.root}/failures`, {
        source: { kind: 'finding', runId: 'missing', finding: 'Oops' },
        evidence: 'test',
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await s.lead.call('POST', `${s.root}/failures`, {
        source: { kind: 'factory-check', checkRunId: 'missing', position: 0 },
        evidence: 'test',
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await s.lead.call('POST', `${route}/evidence`, {
        evidence: 'https://user:pass@example.com/log',
      })
    ).status,
  ).toBe(400)

  const response = await s.lead.call('POST', `${s.root}/sub-agents`, {
    agent: 'claude',
    prompt: '{"steps":[{"endTurn":true}]}',
  })
  expect(response.status).toBe(201)
  const subId = (response.body as { id: string }).id
  await waitUntil(
    async () => (await s.client.call('GET', `/runs/${subId}`)).status === 200,
    'sub-agent Run',
  )
  const sub = api(ctx.daemon?.port ?? 0, s.tokens.issue(subId))
  expect((await sub.call('GET', `${s.root}/failures`)).status).toBe(200)
  expect(
    (
      await sub.call('POST', `${s.root}/failures/${unassessed.id}/assessments`, {
        assessment: 'unrelated',
        recommendation: 'Accept',
      })
    ).status,
  ).toBe(403)
})

test('outstanding cases and Inbox requests survive restart; a fresh Task Lead rejects borrowed contexts for historical Findings', async () => {
  const s = await setup()
  const context = await s.capture()
  const decision = await s.request(await s.record(context.id))
  await s.client.ok('POST', `${s.root}/stop`)
  await ctx.daemon?.stop()
  ctx.daemon = await startDaemon({ home: ctx.home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(ctx.daemon.port, { appKey: ctx.daemon.appToken })
  expect((await client.call('GET', `${s.root}/failures`)).body).toEqual([decision])
  expect((await client.call('GET', `${s.root}/validation-obligations`)).body).toMatchObject({
    satisfied: false,
    blockers: [decision.id],
  })
  expect(JSON.stringify((await client.call('GET', '/inbox')).body)).toContain(
    decision.decisions[0]?.commentId,
  )
  await client.call('POST', `${s.root}/resume`, {})
  const fresh = await waitUntil(async () => {
    const response = await client.call('GET', '/tasks')
    return (response.body as Task[]).find(
      (t) => t.id === s.task.id && t.leadRunId !== s.task.leadRunId && t.runs[0]?.state === 'idle',
    )
  }, 'fresh Task Lead')
  const stale = api(ctx.daemon.port, s.tokens.issue(s.task.leadRunId ?? ''))
  expect(
    (
      await stale.call('POST', `${s.root}/failures/${decision.id}/assessments`, {
        assessment: 'uncertain',
        recommendation: 'Investigate',
      })
    ).status,
  ).toBe(403)
  const lead = api(ctx.daemon.port, s.tokens.issue(fresh.leadRunId ?? ''))
  expect((await lead.call('GET', `${s.root}/failures`)).status).toBe(200)
  expect(
    (
      await client.call('POST', `${s.root}/failures/${decision.id}/resolve`, {
        requestId: decision.decisions[0]?.commentId,
        resolution: 'fixed',
        reason: 'Repaired and verified.',
      })
    ).status,
  ).toBe(200)
  const capture = await lead.call('POST', `${s.root}/failure-contexts`, {})
  expect(capture.status).toBe(201)
  const historicalContext = capture.body as FailureContext
  const source = { kind: 'finding', runId: s.task.leadRunId, finding: 'Historical observation' }
  expect(
    (
      await lead.call('POST', `${s.root}/failures`, {
        source,
        evidence: 'Original',
        contextId: historicalContext.id,
      })
    ).status,
  ).toBe(409)
  const recorded = await lead.call('POST', `${s.root}/failures`, { source, evidence: 'Original' })
  expect(recorded.status).toBe(201)
  const value = recorded.body as FailureCase
  expect(value.source).toEqual(source)
  expect(value.contextId).toBeUndefined()
  expect(
    (
      await lead.call('POST', `${s.root}/failures/${value.id}/assessments`, {
        assessment: 'uncertain',
        recommendation: 'Resolve explicitly',
      })
    ).status,
  ).toBe(200)
  const request = await lead.call('POST', `${s.root}/failures/${value.id}/decision`, {})
  expect(request.status).toBe(201)
  const asked = request.body as FailureCase
  const resolveHistorical = (resolution: string, reason?: string) =>
    client.call('POST', `${s.root}/failures/${value.id}/resolve`, {
      requestId: asked.decisions.at(-1)?.commentId,
      resolution,
      ...(reason && { reason }),
    })
  expect((await resolveHistorical('accepted')).status).toBe(409)
  expect((await resolveHistorical('fixed', 'Verified separately')).status).toBe(200)
})

test('stored failed Checks retain factual outcomes after acceptance and reject borrowed late contexts', async () => {
  const s = await setup([
    'stages:',
    '  validate:',
    '    checks:',
    '      - { name: Fail, run: "exit 1" }',
  ])
  const worktree = s.task.repos[0]?.worktree ?? ''
  await writeFile(path.join(worktree, 'README.md'), '# changed\n')
  const { run } = await import('./merge-harness.ts')
  await run(
    'git',
    ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-am', 'Change tested code'],
    { cwd: worktree },
  )
  const context = await s.capture()
  const started = await s.ok<import('@ted/protocol').CheckRun>('/checks')
  const report = await waitUntil(async () => {
    const result = await s.client.ok<import('@ted/protocol').CheckRunReport>(
      'GET',
      `/check-runs/${started.id}`,
    )
    return result.checkRun.finishedAt ? result : undefined
  }, 'Check execution to finish')
  expect(report.checkRun.outcome).toBe('failed')
  const source = { kind: 'factory-check', checkRunId: report.checkRun.id, position: 0 }
  expect(
    (
      await s.lead.call('POST', `${s.root}/failures`, {
        source: { ...source, kind: 'post-rebase-check' },
        evidence: 'Wrong trigger',
      })
    ).status,
  ).toBe(400)
  const late = await s.capture()
  expect(
    (
      await s.lead.call('POST', `${s.root}/failures`, {
        source,
        evidence: 'Late',
        contextId: late.id,
      })
    ).status,
  ).toBe(409)
  const value = await s.ok<FailureCase>('/failures', {
    source,
    evidence: 'Failed command',
    contextId: context.id,
  })
  expect(value.originalCheck?.state).toBe('failed')
  const decision = await s.request(value)
  expect((await s.resolve(decision)).status).toBe(200)
  const read = await s.client.ok<import('@ted/protocol').CheckRunReport>(
    'GET',
    `/check-runs/${report.checkRun.id}`,
  )
  expect(read.checkRun).toEqual(report.checkRun)
  expect((await s.obligations()).checkRuns.find((r) => r.id === report.checkRun.id)?.outcome).toBe(
    'failed',
  )
})

test('invalidation notices survive health suspension and restart and reach the resumed session once', async () => {
  const client = await start({ order: 'intake, work, merge' })
  const go = path.join(ctx.scratch, 'go')
  const task = await client.ok<Task>('POST', '/tasks', {
    title: JSON.stringify({ steps: [{ waitFor: go }, { authError: true }, { exit: 1 }] }),
    factory: 'NB',
    start: true,
  })
  const first = await waitUntil(async () => {
    const t = await getTask(client, task.id)
    return t.leadRunId ? t : undefined
  }, 'original session')
  const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
  const lead = api(ctx.daemon?.port ?? 0, tokens.issue(first.leadRunId ?? ''))
  const post = async <T>(suffix: string, body: unknown = {}): Promise<T> => {
    const result = await lead.call('POST', `/tasks/${task.id}${suffix}`, body)
    expect(result.status, JSON.stringify(result.body)).toBeLessThan(300)
    return result.body as T
  }
  const context = await post<FailureContext>('/failure-contexts')
  const value = await post<FailureCase>('/failures', {
    source: { kind: 'finding', runId: first.leadRunId, finding: 'Known failure' },
    evidence: 'Observed',
    contextId: context.id,
  })
  await post(`/failures/${value.id}/assessments`, {
    assessment: 'unrelated',
    recommendation: 'Accept',
  })
  const asked = await post<FailureCase>(`/failures/${value.id}/decision`)
  await client.ok('POST', `/tasks/${task.id}/failures/${value.id}/resolve`, {
    requestId: asked.decisions.at(-1)?.commentId,
    resolution: 'accepted',
  })
  await writeFile(path.join(ctx.home, 'stub-claude.json'), JSON.stringify({ signedIn: false }))
  await writeFile(go, '')
  await waitUntil(
    async () => (await getTask(client, task.id)).status?.kind === 'paused',
    'health-held session',
  )
  await writeFile(
    path.join(first.repos[0]?.worktree ?? '', 'changed.txt'),
    'changed while suspended',
  )
  expect(await client.ok('GET', `/tasks/${task.id}/validation-obligations`)).toMatchObject({
    satisfied: false,
  })
  const notices = await client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)
  const notice = notices.find((c) => c.title === 'Failure acceptance invalidated')
  expect(notice).toBeDefined()
  expect(notice?.delivered).toBeUndefined()
  const original = await client.ok<{ run: { sessionId: string } }>(
    'GET',
    `/runs/${first.leadRunId}`,
  )
  await ctx.daemon?.stop()
  ctx.daemon = await startDaemon({
    home: ctx.home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    fixPollMs: 100,
    checkAgentsOnStart: true,
  })
  const restarted = api(ctx.daemon.port, { appKey: ctx.daemon.appToken })
  await writeFile(path.join(ctx.home, 'stub-claude.json'), JSON.stringify({ signedIn: true }))
  expect((await restarted.call('POST', '/agents/health/check', {})).status).toBe(200)
  const resumed = await waitUntil(async () => {
    const response = await restarted.call('GET', '/tasks')
    const t = (response.body as Task[]).find((t) => t.id === task.id)
    return t?.leadRunId && t.leadRunId !== first.leadRunId ? t : undefined
  }, 'saved session recovery')
  const delivered = await waitUntil(async () => {
    const result = await restarted.call('GET', `/tasks/${task.id}/comments`)
    return (result.body as Comment[]).find((c) => c.id === notice?.id && c.delivered)
  }, 'notice delivery')
  expect(delivered.delivered?.runId).toBe(resumed.leadRunId)
  const launch = JSON.parse(
    await readFile(path.join(ctx.home, 'runs', resumed.leadRunId ?? '', 'launch.json'), 'utf8'),
  ) as { args: string[] }
  expect(launch.args[launch.args.indexOf('--resume') + 1]).toBe(original.run.sessionId)
  const result = await restarted.call('GET', `/runs/${resumed.leadRunId}`)
  const prompt = (result.body as { run: { prompt: string } }).run.prompt
  expect(prompt.split(notice?.body ?? 'missing notice')).toHaveLength(2)
  const again = await restarted.call('GET', `/tasks/${task.id}/validation-obligations`)
  expect(again.status).toBe(200)
  expect(
    ((await restarted.call('GET', `/tasks/${task.id}/comments`)).body as Comment[]).filter(
      (c) => c.title === notice?.title,
    ),
  ).toHaveLength(1)
})

test('a failure notice uses steering at the next tool boundary and retains its TED author', async () => {
  const client = await start({ order: 'intake, work, merge' })
  const boundary = path.join(ctx.scratch, 'notice-boundary')
  const finish = path.join(ctx.scratch, 'notice-finish')
  const task = await client.ok<Task>('POST', '/tasks', {
    title: JSON.stringify({
      steps: [{ waitFor: boundary }, { tool: 'Bash' }, { waitFor: finish }, { endTurn: true }],
    }),
    factory: 'NB',
    start: true,
  })
  const working = await waitUntil(async () => {
    const t = await getTask(client, task.id)
    return t.runs[0]?.state === 'working' ? t : undefined
  }, 'working Task Lead')
  const tokens = await loadRunTokens(tedPaths(ctx.home).runTokenKey)
  const lead = api(ctx.daemon?.port ?? 0, tokens.issue(working.leadRunId ?? ''))
  const root = `/tasks/${task.id}`
  const post = async <T>(suffix: string, body: unknown = {}): Promise<T> => {
    const result = await lead.call('POST', root + suffix, body)
    expect(result.status, JSON.stringify(result.body)).toBeLessThan(300)
    return result.body as T
  }
  const context = await post<FailureContext>('/failure-contexts')
  const value = await post<FailureCase>('/failures', {
    source: { kind: 'finding', runId: working.leadRunId, finding: 'Known failure' },
    evidence: 'Observed',
    contextId: context.id,
  })
  await post(`/failures/${value.id}/assessments`, {
    assessment: 'unrelated',
    recommendation: 'Accept',
  })
  const asked = await post<FailureCase>(`/failures/${value.id}/decision`)
  await client.ok('POST', `${root}/failures/${value.id}/resolve`, {
    requestId: asked.decisions.at(-1)?.commentId,
    resolution: 'accepted',
  })
  await writeFile(path.join(working.repos[0]?.worktree ?? '', 'changed.txt'), 'new context')
  expect(await client.ok('GET', `${root}/validation-obligations`)).toMatchObject({
    satisfied: false,
  })
  const notices = await client.ok<Comment[]>('GET', `${root}/comments`)
  const notice = notices.find((c) => c.title === 'Failure acceptance invalidated')
  expect(notice).toBeDefined()
  expect(notice?.author).toEqual({ kind: 'ted' })
  expect(notice?.delivered).toBeUndefined()
  await writeFile(boundary, '')
  await waitUntil(async () => {
    const comments = await client.ok<Comment[]>('GET', `${root}/comments`)
    return comments.find((c) => c.id === notice?.id)?.delivered?.runId === working.leadRunId
  }, 'failure notice delivered at tool boundary')
  expect((await getTask(client, task.id)).runs[0]?.state).toBe('working')
  const forwarded = await waitUntil(async () => {
    const chat = await client.ok<RunChat>('GET', `/runs/${working.leadRunId}/chat`)
    const messages = chat.items.flatMap((item) =>
      item.kind === 'ted' && item.text.includes(notice?.body ?? 'missing') ? [item.text] : [],
    )
    return messages.length > 0 ? messages : undefined
  }, 'failure notice received in the Run chat')
  expect(forwarded).toHaveLength(1)
  expect(forwarded[0]).not.toContain('The human posted a Comment')
  expect(await client.ok('GET', `${root}/validation-obligations`)).toMatchObject({
    satisfied: false,
  })
  expect(
    (await client.ok<Comment[]>('GET', `${root}/comments`)).filter(
      (c) => c.title === notice?.title,
    ),
  ).toHaveLength(1)
  await writeFile(finish, '')
})
