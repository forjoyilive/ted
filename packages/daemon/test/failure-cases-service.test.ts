import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FailureCase } from '@ted/protocol'
import { afterEach, expect, test, vi } from 'vitest'
import { RequestError } from '../src/errors.ts'
import { openStore } from '../src/store/index.ts'
import { createFailureCases, failureText } from '../src/tasks/failure-cases.ts'

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
  const worktree = { fingerprint: 'A', readable: true }
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
        fingerprint: worktree.fingerprint,
        repos: [],
        checks: 'checks',
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
  return {
    service,
    task,
    worktree,
    capture,
    record,
    assess,
    decision,
    request,
    evidence,
    resolve,
    obligations,
    comment,
  }
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
  expect(question?.body).toContain('Reproduced in the stub')
  expect(question?.body).toContain('New reproduction:')
  expect(question?.body).not.toContain(secret)
  expect(question?.body).toContain(`Original tested context: ${context.id}`)
  expect(question?.body).toContain(`Decision tested context: ${current.id}`)
  expect(question?.body).toContain(lead)
  expect(asked.evidence).toBe(first.evidence)
  expect((await s.resolve(asked)).resolutions.at(-1)?.resolution).toBe('accepted')
})
