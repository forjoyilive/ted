import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FailureCase, FailureContext } from '@ted/protocol'
import { shortReference } from '@ted/protocol/reference'
import { afterEach, expect, test, vi } from 'vitest'
import { RequestError } from '../src/errors.ts'
import { openStore } from '../src/store/index.ts'
import { acceptRefusals, createFailureCases, failureText } from '../src/tasks/failure-cases.ts'

const lead = 'run-lead-7f3a'
const secret = 'abcdefghijklmnopqrstuvwxyz'
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ted-failure-service-'))
  const store = await openStore({ directory })
  cleanups.push(async () => {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  })
  const task = await store.createTask({ title: 'Failure cases' })
  store.startRun({ id: lead, taskId: task.id, agent: 'codex', prompt: '', cwd: directory })
  const worktree = { fingerprint: 'A', readable: true, base: 'base-1', head: 'head-1' }
  let reads = 0
  const service = createFailureCases({
    store,
    snapshot: async () => {
      if (!worktree.readable) throw new Error('No worktree')
      return {
        id: `context-${reads++}`,
        taskId: task.id,
        version: 2,
        capturedAt: new Date().toISOString(),
        fingerprint: `${worktree.fingerprint}-${worktree.base}-${worktree.head}`,
        repos: [
          {
            repo: 'acme/widgets',
            head: worktree.head,
            base: worktree.base,
            tree: 'tree-1',
            mergeBase: 'merge-base-1',
          },
        ],
        checks: worktree.fingerprint,
      }
    },
    assertLead: () => {},
    drafts: () => [],
    onHold: async () => {},
    onInvalidated: async () => {},
    tell: async () => {},
  })
  const capture = () => service.capture(task, lead)
  const record = (contextId?: string) =>
    service.record(task, lead, {
      source: { kind: 'finding', runId: lead, finding: 'Original Finding' },
      evidence: 'Reproduced in the stub',
      ...(contextId && { contextId }),
    })
  const recordCheck = (contextId: string) => {
    const run = store.startChecks({
      taskId: task.id,
      trigger: 'validate',
      stage: 'validate',
      checks: [{ name: 'Affected tests', command: 'pnpm check', timeout: '10m', state: 'waiting' }],
    })
    store.checkStarted(run.id, 0)
    store.checkFinished(run.id, 0, { state: 'failed', durationMs: 1000, exitCode: 1 })
    store.finishChecks(run.id, 'failed')
    return service.recordCheck(task, lead, {
      source: { kind: 'factory-check', checkRunId: run.id, position: 0 },
      evidence: 'The demo reset test failed',
      contextId,
    })
  }
  const assess = (value: FailureCase) =>
    service.assess(task, value.id, lead, {
      assessment: 'unrelated',
      recommendation: 'Accept for this context',
    })
  const decision = (value: FailureCase) => service.request(task, value.id, lead)
  const request = async (value: FailureCase) => {
    await assess(value)
    return decision(value)
  }
  const evidence = (value: FailureCase, text: string, contextId?: string) =>
    service.evidence(task, value.id, lead, text, contextId)
  const resolve = (
    value: FailureCase,
    resolution: 'accepted' | 'fixed' | 'no-longer-applicable' = 'accepted',
    reason?: string,
  ) =>
    service.resolve(task, value.id, {
      requestId: value.decisions.at(-1)?.commentId ?? '',
      resolution,
      ...(reason && { reason }),
    })
  const obligations = () => service.obligations(task)
  const comment = (id?: string) => store.listComments(task.id).find((c) => c.id === id)
  const notes = (title: string) => store.listComments(task.id).filter((c) => c.title === title)
  const endRun = () =>
    store.recordRunOutput(lead, {
      toOffset: 0,
      state: 'finished',
      ending: { how: 'exited', errorLines: [], at: new Date().toISOString() },
    })
  return {
    store,
    notes,
    endRun,
    service,
    task,
    worktree,
    capture,
    record,
    recordCheck,
    assess,
    decision,
    request,
    evidence,
    resolve,
    obligations,
    comment,
  }
}

async function refusalText(work: () => unknown): Promise<string | undefined> {
  try {
    await work()
  } catch (error) {
    if (error instanceof RequestError) return error.message
    throw error
  }
  return undefined
}

async function refusal(work: () => unknown): Promise<number | undefined> {
  try {
    await work()
  } catch (error) {
    if (error instanceof RequestError) return error.status
    throw error
  }
  return undefined
}

test('failure text is redacted, bounded and refuses links that carry credentials', () => {
  expect(failureText(`Bearer ${secret}`)).toBe('Bearer [redacted]')
  expect(failureText('word '.repeat(4000))).toHaveLength(16_000)
  const numbered = 'On 195e5ce2, the command exited 1. Other 16 test failures, session 28376.'
  expect(failureText(numbered)).toBe(numbered)
  expect(() => failureText('https://user:pass@example.com/log')).toThrow(
    expect.objectContaining({ status: 400 }),
  )
})

test.each(['equal', 'backward'])(
  '%s evidence timestamps still require reassessment in append order',
  async (clock) => {
    const s = await setup()
    const context = await s.capture()
    const value = await s.record(context.id)
    const at = new Date().toISOString()
    const before = new Date(Date.parse(at) - 60_000).toISOString()
    const date = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue(at)
    try {
      const first = await s.assess(value)
      expect(first.assessments.at(-1)?.evidenceCount).toBe(0)
      if (clock === 'backward') date.mockReturnValue(before)
      const evidence = s.evidence(value, 'New evidence needs its own assessment', context.id)
      expect(evidence.additions.at(-1)?.at).toBe(clock === 'backward' ? before : at)
      expect(await refusal(() => s.decision(value))).toBe(409)
      const asked = await s.request(value)
      expect(asked.assessments.at(-1)?.evidenceCount).toBe(1)
      expect((await s.resolve(asked)).resolutions.at(-1)?.resolution).toBe('accepted')
      expect(await refusal(() => s.resolve(asked))).toBe(409)
      expect(await refusal(() => s.decision(value))).toBe(409)
    } finally {
      date.mockRestore()
    }
  },
)

test('unknown tested contexts can be closed by the human but cannot be accepted', async () => {
  const s = await setup()
  const decision = await s.request(await s.record())
  expect(await refusal(() => s.resolve(decision))).toBe(409)
  expect(
    (
      await s.resolve(
        decision,
        'no-longer-applicable',
        'This Finding described removed functionality.',
      )
    ).resolutions.at(-1)?.resolution,
  ).toBe('no-longer-applicable')
  expect((await s.obligations()).satisfied).toBe(true)
})

test('new assessments withdraw stale requests and only the latest explicit choice resolves', async () => {
  const s = await setup()
  const context = await s.capture()
  const old = await s.request(await s.record(context.id))
  const fresh = await s.request(old)
  expect(await refusal(() => s.resolve(old))).toBe(409)
  expect(s.comment(old.decisions[0]?.commentId)?.answer?.kind).toBe('withdrawn')
  await s.resolve(fresh)
  expect(s.comment(fresh.decisions.at(-1)?.commentId)?.answer).toMatchObject({
    kind: 'answered',
    choice: 'Accept this failure',
  })
  expect((await s.obligations()).satisfied).toBe(true)
})

test('context read errors hold and evidence is bounded and redacted before persistence', async () => {
  const s = await setup()
  const context = await s.capture()
  const recorded = await s.service.record(s.task, lead, {
    source: { kind: 'finding', runId: lead, finding: `Bearer ${secret}` },
    evidence: `Bearer ${secret}`,
    contextId: context.id,
  })
  expect(recorded.evidence).toBe('Bearer [redacted]')
  expect(await refusal(() => s.evidence(recorded, 'https://user:pass@example.com/log'))).toBe(400)
  const decision = await s.request(recorded)
  expect((await s.resolve(decision)).resolutions.at(-1)?.resolution).toBe('accepted')
  s.worktree.readable = false
  expect((await s.obligations()).cases[0]).toMatchObject({
    disposition: 'invalidated',
    context: 'unknown',
  })
})

test('later context cannot turn an unknown original execution into an acceptable waiver', async () => {
  const s = await setup()
  const value = await s.record()
  const context = await s.capture()
  s.evidence(value, 'Later observation', context.id)
  const asked = await s.request(value)
  expect(await refusal(() => s.resolve(asked))).toBe(409)
  expect(
    (await s.resolve(asked, 'fixed', 'The later run verified the repair.')).resolutions.at(-1)
      ?.resolution,
  ).toBe('fixed')
})

test('rejected evidence and assessments preserve requests; fresh decisions expose added evidence and context', async () => {
  const s = await setup()
  const context = await s.capture()
  const first = await s.request(await s.record(context.id))
  const id = first.decisions.at(-1)?.commentId
  const link = 'https://user:password@example.com/log'
  expect(await refusal(() => s.evidence(first, link, context.id))).toBe(400)
  expect(
    await refusal(() =>
      s.service.assess(s.task, first.id, lead, { assessment: 'uncertain', recommendation: link }),
    ),
  ).toBe(400)
  expect(s.comment(id)).toBeDefined()
  expect(s.comment(id)?.answer).toBeUndefined()
  expect((await s.resolve(first)).resolutions.at(-1)?.resolution).toBe('accepted')
  s.worktree.fingerprint = 'B'
  expect((await s.obligations()).cases[0]?.disposition).toBe('invalidated')
  const current = await s.capture()
  s.evidence(first, `New reproduction: Bearer ${secret}`, current.id)
  const asked = await s.request(first)
  const question = s.comment(asked.decisions.at(-1)?.commentId)
  expect(question?.body).toContain('The Task Lead’s assessment:')
  expect(question?.body).toContain('Recommendation:')
  expect(question?.body).toContain(`Failure ${shortReference(first.id)}`)
  expect(question?.body).not.toContain('New reproduction:')
  expect(question?.body).not.toContain(secret)
  expect(question?.body).not.toContain(context.id)
  expect(asked.decisions.at(-1)?.contextId).toBe(current.id)
  expect(asked.evidence).toBe(first.evidence)
  expect((await s.resolve(asked)).resolutions.at(-1)?.resolution).toBe('accepted')
})

test('a moved base tip alone neither blocks acceptance nor invalidates it', async () => {
  const s = await setup()
  const context = await s.capture()
  const asked = await s.request(await s.record(context.id))
  s.worktree.base = 'base-2'
  const moved = await s.capture()
  expect(moved.fingerprint).not.toBe(context.fingerprint)
  expect((await s.resolve(asked)).resolutions.at(-1)).toMatchObject({
    resolution: 'accepted',
    contextId: context.id,
  })
  s.worktree.base = 'base-3'
  expect(await s.obligations()).toMatchObject({
    satisfied: true,
    cases: [{ disposition: 'accepted', context: 'current' }],
  })
  expect(s.notes('Failure acceptance invalidated')).toEqual([])
})

test('asking again with evidence that names no context is acceptable when only the base moved', async () => {
  const s = await setup()
  const context = await s.capture()
  const value = await s.record(context.id)
  await s.request(value)
  s.worktree.base = 'base-2'
  await s.capture()
  s.evidence(value, 'Looked again')
  const again = await s.request(value)
  expect(again.decisions.at(-1)?.contextId).toBe(context.id)
  expect((await s.resolve(again)).resolutions.at(-1)?.resolution).toBe('accepted')
})

test('a changed HEAD refuses acceptance in plain words, tells the Task Lead once, and stops a stale ask', async () => {
  const s = await setup()
  const context = await s.capture()
  const value = await s.record(context.id)
  const asked = await s.request(value)
  s.worktree.base = 'base-2'
  s.worktree.head = 'head-2'
  expect(await refusalText(() => s.resolve(asked))).toBe(acceptRefusals.changed)
  expect(await refusalText(() => s.resolve(asked))).toBe(acceptRefusals.changed)
  const told = s.notes('Failure acceptance refused')
  expect(told).toHaveLength(1)
  expect(told[0]?.author).toEqual({ kind: 'ted' })
  expect(told[0]?.body).toContain(`failure case ${shortReference(value.id)}`)
  expect(told[0]?.body).toContain('`ted failure context`')
  expect(told[0]?.body).toContain(
    `\`ted failure evidence ${shortReference(value.id)} --file <json>\``,
  )
  expect(told[0]?.body).toContain(`\`ted failure ask ${shortReference(value.id)}\``)
  expect(s.comment(asked.decisions.at(-1)?.commentId)?.answer).toBeUndefined()
  s.evidence(value, 'Looked again without a new context')
  await s.assess(value)
  const stale = await refusalText(() => s.decision(value))
  expect(stale).toContain(`tested context ${shortReference(context.id)}`)
  expect(stale).toContain('`ted failure context`')
  const fresh = await s.capture()
  s.evidence(value, 'Reproduced on the new commit', fresh.id)
  const again = await s.request(value)
  expect((await s.resolve(again)).resolutions.at(-1)).toMatchObject({
    resolution: 'accepted',
    contextId: fresh.id,
  })
})

test('a stale ask is still posted when no new context could be attached or read', async () => {
  const s = await setup()
  const context = await s.capture()
  const ended = await s.record(context.id)
  const unreadable = await s.record(context.id)
  s.worktree.head = 'head-2'
  s.worktree.readable = false
  const first = await s.request(unreadable)
  expect(await refusalText(() => s.resolve(first))).toBe(acceptRefusals.unverified)
  expect(s.notes('Failure acceptance refused')).toEqual([])
  s.worktree.readable = true
  s.endRun()
  const asked = await s.request(ended)
  expect(s.comment(asked.decisions.at(-1)?.commentId)).toMatchObject({
    choices: ['Fixed', 'No longer applicable'],
    body: expect.stringContaining('This failure can’t be accepted'),
  })
  const unread = s.comment(first.decisions.at(-1)?.commentId)
  expect(unread?.choices).toContain('Accept this failure')
  expect(unread?.body).not.toContain('can’t be accepted')
  const refused = await refusalText(() => s.resolve(asked))
  expect(refused).toBe(acceptRefusals.changedForGood(false))
  expect(refused).toContain('choose Fixed or No longer applicable')
  expect(refused).not.toContain('assess it again')
  expect(s.notes('Failure acceptance refused')[0]?.body).toContain('is a new case')
  expect((await s.resolve(asked, 'fixed', 'A later commit repaired it.')).resolutions).toHaveLength(
    1,
  )
})

test('a Check failure stays acceptable with later evidence on the same code, and an ask after a change gets a card without Accept', async () => {
  const s = await setup()
  vi.useFakeTimers({ toFake: ['Date'] })
  cleanups.push(async () => {
    vi.useRealTimers()
  })
  const start = Date.parse('2026-11-16T12:00:00Z')
  vi.setSystemTime(start)
  const tested = await s.capture()
  const value = await s.recordCheck(tested.id)
  vi.setSystemTime(start + 1000)
  const later = await s.capture()
  s.evidence(value, 'The same test fails on main', later.id)
  const asked = await s.request(value)
  expect(asked.decisions.at(-1)?.contextId).toBe(later.id)
  expect(s.comment(asked.decisions.at(-1)?.commentId)?.choices).toContain('Accept this failure')
  expect((await s.resolve(asked)).resolutions.at(-1)?.resolution).toBe('accepted')
  expect(await s.obligations()).toMatchObject({
    cases: [{ disposition: 'accepted', context: 'current' }],
  })

  vi.setSystemTime(start + 2000)
  const changed = await s.recordCheck((await s.capture()).id)
  vi.setSystemTime(start + 3000)
  s.worktree.head = 'head-2'
  const asked2 = await s.request(changed)
  expect(s.comment(asked2.decisions.at(-1)?.commentId)).toMatchObject({
    choices: ['Fixed', 'No longer applicable'],
    body: expect.stringContaining('Ted can’t tie a later test run to it'),
  })
  s.evidence(changed, 'Looked at the new commit', (await s.capture()).id)
  const asked3 = await s.request(changed)
  expect(s.comment(asked3.decisions.at(-1)?.commentId)?.choices).toEqual([
    'Fixed',
    'No longer applicable',
  ])
  expect(
    (await s.resolve(asked3, 'no-longer-applicable', 'The Check changed.')).resolutions.at(-1)
      ?.resolution,
  ).toBe('no-longer-applicable')
})

test('accepting a failure with no tested context says so and tells the Task Lead to record it again', async () => {
  const s = await setup()
  const asked = await s.request(await s.record())
  expect(s.comment(asked.decisions.at(-1)?.commentId)).toMatchObject({
    choices: ['Fixed', 'No longer applicable'],
    body: expect.stringContaining('Ted has no record it can verify of what was tested'),
  })
  expect(await refusalText(() => s.resolve(asked))).toBe(acceptRefusals.unknown)
  expect(s.notes('Failure acceptance refused')[0]?.body).toContain('is a new case')
})

test('stored contexts are compared by what was tested, not by their fingerprint or base tip', async () => {
  const s = await setup()
  const changed = acceptRefusals.changedForGood(false)
  const current = await s.capture()
  s.endRun()
  const stored = (id: string, change: Partial<FailureContext>): FailureContext =>
    s.store.failures.capture({
      ...current,
      id,
      fingerprint: `sha256-of-a-context-with-its-base-tip-${id}`,
      repos: current.repos.map((r) => ({ ...r, base: 'older-base-tip' })),
      ...change,
    })
  const accept = async (context: FailureContext) =>
    refusalText(async () => s.resolve(await s.request(await s.record(context.id))))
  expect(await accept(stored('version-2', {}))).toBeUndefined()
  expect(await accept(stored('version-1', { version: 1 }))).toBe(changed)
  expect(
    await accept(
      stored('other-merge-base', {
        repos: current.repos.map((r) => ({ ...r, mergeBase: 'merge-base-0' })),
      }),
    ),
  ).toBe(changed)
  expect(
    await accept(
      stored('other-tree', { repos: current.repos.map((r) => ({ ...r, tree: 'tree-0' })) }),
    ),
  ).toBe(changed)
  expect(await accept(stored('other-ci', { ci: 'CI-A' }))).toBe(changed)
  expect(await accept(stored('other-ci-failures', { ciFailures: ['x'] }))).toBe(changed)
  expect(await accept(stored('other-checks', { checks: 'B' }))).toBe(changed)
})

test('short failure, Run and context references preserve canonical evidence and Task isolation', async () => {
  const s = await setup()
  const captured = await s.capture()
  const context = s.store.failures.capture({
    ...captured,
    id: 'abcdef01-0000-4000-8000-000000000000',
  })
  const other = await s.store.createTask({ title: 'Other Task' })
  s.store.failures.capture({
    ...context,
    taskId: other.id,
    id: 'abcdef02-0000-4000-8000-000000000000',
  })
  s.store.startRun({
    id: 'run-lead-foreign',
    taskId: other.id,
    agent: 'codex',
    prompt: '',
    cwd: '.',
  })
  const value = await s.service.record(s.task, lead, {
    source: { kind: 'finding', runId: shortReference(lead), finding: 'Short references' },
    contextId: shortReference(context.id),
    evidence: 'Original evidence',
  })
  expect(value).toMatchObject({ contextId: context.id, source: { runId: lead } })
  expect(s.service.get(s.task, shortReference(value.id)).id).toBe(value.id)
  expect(await refusal(() => s.service.get(other, shortReference(value.id)))).toBe(404)
  const updated = s.service.evidence(
    s.task,
    shortReference(value.id),
    lead,
    'Fresh evidence',
    shortReference(context.id),
  )
  expect(updated.additions.at(-1)?.contextId).toBe(context.id)
  const assessed = await s.service.assess(s.task, shortReference(value.id), lead, {
    assessment: 'unrelated',
    recommendation: 'Accept the recorded failure',
  })
  expect(assessed.assessments.at(-1)?.contextId).toBe(context.id)
  const asked = await s.service.request(s.task, shortReference(value.id), lead)
  expect(s.comment(asked.decisions.at(-1)?.commentId)?.body).toContain(
    `Failure ${shortReference(value.id)}\n`,
  )
  await s.service.resolve(s.task, shortReference(value.id), {
    requestId: asked.decisions.at(-1)?.commentId ?? '',
    resolution: 'accepted',
  })
  expect(s.store.failures.get(value.id)?.resolutions.at(-1)?.contextId).toBe(context.id)
  s.store.failures.capture({ ...context, id: 'abcdef03-0000-4000-8000-000000000000' })
  expect(
    await refusal(() => s.service.evidence(s.task, value.id, lead, 'Ambiguous context', 'abcdef')),
  ).toBe(409)
  expect(s.store.failures.get(value.id)?.additions).toHaveLength(1)
  const collisionA = { ...value, id: '12345601-0000-4000-8000-000000000000' }
  const collisionB = { ...value, id: '12345602-0000-4000-8000-000000000000' }
  s.store.failures.save(collisionA, 'recorded')
  s.store.failures.save(collisionB, 'recorded')
  expect(await refusal(() => s.service.get(s.task, '123456'))).toBe(409)
  expect(s.service.get(s.task, '12345601').id).toBe(collisionA.id)
  expect(s.service.get(s.task, collisionB.id).id).toBe(collisionB.id)
  expect(
    await refusal(() =>
      s.service.record(s.task, lead, {
        source: { kind: 'finding', runId: 'run-lead-foreign', finding: 'Wrong Task' },
        evidence: 'Must not be recorded',
      }),
    ),
  ).toBe(400)
  s.store.startRun({
    id: 'run-lead-second',
    taskId: s.task.id,
    agent: 'codex',
    prompt: '',
    cwd: '.',
  })
  expect(
    await refusal(() =>
      s.service.record(s.task, lead, {
        source: { kind: 'finding', runId: shortReference(lead), finding: 'Ambiguous Run' },
        evidence: 'Must not be recorded',
      }),
    ),
  ).toBe(409)
})

async function checkCases() {
  const s = await setup()
  vi.useFakeTimers({ toFake: ['Date'] })
  cleanups.push(async () => {
    vi.useRealTimers()
  })
  let now = Date.parse('2026-11-16T12:00:00Z')
  const tick = () => {
    now += 1000
    vi.setSystemTime(now)
  }
  tick()
  const validating = { ...s.task, stage: 'validate' }
  const fail = async (command: string) => {
    const contextId = (await s.capture()).id
    tick()
    const run = s.store.startChecks({
      taskId: s.task.id,
      trigger: 'validate',
      stage: 'validate',
      checks: [{ name: 'Affected tests', command, timeout: '10m', state: 'waiting' }],
    })
    s.store.checkStarted(run.id, 0)
    s.store.checkFinished(run.id, 0, { state: 'failed', durationMs: 1000, exitCode: 1 })
    s.store.finishChecks(run.id, 'failed')
    const value = await s.service.recordCheck(validating, lead, {
      source: { kind: 'factory-check', checkRunId: run.id, position: 0 },
      evidence: 'The demo reset test failed',
      contextId,
    })
    tick()
    return { value, run }
  }
  const ask = async (value: FailureCase) => {
    await s.assess(value)
    return s.service.request(validating, value.id, lead)
  }
  const waitForRepair = async (value: FailureCase) => {
    const asked = await ask(value)
    const repair = await s.store.createTask({ title: 'Repair the demo reset test' })
    s.store.approveRepair(
      {
        failure: asked,
        request: {
          requestId: asked.decisions.at(-1)?.commentId ?? '',
          resolution: 'repair',
          repair: { kind: 'existing', taskId: repair.id },
        },
        brief: 'Waiting for the repair',
      },
      repair,
    )
    return repair
  }
  const disposition = async (value: FailureCase) =>
    (await s.obligations()).cases.find((c) => c.id === value.id)?.disposition
  return { ...s, validating, fail, ask, waitForRepair, disposition }
}

test('a case whose repair Task was archived is replaced by a later failure of the same Check after the Check plan changed', async () => {
  const s = await checkCases()
  const { value: first } = await s.fail('pnpm check')
  const repair = await s.waitForRepair(first)
  expect(await s.obligations()).toMatchObject({ satisfied: false, blockers: [first.id] })
  s.store.archiveTask(repair.id)
  expect(await s.obligations()).toMatchObject({ satisfied: false, blockers: [first.id] })

  s.worktree.fingerprint = 'B'
  const { value: second } = await s.fail('pnpm check --changed')
  expect(await s.disposition(first)).toBe('retried')
  await s.assess(first)
  expect(await refusalText(() => s.service.request(s.validating, first.id, lead))).toContain(
    `failure ${shortReference(second.id)} replaced this case`,
  )
  const asked = await s.ask(second)
  expect(s.comment(asked.decisions.at(-1)?.commentId)?.choices).toContain('Accept this failure')
  await s.resolve(asked)
  expect(await s.obligations()).toMatchObject({
    satisfied: true,
    cases: [
      { id: first.id, disposition: 'retried' },
      { id: second.id, disposition: 'accepted' },
    ],
  })
})

test('a new failure replaces an older case of the same Check only when the command matches or the old case is no longer tied, and never one waiting on a repair', async () => {
  const s = await checkCases()
  const { value: first } = await s.fail('pnpm check')
  const { value: second, run: secondRun } = await s.fail('pnpm check --changed')
  s.service.replaceOlder(s.validating, second, secondRun.id)
  expect(await s.disposition(first)).toBe('unresolved')

  const repair = await s.waitForRepair(second)
  const { value: third, run: thirdRun } = await s.fail('pnpm check')
  s.service.replaceOlder(s.validating, third, thirdRun.id)
  expect(s.store.failures.get(first.id)?.verifications?.at(-1)).toMatchObject({
    replacedBy: third.id,
    checkRunId: thirdRun.id,
  })

  const { value: fourth, run: fourthRun } = await s.fail('pnpm check --changed')
  s.service.replaceOlder(s.validating, fourth, fourthRun.id)
  expect(s.store.failures.get(second.id)?.verifications).toBeUndefined()
  expect(await s.disposition(second)).toBe('unresolved')
  expect(s.store.getTask(repair.id)?.archived).toBeUndefined()
})

test('asking about a Validate Check failure Ted can’t tie to the current code offers Fixed and No longer applicable instead of Accept', async () => {
  const s = await checkCases()
  const { value } = await s.fail('pnpm check')
  s.worktree.head = 'head-2'
  const asked = await s.ask(value)
  expect(s.comment(asked.decisions.at(-1)?.commentId)).toMatchObject({
    choices: ['Retry', 'Fix in this Task', 'Fixed', 'No longer applicable'],
    body: expect.stringContaining('Fixed and No longer applicable close it'),
  })
  await s.resolve(asked, 'fixed', 'The Check was rewritten and passes.')
  expect(await s.obligations()).toMatchObject({ satisfied: true, blockers: [] })
})

test('a repair that merged keeps its case out of replacement after its blocker link is removed', async () => {
  const s = await checkCases()
  const { value: first } = await s.fail('pnpm check')
  const repair = await s.waitForRepair(first)
  s.store.changeStage(repair.id, 'done')
  s.store.removeBlocker(s.task.id, repair.id)
  expect(s.service.abandonedRepair(s.store.failures.get(first.id) as FailureCase)).toBe(false)
  s.worktree.fingerprint = 'B'
  await s.fail('pnpm check --changed')
  expect(await s.disposition(first)).toBe('unresolved')
})
