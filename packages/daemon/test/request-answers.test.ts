import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AnswerRequest, Comment, FailureCase, RequestPurpose } from '@ted/protocol'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { type NewComment, openStore, type TedStore } from '../src/store/index.ts'
import { createRequestAnswers, type RequestAnswerPort } from '../src/tasks/request-answers.ts'
import { resolveWorkflow } from '../src/workflow/resolve.ts'

let directory: string
let store: TedStore
let taskId: string
let effects: string[]
let port: RequestAnswerPort
const unexpected = (): never => {
  throw new Error('unexpected effect')
}
const at = () => new Date().toISOString()

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'ted-request-answers-'))
  store = await openStore({ directory })
  taskId = (await store.createTask({ title: 'Answer requests' })).id
  effects = []
  port = {
    store,
    find: (id) => {
      const task = store.getTask(id)
      if (!task) throw new Error('missing Task')
      return task
    },
    untilFree: async () => {},
    holding: async (_task, work) => work(),
    failures: { findDecision: () => undefined, resolve: unexpected },
    humanComment: unexpected,
    answerProposal: unexpected,
    answerSimulator: unexpected,
    answerRunPermission: unexpected,
    answerLinearTeam: unexpected,
    answerSizeCheck: unexpected,
    answerCiStuck: unexpected,
    resumeByHand: unexpected,
    answerRequest: (_task, comment, answer, drafts) =>
      store.answerComment(comment.id, answer, drafts),
    drafts: (id) => store.lineCommentDrafts(id).map((d) => d.id),
    deliverAnswer: async () => {
      effects.push('delivered')
    },
    gateWorkflow: async () => ({
      workflow: { ...resolveWorkflow([]), next: () => 'done' },
      layers: [],
    }),
    requireObligations: async () => {
      effects.push('obligations')
    },
    bindApproval: async () => {
      effects.push('approval')
    },
    liveLead: () => undefined,
    startMerging: () => {
      effects.push('merge')
    },
    watchMerge: () => {},
    deliver: async () => true,
    pullRequestWork: () => {},
    move: async () => {
      effects.push('moved')
      return port.find(taskId)
    },
    answerLoopAsk: unexpected,
    settleDependents: () => {
      effects.push('unblocked')
    },
    archiveNow: () => {
      effects.push('archived')
      return port.find(taskId)
    },
    wake: () => {},
    sendNudge: async () => {
      effects.push('nudged')
    },
    useDefaultModel: async () => {
      effects.push('default-model')
      return port.find(taskId)
    },
    linesText: () => undefined,
    gateName: () => 'Design Gate',
    firstLine: (text) => text.split('\n')[0] ?? '',
  }
})
afterEach(async () => {
  vi.useRealTimers()
  await store.close()
  await rm(directory, { recursive: true, force: true })
})

const post = (purpose: RequestPurpose, extra: Partial<NewComment> = {}) =>
  store.postComment({
    taskId,
    kind: 'question',
    author: { kind: 'ted' },
    body: 'Reworded',
    title: 'Reworded',
    purpose,
    ...extra,
  })
const answer = (
  comment: Comment,
  request: AnswerRequest = { action: 'answer', choice: 'Continue' },
  sendDrafts = true,
) => createRequestAnswers(port)(comment.id, request, sendDrafts)
const finish = (comment: Comment) => store.answerComment(comment.id, { kind: 'answered', at: at() })

test('an ordinary answer leaves the Inbox once and is delivered, while repeat answers are rejected', async () => {
  const comment = post({ kind: 'question' })
  expect(await answer(comment, { action: 'answer', text: 'My answer' })).toMatchObject({
    answer: { kind: 'answered', text: 'My answer' },
  })
  expect(store.listOpenRequests()).toEqual([])
  expect(effects).toEqual(['delivered'])
  await expect(answer(comment, { action: 'answer', text: 'Again' })).rejects.toThrow(
    'already been answered',
  )
  expect(effects).toEqual(['delivered'])
})

test.each([
  { action: 'approve' as const },
  { action: 'answer' as const, choice: 'Unknown' },
  { action: 'answer' as const, text: ' ' },
  { action: 'accept-recommended' as const },
])('invalid ordinary answers have no effects: %j', async (request) => {
  const comment = post({ kind: 'question' }, { choices: ['Continue'] })
  await expect(answer(comment, request)).rejects.toThrow()
  expect(store.getComment(comment.id)?.answer).toBeUndefined()
  expect(effects).toEqual([])
})

test.each(['proposal', 'simulator', 'size-check', 'ci-stuck', 'linear-team', 'send-back'] as const)(
  '%s dispatch is independent of title and choice wording',
  async (kind) => {
    const handler = async (_task: unknown, comment: Comment) => {
      effects.push(kind)
      return finish(comment)
    }
    const comment = post({ kind }, { choices: ['Continue'] })
    port.answerProposal = handler
    port.answerSimulator = async (c) => handler(undefined, c)
    port.answerSizeCheck = handler
    port.answerCiStuck = handler
    port.answerLinearTeam = (_t, c) => {
      effects.push(kind)
      return finish(c)
    }
    port.answerLoopAsk = handler
    await answer(
      comment,
      kind === 'proposal' || kind === 'simulator'
        ? { action: 'approve' }
        : { action: 'answer', choice: 'Continue' },
    )
    expect(effects).toEqual([kind])
    expect(store.listOpenRequests()).toEqual([])
  },
)

test('the stored Linear purpose archives the Task without delivering the answer to its Run', async () => {
  await answer(post({ kind: 'linear-closed' }, { choices: ['Archive'] }), {
    action: 'answer',
    choice: 'Archive',
  })
  expect(effects).toEqual(['unblocked', 'archived'])
})

test('the stored idle purpose nudges its current Lead', async () => {
  const run = store.startRun({
    id: 'lead',
    taskId,
    agent: 'claude',
    cwd: directory,
    prompt: 'Work',
  })
  port.liveLead = () => run
  await answer(post({ kind: 'idle-run' }, { choices: ['Nudge again'] }), {
    action: 'answer',
    choice: 'Nudge again',
  })
  expect(effects).toEqual(['nudged'])
})

test('a Gate approves only after checking obligations and advances, without sending drafts', async () => {
  const comment = post({ kind: 'gate' }, { kind: 'review', gate: { approveLabel: 'Approve' } })
  await expect(answer(comment)).rejects.toThrow('Approve or Request changes')
  await answer(comment, { action: 'approve' })
  expect(effects).toEqual(['obligations', 'approval', 'moved'])
  expect(store.getComment(comment.id)?.answer?.kind).toBe('approved')
  expect(store.listOpenRequests()).toEqual([])
})

test('a Gate keeps its request open when obligations fail', async () => {
  port.requireObligations = async () => {
    throw new Error('unresolved failure')
  }
  const comment = post({ kind: 'gate' }, { kind: 'signoff', gate: { approveLabel: 'Approve' } })
  await expect(answer(comment, { action: 'approve' })).rejects.toThrow('unresolved failure')
  expect(store.getComment(comment.id)?.answer).toBeUndefined()
  expect(effects).toEqual([])
})

test('Request changes requires words and delivers them without approving', async () => {
  const comment = post({ kind: 'gate' }, { kind: 'review', gate: { approveLabel: 'Approve' } })
  await expect(answer(comment, { action: 'request-changes', text: ' ' })).rejects.toThrow(
    'needs your comment',
  )
  await answer(comment, { action: 'request-changes', text: 'Please repair' })
  expect(store.getComment(comment.id)?.answer).toMatchObject({
    kind: 'changes-requested',
    text: 'Please repair',
  })
  expect(effects).toEqual(['delivered'])
})

test('a failure decision uses its specialist, while a text follow-up leaves the decision open', async () => {
  const comment = post({ kind: 'failure' })
  const failure: FailureCase = {
    id: 'failure',
    taskId,
    source: { kind: 'finding', runId: 'lead', finding: 'Example' },
    recordedBy: 'lead',
    provenance: 'task-lead-reported',
    evidence: 'Failed',
    createdAt: at(),
    assessments: [],
    additions: [],
    decisions: [],
    resolutions: [],
    invalidations: [],
  }
  port.failures.findDecision = () => failure
  port.failures.resolve = async (_task, _id, request, sendDrafts) => {
    effects.push(`resolved:${request.resolution}:${sendDrafts}`)
    finish(comment)
    return failure
  }
  port.humanComment = async (_task, text, _files, sendDrafts) => {
    effects.push(`follow-up:${sendDrafts}`)
    return store.postComment({ taskId, body: text, author: { kind: 'human' } })
  }
  await answer(comment, { action: 'answer', text: 'More context' }, false)
  expect(store.getComment(comment.id)?.answer).toBeUndefined()
  await answer(comment, { action: 'answer', choice: 'Accept this failure' }, false)
  expect(effects).toEqual(['follow-up:false', 'resolved:accepted:false'])
})

test('a failed Run’s Retry uses the existing resume effect', async () => {
  const comment = post({ kind: 'failed-run' }, { choices: ['Retry'] })
  port.resumeByHand = async (_id, options) => {
    effects.push(`retry:${options.sendDrafts}`)
    finish(comment)
    return port.find(taskId)
  }
  await answer(comment, { action: 'answer', choice: 'Retry' }, false)
  expect(effects).toEqual(['retry:false'])
})

test('a stored model answer works with a freshly constructed router, without runtime identity maps', async () => {
  store.startRun({ id: 'model-run', taskId, agent: 'claude', cwd: directory, prompt: 'Work' })
  store.recordRunOutput('model-run', { toOffset: 0, problem: 'model-unavailable' })
  port.liveLead = () => store.getRun('model-run')
  const comment = post(
    { kind: 'model', runId: 'model-run' },
    { choices: ['Use the default model'] },
  )
  await answer(comment, { action: 'answer', choice: 'Use the default model' })
  expect(effects).toEqual(['default-model'])
  expect(store.getComment(comment.id)?.answer).toMatchObject({
    kind: 'answered',
    choice: 'Use the default model',
  })
  expect(store.listOpenRequests()).toEqual([])
})

test('an old model question cannot change a replacement Run', async () => {
  const comment = post(
    { kind: 'model', runId: 'previous-run' },
    { choices: ['Use the default model'] },
  )
  await expect(
    answer(comment, { action: 'answer', choice: 'Use the default model' }),
  ).rejects.toThrow('waiting Task Lead')
  expect(effects).toEqual([])
  expect(store.getComment(comment.id)?.answer).toBeUndefined()
})

test.each([true, false])(
  'human words send drafts only for a direct human answer (sendDrafts: %s)',
  async (sendDrafts) => {
    const draft = store.draftLineComment({
      taskId,
      repo: 'widgets',
      path: 'app.ts',
      side: 'new',
      start: 1,
      end: 1,
      commit: 'head',
      quoted: [],
      body: 'Please fix this line',
    })
    const comment = post({ kind: 'question' })
    await answer(comment, { action: 'answer', text: 'Please fix this' }, sendDrafts)
    expect(store.lineCommentDrafts(taskId).map((d) => d.id)).toEqual(sendDrafts ? [] : [draft.id])
    expect(store.getComment(comment.id)?.lineComments?.map((d) => d.id) ?? []).toEqual(
      sendDrafts ? [draft.id] : [],
    )
  },
)

test('Approve leaves line drafts unsent', async () => {
  const draft = store.draftLineComment({
    taskId,
    repo: 'widgets',
    path: 'app.ts',
    side: 'new',
    start: 1,
    end: 1,
    commit: 'head',
    quoted: [],
    body: 'A draft',
  })
  await answer(post({ kind: 'gate' }, { kind: 'review', gate: { approveLabel: 'Approve' } }), {
    action: 'approve',
  })
  expect(store.lineCommentDrafts(taskId).map((d) => d.id)).toEqual([draft.id])
})

test.each(['withdrawn', 'superseded'] as const)(
  '%s requests cannot deliver another answer',
  async (kind) => {
    const comment = post({ kind: 'question' })
    store.answerComment(
      comment.id,
      kind === 'withdrawn'
        ? { kind, at: at(), cancelled: true }
        : { kind, at: at(), by: 'replacement' },
    )
    await expect(answer(comment, { action: 'answer', text: 'Too late' })).rejects.toThrow(
      kind === 'withdrawn' ? 'withdrawn' : 'replaced',
    )
    expect(effects).toEqual([])
  },
)

test('a round validates every answer, records it once and delivers the accepted recommendations', async () => {
  const comment = post(
    { kind: 'round' },
    {
      kind: 'round',
      round: { number: 1, questions: [{ question: 'Which option?', recommended: 'A' }] },
    },
  )
  await expect(answer(comment, { action: 'answer-round', answers: [] })).rejects.toThrow(
    'answer all 1 questions',
  )
  expect(effects).toEqual([])
  await answer(comment, { action: 'accept-recommended' })
  expect(store.getComment(comment.id)?.answer).toMatchObject({
    kind: 'answered',
    answers: [{ answer: 'A', changed: false }],
  })
  expect(effects).toEqual(['delivered'])
  await expect(answer(comment, { action: 'accept-recommended' })).rejects.toThrow(
    'already been answered',
  )
})

test.each(['approve', 'deny'] as const)(
  'a permission %s uses only the recorded Run, generation and input',
  async (action) => {
    store.startRun({
      id: 'permission-run',
      taskId,
      agent: 'claude',
      cwd: directory,
      prompt: 'Work',
    })
    store.recordRunOutput('permission-run', {
      toOffset: 0,
      permissionPrompts: [
        {
          requestId: 'request-1',
          generation: 7,
          title: 'A new title',
          command: 'Write',
          input: { path: '/tmp/example' },
        },
      ],
    })
    const comment = store.listOpenRequests()[0]
    if (!comment) throw new Error('missing permission')
    const replies: Parameters<RequestAnswerPort['answerRunPermission']>[] = []
    port.answerRunPermission = async (...reply) => {
      replies.push(reply)
    }
    await expect(answer(comment, { action: 'answer', text: 'yes' })).rejects.toThrow(
      'Approve or Deny',
    )
    await answer(comment, { action, text: 'My reason' })
    expect(replies).toMatchObject([
      [
        'permission-run',
        7,
        { requestId: 'request-1', approved: action === 'approve', input: { path: '/tmp/example' } },
      ],
    ])
    expect(store.getComment(comment.id)?.answer).toMatchObject({
      kind: action === 'approve' ? 'approved' : 'denied',
      text: 'My reason',
    })
    expect(store.listOpenRequests()).toEqual([])
    await expect(answer(comment, { action })).rejects.toThrow('already been answered')
    expect(replies).toHaveLength(1)
  },
)

test('a model question from an earlier problem cannot switch the same Run after a new model failure', async () => {
  store.startRun({ id: 'reused-run', taskId, agent: 'claude', cwd: directory, prompt: 'Work' })
  store.recordRunOutput('reused-run', { toOffset: 0, problem: 'model-unavailable' })
  const comment = post(
    { kind: 'model', runId: 'reused-run' },
    { choices: ['Use the default model'] },
  )
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 1000)
  store.restartRun('reused-run', { model: 'another-model' })
  store.recordRunOutput('reused-run', { toOffset: 0, problem: 'model-unavailable' })
  port.liveLead = () => store.getRun('reused-run')
  await expect(
    answer(comment, { action: 'answer', choice: 'Use the default model' }),
  ).rejects.toThrow('waiting Task Lead')
  const current = post(
    { kind: 'model', runId: 'reused-run' },
    { choices: ['Use the default model'] },
  )
  await answer(current, { action: 'answer', choice: 'Use the default model' })
  expect(effects).toEqual(['default-model'])
})
