import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type AnswerRequest,
  type Comment,
  type FailureCase,
  type RequestPurpose,
  sizeChoices,
} from '@ted/protocol'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { type NewComment, openStore, type TedStore } from '../src/store/index.ts'
import { answerMessage } from '../src/tasks/answer-message.ts'
import { linearConnector, linearRecords } from '../src/tasks/linear-sync.ts'
import { createRequestAnswers, type RequestAnswerPort } from '../src/tasks/request-answers.ts'
import { roundAnswerMessage } from '../src/tasks/rounds.ts'
import { createTrackerConsent } from '../src/tasks/tracker-sync/consent.ts'
import { StaleCoverageError } from '../src/tasks/validation.ts'
import { resolveWorkflow } from '../src/workflow/resolve.ts'

let directory: string
let store: TedStore
let taskId: string
let effects: string[]
let archiveId = ''
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
    untilChecksReported: async () => {},
    holding: async (_task, work) => work(),
    holdingSignoff: async (_task, work) => work(),
    failures: { findDecision: () => undefined, resolve: unexpected },
    humanComment: unexpected,
    answerRunPermission: unexpected,
    withSimulatorRequest: async (_comment, work) =>
      work({ assertApp: () => {}, hasRoom: unexpected, boot: unexpected, shutDown: unexpected }),
    mergeSendBack: async () => {
      effects.push('merge-back')
    },
    startTask: async (id) => {
      effects.push(`start:${id}`)
    },
    planOutside: () => {
      effects.push('plan-outside')
    },
    stopLeadForChildren: async (id) => {
      effects.push(`stop-lead:${id}:${store.listTasks().length} Tasks`)
    },
    waitForChildren: (id) => {
      effects.push(`wait-for-children:${id}`)
    },
    resumeByHand: unexpected,
    drafts: (id) => store.lineCommentDrafts(id).map((d) => d.id),
    trackerConsents: [createTrackerConsent(store, linearConnector(), linearRecords(store))],
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
    checksThen: unexpected,
    bindApproval: async () => {
      effects.push('approval')
    },
    requireSetupAgents: async () => {},
    liveLead: () => undefined,
    startMerging: () => {
      effects.push('merge')
    },
    watchMerge: () => {},
    deliver: async () => true,
    move: async () => {
      effects.push('moved')
      return port.find(taskId)
    },
    backMessage: (_workflow, _to, _from, sendBack) => sendBack.findings,
    leaveWorkToDiagnose: unexpected,
    diagnoseInValidate: unexpected,
    stop: unexpected,
    settleDependents: () => {
      effects.push('unblocked')
    },
    archiveNow: () => {
      effects.push('archived')
      return port.find(taskId)
    },
    archiveAsked: (_task, options) => {
      effects.push(`archive-checked:${JSON.stringify(options)}`)
      return () => {
        effects.push(`archived:${store.getComment(archiveId)?.answer?.kind}`)
        return port.find(taskId)
      }
    },
    movePlanKey: async (_taskId, factoryId) => {
      effects.push(`move-checked:${factoryId}`)
      return factoryId === 'refused'
        ? { key: 'k', refusal: 'TED-1 is Done, so it can’t move' }
        : { key: `plan:${factoryId}` }
    },
    moveTask: async (id, factoryId, planKey) => {
      effects.push(`moved:${factoryId}:${planKey}:${store.getComment(archiveId)?.answer?.kind}`)
      return { task: port.find(id), moved: [{ id, from: 'TED-1', to: 'WEB-4' }] }
    },
    tellChat: async (chatId, text) => {
      effects.push(`chat:${chatId}:${text}`)
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
    gateName: () => 'Design sign-off',
    firstLine: (text) => text.split('\n')[0] ?? '',
    answerAsanaMissing: async (_task, comment) => {
      effects.push('asana-missing')
      return comment
    },
    answerAsanaUnfinished: async (_task, comment) => {
      effects.push('asana-unfinished')
      return comment
    },
    answerCleanupFailure: async (_task, comment) => {
      effects.push('cleanup-failure')
      return comment
    },
    answerMemoryKill: async (_task, comment) => {
      effects.push('memory-kill')
      return comment
    },
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

test('an archive request needs a choice, records the answer before archiving and keeps the Task on Keep it', async () => {
  const ask = (reason: string) =>
    post(
      { kind: 'archive' },
      {
        choices: ['Archive', 'Keep it'],
        archive: { reason, pullRequests: { recommend: 'close', why: 'Same changes' } },
      },
    )
  const kept = ask('Duplicate of TED-255')
  await expect(answer(kept, { action: 'answer', text: 'Hmm' })).rejects.toThrow(
    'answer with Archive or Keep it',
  )
  expect(
    await answer(kept, { action: 'answer', choice: 'Keep it', text: 'Still needed' }),
  ).toMatchObject({ answer: { kind: 'answered', choice: 'Keep it', text: 'Still needed' } })
  expect(effects).toEqual(['delivered'])
  effects = []
  const archived = ask('Duplicate of TED-255')
  archiveId = archived.id
  const options = { closePullRequests: true }
  expect(
    await answer(archived, { action: 'answer', choice: 'Archive', archive: options }),
  ).toMatchObject({
    answer: { kind: 'answered', choice: 'Archive' },
    archive: { reason: 'Duplicate of TED-255' },
  })
  expect(effects).toEqual([`archive-checked:${JSON.stringify(options)}`, 'archived:answered'])
})

test('a move request moves only on Move with the plan the user saw, after recording the answer', async () => {
  const ask = (askedBy: 'task-lead' | 'coordinator') =>
    post(
      { kind: 'move' },
      {
        choices: ['Move', 'Keep it'],
        move: {
          factoryId: 'web',
          reason: 'It changes the site',
          askedBy,
          ...(askedBy === 'coordinator' && { chatId: 'chat-1' }),
        },
      },
    )
  const lead = ask('task-lead')
  archiveId = lead.id
  await expect(answer(lead, { action: 'answer', text: 'Hmm' })).rejects.toThrow(
    'answer with Move or Keep it',
  )
  await expect(answer(lead, { action: 'answer', choice: 'Move' })).rejects.toThrow(
    'choose the Factory',
  )
  await expect(
    answer(lead, { action: 'answer', choice: 'Move', move: { factoryId: 'web', planKey: 'old' } }),
  ).rejects.toThrow('changed since the move was shown')
  await expect(
    answer(lead, {
      action: 'answer',
      choice: 'Move',
      move: { factoryId: 'refused', planKey: 'k' },
    }),
  ).rejects.toThrow('can’t move')
  expect(store.getComment(lead.id)?.answer).toBeUndefined()
  effects = []
  expect(
    await answer(lead, {
      action: 'answer',
      choice: 'Move',
      move: { factoryId: 'mobile', planKey: 'plan:mobile' },
    }),
  ).toMatchObject({ answer: { kind: 'answered', choice: 'Move' } })
  expect(effects).toEqual(['move-checked:mobile', 'moved:mobile:plan:mobile:answered'])

  effects = []
  const coordinator = ask('coordinator')
  archiveId = coordinator.id
  await answer(coordinator, {
    action: 'answer',
    choice: 'Move',
    move: { factoryId: 'web', planKey: 'plan:web' },
  })
  expect(effects).toEqual([
    'move-checked:web',
    'moved:web:plan:web:answered',
    expect.stringMatching(
      /^chat:chat-1:The user approved your request: \S+ moved to the other Factory as WEB-4\.$/,
    ),
  ])
})

test('Keep it on a move request tells whoever asked', async () => {
  const ask = (askedBy: 'task-lead' | 'coordinator') =>
    post(
      { kind: 'move' },
      {
        choices: ['Move', 'Keep it'],
        move: {
          factoryId: 'web',
          reason: 'It changes the site',
          askedBy,
          ...(askedBy === 'coordinator' && { chatId: 'chat-1' }),
        },
      },
    )
  const lead = ask('task-lead')
  expect(
    await answer(lead, { action: 'answer', choice: 'Keep it', text: 'It belongs here' }),
  ).toMatchObject({ answer: { kind: 'answered', choice: 'Keep it', text: 'It belongs here' } })
  expect(effects).toEqual(['delivered'])
  effects = []
  await answer(ask('coordinator'), { action: 'answer', choice: 'Keep it' })
  expect(effects).toEqual([
    expect.stringMatching(/^chat:chat-1:The user chose Keep it on your request to move /),
  ])
  await expect(
    createRequestAnswers(port)(
      ask('task-lead').id,
      { action: 'answer', choice: 'Move' },
      false,
      'Coordinator',
    ),
  ).rejects.toThrow('only the user answers a move request')
})

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

test('a sign-off approves only after checking obligations and advances, without sending drafts', async () => {
  const comment = post({ kind: 'gate' }, { kind: 'review', gate: { approveLabel: 'Approve' } })
  await expect(answer(comment)).rejects.toThrow('Approve or Request changes')
  await answer(comment, { action: 'approve' })
  expect(effects).toEqual(['obligations', 'approval', 'moved'])
  expect(store.getComment(comment.id)?.answer?.kind).toBe('approved')
  expect(store.listOpenRequests()).toEqual([])
})

test('a sign-off keeps its request open when obligations fail', async () => {
  port.requireObligations = async () => {
    throw new Error('unresolved failure')
  }
  const comment = post({ kind: 'gate' }, { kind: 'signoff', gate: { approveLabel: 'Approve' } })
  await expect(answer(comment, { action: 'approve' })).rejects.toThrow('unresolved failure')
  expect(store.getComment(comment.id)?.answer).toBeUndefined()
  expect(effects).toEqual([])
})

test.each(['withdrawn', 'superseded', 'approved'] as const)(
  'a sign-off that becomes %s while waiting cannot approve or advance again',
  async (kind) => {
    const comment = post({ kind: 'gate' }, { kind: 'signoff', gate: { approveLabel: 'Merge' } })
    port.untilFree = unexpected
    port.holding = unexpected
    port.holdingSignoff = async (_task, work) => {
      store.answerComment(
        comment.id,
        kind === 'withdrawn'
          ? { kind, at: at(), cancelled: true }
          : kind === 'superseded'
            ? { kind, at: at(), by: 'replacement' }
            : { kind, at: at() },
      )
      return work()
    }
    await expect(answer(comment, { action: 'approve' })).rejects.toThrow(
      kind === 'withdrawn'
        ? 'withdrawn'
        : kind === 'superseded'
          ? 'replaced'
          : 'already been answered',
    )
    expect(effects).toEqual([])
    expect(store.getComment(comment.id)?.answer?.kind).toBe(kind)
  },
)

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

test.each([
  ['Accept this failure', 'accepted'],
  ['Retry', 'retry'],
  ['Fix in this Task', 'fix'],
])(
  'a failure decision routes %s to its specialist, while a text follow-up leaves it open',
  async (choice, resolution) => {
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
    const narrowed = post({ kind: 'failure' }, { choices: ['Fixed', 'No longer applicable'] })
    await expect(answer(narrowed, { action: 'answer', choice }, false)).rejects.toThrow(
      'isn’t one of the question’s choices',
    )
    await answer(comment, { action: 'answer', choice }, false)
    expect(effects).toEqual(['follow-up:false', `resolved:${resolution}:false`])
  },
)

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

    const second = store.draftLineComment({
      taskId,
      repo: 'widgets',
      path: 'app.ts',
      side: 'new',
      start: 2,
      end: 2,
      commit: 'head',
      quoted: [],
      body: 'And this one',
    })
    const asked = post(
      { kind: 'archive' },
      { choices: ['Archive', 'Keep it'], archive: { reason: 'Duplicate' } },
    )
    archiveId = asked.id
    await answer(asked, { action: 'answer', choice: 'Archive', text: 'Agreed' }, sendDrafts)
    expect(store.getComment(asked.id)?.lineComments?.map((d) => d.id) ?? []).toEqual(
      sendDrafts ? [second.id] : [],
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

test('a question that allows several answers records the ticked choices in their order', async () => {
  const comment = post(
    { kind: 'question' },
    { choices: ['Board', 'List', 'Map'], multiple: true, body: 'Which views?' },
  )
  expect(store.getComment(comment.id)?.multiple).toBe(true)
  await expect(answer(comment, { action: 'answer', choices: ['Board', 'Grid'] })).rejects.toThrow(
    '“Grid” isn’t one of the question’s choices',
  )
  await expect(answer(comment, { action: 'answer' })).rejects.toThrow(
    'pick a choice or write an answer',
  )
  const answered = await answer(comment, {
    action: 'answer',
    choices: ['Map', 'Board'],
    text: 'Map first',
  })
  expect(answered.answer).toMatchObject({ kind: 'answered', choices: ['Board', 'Map'] })
  expect(answerMessage(answered)).toContain('Board; Map\n\nMap first')
  const none = await answer(
    post({ kind: 'question' }, { choices: ['Board', 'List'], multiple: true, body: 'Which?' }),
    { action: 'answer', choices: [] },
  )
  expect(none.answer).toMatchObject({ kind: 'answered', choices: [] })
  expect(answerMessage(none)).toContain('None of these')
  const single = post({ kind: 'question' }, { choices: ['Yes', 'No'] })
  expect(single.multiple).toBeUndefined()
  await expect(answer(single, { action: 'answer', choices: ['Yes', 'No'] })).rejects.toThrow(
    'this question takes one choice',
  )
})

test('a round question that allows several answers is changed only when the ticked set differs', async () => {
  const several = {
    question: 'Which views?',
    choices: ['Board', 'List', 'Map'],
    recommended: 'Board; Map',
    multiple: true as const,
    recommendedChoices: ['Board', 'Map'],
  }
  const round = (number: number) =>
    post(
      { kind: 'round' },
      {
        kind: 'round',
        round: { number, questions: [several, { question: 'Name?', recommended: 'A' }] },
      },
    )
  const first = round(1)
  await expect(
    answer(first, {
      action: 'answer-round',
      answers: [{ answer: '', choices: ['Grid'] }, { answer: 'A' }],
    }),
  ).rejects.toThrow('question 1’s answers must be among its choices')
  const answered = await answer(first, {
    action: 'answer-round',
    answers: [{ answer: '', choices: ['Map', 'Board'], note: 'Both' }, { answer: 'A' }],
  })
  expect(answered.answer).toMatchObject({
    answers: [
      { answer: 'Board; Map', choices: ['Board', 'Map'], note: 'Both', changed: false },
      { answer: 'A', changed: false },
    ],
  })
  const other = await answer(round(2), {
    action: 'answer-round',
    answers: [{ answer: 'Calendar', choices: ['Board'] }, { answer: 'A' }],
  })
  expect(other.answer).toMatchObject({
    answers: [{ answer: 'Board; Calendar', choices: ['Board'], changed: true }, {}],
  })
  const message = roundAnswerMessage(
    other,
    other.answer?.kind === 'answered' ? (other.answer.answers ?? []) : [],
    'few',
  )
  expect(message).toContain('Board; Calendar (changed from your recommendation “Board; Map”)')
  const accepted = await answer(round(3), { action: 'accept-recommended' })
  expect(accepted.answer).toMatchObject({
    answers: [{ answer: 'Board; Map', choices: ['Board', 'Map'], changed: false }, {}],
  })
  const none = await answer(round(4), {
    action: 'answer-round',
    answers: [{ answer: '', choices: [] }, { answer: 'A' }],
  })
  expect(none.answer).toMatchObject({
    answers: [{ answer: 'None of these', choices: [], changed: true }, {}],
  })
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

test('a Linear team answer rejects missing metadata before any lifecycle effect', async () => {
  const comment = post({ kind: 'linear-team' }, { choices: ['Allow'] })
  await expect(answer(comment, { action: 'answer', choice: 'Allow' })).rejects.toThrow(
    'this question isn’t about a Linear team',
  )
  expect(store.getComment(comment.id)?.answer).toBeUndefined()
  expect(effects).toEqual([])
})

const stage = (id: 'clarify' | 'work' | 'validate' | 'merge') =>
  store.changeStage(taskId, id, {
    stageFile: { layer: 'ted', path: `${id}.md` },
    layers: [],
    order: [],
  })
const linearQuestion = () =>
  post(
    { kind: 'linear-team' },
    { choices: ['Allow', 'Not now', 'Continue'], linearTeam: { key: 'ABC', name: 'Team ABC' } },
  )

test.each(['Allow', 'Not now'] as const)(
  'a Linear team %s updates real consent and closes its requests once',
  async (choice) => {
    const comment = linearQuestion()
    const changes: string[] = []
    store.subscribe((event) => {
      if (event.type === 'comment-updated' && event.comment.id === comment.id)
        changes.push(event.comment.id)
    })
    await answer(comment, { action: 'answer', choice })
    const settings = store.settings()
    const factoryId = port.find(taskId).factoryId
    expect(
      choice === 'Allow'
        ? settings.linearSyncTeams[factoryId]
        : settings.linearSyncDeclined[factoryId],
    ).toEqual(['ABC'])
    expect(store.getComment(comment.id)?.answer).toMatchObject({ kind: 'answered', choice })
    expect(changes).toHaveLength(1)
    expect(store.listOpenRequests()).toEqual([])
  },
)

test.each([
  { choice: 'Continue' },
  { text: 'Please allow this' },
  { choice: 'Allow', text: 'Extra words' },
])('Linear team rules reject %j without consuming the request', async (input) => {
  const comment = linearQuestion()
  await expect(answer(comment, { action: 'answer', ...input })).rejects.toThrow(
    'answer with Allow or Not now',
  )
  expect(store.getComment(comment.id)?.answer).toBeUndefined()
  expect(effects).toEqual([])
})

const sizeQuestion = () =>
  post(
    { kind: 'size-check' },
    { choices: Object.values(sizeChoices), sizeCheck: { settle: ['The scope'] } },
  )

test.each([
  ['Split it', 'delivered'],
  ['Grill anyway', 'delivered'],
  ['Plan it outside Ted', 'plan-outside'],
] as const)('size-check %s carries out the real decision', async (choice, effect) => {
  stage('clarify')
  const comment = sizeQuestion()
  await answer(comment, { action: 'answer', choice })
  expect(effects).toEqual([effect])
  expect(store.getComment(comment.id)?.answer).toMatchObject({ kind: 'answered', choice })
  if (choice === 'Grill anyway') expect(store.getTask(taskId)?.clarifyDepth).toBe('grilling')
})

test('Plan in chat records the new plan and delivers the result', async () => {
  stage('clarify')
  port.planning = () => ({
    fromTask: async (input) => {
      effects.push(`plan:${input.sizeCheckId}`)
      return { id: 'new-plan', title: 'A plan' }
    },
  })
  const comment = sizeQuestion()
  await answer(comment, { action: 'answer', choice: 'Plan in chat', text: 'Discuss this' })
  expect(effects).toEqual([`plan:${comment.id}`, 'delivered'])
  expect(store.getComment(comment.id)?.answer).toMatchObject({
    kind: 'answered',
    planId: 'new-plan',
    choice: 'Plan in chat',
  })
})

test('size-check answers reject missing metadata and unavailable planning before closing', async () => {
  const missing = post({ kind: 'size-check' }, { choices: ['Split it'] })
  await expect(answer(missing, { action: 'answer', choice: 'Split it' })).rejects.toThrow(
    'no size check',
  )
  const comment = sizeQuestion()
  await expect(answer(comment, { action: 'answer', choice: 'Plan in chat' })).rejects.toThrow(
    'aren’t ready',
  )
  expect(store.getComment(comment.id)?.answer).toBeUndefined()
  expect(effects).toEqual([])
})

const ciQuestion = () =>
  post({ kind: 'ci-stuck' }, { choices: ['Merge anyway', 'Send to Task Lead', 'Keep waiting'] })

test.each([
  ['Keep waiting', []],
  ['Send to Task Lead', ['merge-back']],
  ['Merge anyway', ['obligations']],
] as const)('CI choice %s runs its real decision', async (choice, expected) => {
  stage('merge')
  const comment = ciQuestion()
  await answer(comment, { action: 'answer', choice })
  expect(effects).toEqual(expected)
  expect(store.getComment(comment.id)?.answer).toMatchObject({ kind: 'answered', choice })
})

test('Merge and don’t wait again is the human’s, merges like Merge anyway and saves the setting', async () => {
  store.startTask({
    taskId,
    stage: 'merge',
    branch: 'task',
    worktree: directory,
    entry: { stageFile: { layer: 'ted', path: 'merge.md' }, layers: [], order: [] },
    repo: { name: 'widgets', repo: 'acme/widgets', copied: [], skipped: [] },
  })
  const noCi = 'Merge, and don’t wait for CI on widgets again'
  const saved: string[] = []
  port.setPullRequestCi = async (factoryId, repo, mode) => {
    saved.push(`${factoryId}:${repo}:${mode}`)
    return {
      pullRequest: { number: 9, url: 'https://github.com/acme/widgets/pull/9' },
      merged: true,
    }
  }
  const question = () =>
    post(
      { kind: 'ci-stuck' },
      { choices: ['Send to Task Lead', 'Keep waiting', 'Merge anyway', noCi] },
    )
  const byAutopilot = question()
  await expect(
    createRequestAnswers(port)(
      byAutopilot.id,
      { action: 'answer', choice: noCi },
      true,
      'Autopilot',
    ),
  ).rejects.toThrow('only the human')
  expect(store.getComment(byAutopilot.id)?.answer).toBeUndefined()

  await answer(byAutopilot, { action: 'answer', choice: noCi })
  expect(effects).toEqual(['obligations'])
  expect(store.getComment(byAutopilot.id)?.answer).toMatchObject({ kind: 'answered', choice: noCi })
  await vi.waitUntil(() => saved.length > 0)
  expect(saved).toEqual([`${store.getTask(taskId)?.factoryId}:acme/widgets:none`])
  await vi.waitUntil(() => store.listComments(taskId).some((c) => c.body.includes('#9')))
  const note = store.listComments(taskId).find((c) => c.body.includes('#9'))
  expect(note?.body).toContain('“Pull request CI: None” for widgets')
})

test('CI Merge anyway leaves its request open when obligations fail', async () => {
  port.requireObligations = async () => {
    throw new Error('unresolved failures')
  }
  const comment = ciQuestion()
  await expect(answer(comment, { action: 'answer', choice: 'Merge anyway' })).rejects.toThrow(
    'unresolved failures',
  )
  expect(store.getComment(comment.id)?.answer).toBeUndefined()
})

test('CI free text is answered and delivered without sending the Task back', async () => {
  const comment = ciQuestion()
  await answer(comment, { action: 'answer', text: 'Please inspect this' })
  expect(effects).toEqual(['delivered'])
  expect(store.getComment(comment.id)?.answer).toMatchObject({
    kind: 'answered',
    text: 'Please inspect this',
  })
})

const proposalQuestion = () =>
  post(
    { kind: 'proposal' },
    {
      kind: 'proposal',
      proposal: {
        firstPiece: { id: taskId, displayId: port.find(taskId).displayId },
        rows: [
          { title: 'Narrowed piece', scope: 'First scope', priority: 'high', blockedBy: [] },
          { title: 'A dependent piece', scope: 'Second scope', priority: 'medium', blockedBy: [1] },
          { title: 'An independent piece', scope: 'Third scope', priority: 'low', blockedBy: [] },
        ],
      },
    },
  )

test('proposal approval creates every row as a child of this Task, which waits, and starts only unblocked pieces; a blocked piece gets no start request', async () => {
  const before = store.getTask(taskId)
  const comment = proposalQuestion()
  await answer(comment, { action: 'approve', proposal: { startUnblocked: true } })
  const pieces = store.listTasks().filter((t) => t.id !== taskId)
  expect(pieces.map((t) => [t.title, t.parentId])).toEqual([
    ['Narrowed piece', taskId],
    ['A dependent piece', taskId],
    ['An independent piece', taskId],
  ])
  expect(store.getTask(taskId)).toMatchObject({
    title: before?.title,
    description: before?.description,
  })
  const first = pieces.find((t) => t.title === 'Narrowed piece')
  const dependent = pieces.find((t) => t.title === 'A dependent piece')
  const independent = pieces.find((t) => t.title === 'An independent piece')
  expect(dependent && store.blockers(dependent.id).map((b) => b.blockerId)).toEqual([first?.id])
  expect(dependent && store.getTask(dependent.id)?.startRequested).toBe(false)
  expect(effects).toEqual([
    `stop-lead:${taskId}:1 Tasks`,
    `wait-for-children:${taskId}`,
    'delivered',
    `start:${first?.id}`,
    `start:${independent?.id}`,
  ])
  expect(store.getComment(comment.id)?.answer).toMatchObject({
    kind: 'approved',
    created: { skipped: [], startUnblocked: true },
  })
})

test('proposal skip of a row that isn’t there is rejected before creating Tasks', async () => {
  const comment = proposalQuestion()
  await expect(answer(comment, { action: 'approve', proposal: { skip: [8] } })).rejects.toThrow(
    'no row 8',
  )
  expect(store.listTasks()).toHaveLength(1)
  expect(store.getComment(comment.id)?.answer).toBeUndefined()
  expect(effects).toEqual([])
})

test('a proposal without rows cannot be approved', async () => {
  const comment = post({ kind: 'proposal' }, { kind: 'proposal' })
  await expect(answer(comment, { action: 'approve' })).rejects.toThrow('no rows')
})

test('proposal Request changes records and delivers words without creating pieces', async () => {
  const comment = proposalQuestion()
  await answer(comment, { action: 'request-changes', text: 'Change the split' })
  expect(store.listTasks()).toHaveLength(1)
  expect(store.getComment(comment.id)?.answer).toMatchObject({
    kind: 'changes-requested',
    text: 'Change the split',
  })
  expect(effects).toEqual(['delivered'])
})

const sendBackQuestion = (loop = true) => {
  const comment = post(
    { kind: 'send-back' },
    { choices: ['Try again', 'Back to Design', 'Move to Review anyway'] },
  )
  store.askAboutSendBack({
    commentId: comment.id,
    taskId,
    from: 'validate',
    to: 'work',
    findings: 'Fix the bug',
    loop,
  })
  return comment
}
const loopWorkflow = () =>
  resolveWorkflow([
    {
      kind: 'ted',
      files: {},
      agentSettings: {},
      agentFiles: {},
      settings: {
        stages: {},
        order: ['intake', 'clarify', 'design', 'work', 'validate', 'review'],
      },
      stageFiles: {
        design: 'Design instructions',
        work: 'Work instructions',
        review: 'Review instructions',
      },
      problems: [],
      valid: true,
    },
  ])

test.each([
  ['Try again', 'work'],
  ['Back to Design', 'design'],
  ['Move to Review anyway', 'review'],
] as const)('send-back %s records the real decision and moves to %s', async (choice, next) => {
  stage('validate')
  port.gateWorkflow = async () => ({ workflow: loopWorkflow(), layers: [] })
  port.move = async (task, _resolution, to) => {
    effects.push(`move:${to}`)
    return store.changeStage(task.id, to, {
      stageFile: { layer: 'ted', path: `${to}.md` },
      layers: [],
      order: [],
    })
  }
  const comment = sendBackQuestion()
  await answer(comment, { action: 'answer', choice })
  expect(store.getTask(taskId)?.stage).toBe(next)
  expect(store.getComment(comment.id)?.answer).toMatchObject({ kind: 'answered', choice })
  expect(effects).toContain(`move:${next}`)
  if (choice === 'Move to Review anyway') expect(effects).toEqual(['obligations', 'move:review'])
  else
    expect(store.listSendBacks(taskId).at(-1)).toMatchObject({
      to: next,
      counted: choice === 'Try again',
    })
})

test('the limit question’s Keep going returns the Task to Work counted as round 1, and Stop the Task records that return and stops the Task in Work', async () => {
  stage('validate')
  port.gateWorkflow = async () => ({ workflow: loopWorkflow(), layers: [] })
  port.move = async (task, _resolution, to) => {
    effects.push(`move:${to}`)
    return store.changeStage(task.id, to, {
      stageFile: { layer: 'ted', path: `${to}.md` },
      layers: [],
      order: [],
    })
  }
  port.stop = async (id) => {
    effects.push(`stop:${store.getComment(stopped.id)?.answer?.kind}`)
    store.stopTask(id, { runs: 0, why: 'human' })
    return port.find(id)
  }
  const limitQuestion = () => {
    const comment = post({ kind: 'send-back' }, { choices: ['Keep going', 'Stop the Task'] })
    store.askAboutSendBack({
      commentId: comment.id,
      taskId,
      from: 'validate',
      to: 'work',
      findings: 'Typecheck failed',
      loop: true,
      checkRunId: 'check-run',
    })
    return comment
  }
  const stopped = limitQuestion()
  await answer(stopped, { action: 'answer', choice: 'Stop the Task' })
  expect(effects).toEqual(['stop:answered', 'move:work'])
  expect(store.getTask(taskId)).toMatchObject({ stage: 'work', stopped: true })
  expect(store.listSendBacks(taskId)).toMatchObject([
    { to: 'work', counted: true, round: 1, checkRunId: 'check-run', cause: 'check' },
  ])
  expect(store.getTask(taskId)?.pendingLeadMessages.map((m) => m.text)).toEqual([
    expect.stringContaining('Typecheck failed'),
  ])

  effects = []
  store.resumeTask(taskId, { waitForBlockers: false })
  stage('validate')
  const again = limitQuestion()
  await answer(again, { action: 'answer', choice: 'Keep going' })
  expect(effects).toEqual(['move:work'])
  expect(store.listSendBacks(taskId).at(-1)).toMatchObject({
    to: 'work',
    counted: true,
    round: 1,
    checkRunId: 'check-run',
    cause: 'check',
  })
})

test('Try again on an open failing-Checks question from Work tells the Task Lead to report again', async () => {
  stage('work')
  const comment = post({ kind: 'send-back' }, { choices: ['Try again', 'Diagnose in Validate'] })
  store.askAboutSendBack({
    commentId: comment.id,
    taskId,
    from: 'work',
    to: 'work',
    findings: 'Tests failed',
    loop: false,
  })
  const told: string[] = []
  port.deliverAnswer = async (_task, _comment, text) => {
    told.push(text)
  }
  await answer(comment, { action: 'answer', choice: 'Try again' })
  expect(store.getComment(comment.id)?.answer).toMatchObject({ choice: 'Try again' })
  expect(told[0]).toContain('report `ted outcome advance` again')
  expect(store.getTask(taskId)?.stage).toBe('work')
})

test('send-back missing metadata is rejected, and non-loop choices are delivered normally', async () => {
  const missing = post({ kind: 'send-back' }, { choices: ['Try again'] })
  await expect(answer(missing, { action: 'answer', choice: 'Try again' })).rejects.toThrow(
    'no recorded decision',
  )
  await expect(answer(missing, { action: 'answer', text: 'Please review' })).rejects.toThrow(
    'no recorded decision',
  )
  const comment = sendBackQuestion(false)
  await answer(comment, { action: 'answer', choice: 'Try again' })
  expect(effects).toEqual(['delivered'])
})

test('Diagnose in Validate on the failing-Checks question answers only after the guards pass, then moves the Task', async () => {
  stage('work')
  const comment = post({ kind: 'send-back' }, { choices: ['Try again', 'Diagnose in Validate'] })
  store.askAboutSendBack({
    commentId: comment.id,
    taskId,
    from: 'work',
    to: 'work',
    findings: 'Tests failed',
    loop: false,
  })
  port.leaveWorkToDiagnose = async () => {
    throw new Error('the branch conflicts with main')
  }
  await expect(
    answer(comment, { action: 'answer', choice: 'Diagnose in Validate' }),
  ).rejects.toThrow('conflicts with main')
  expect(store.getComment(comment.id)?.answer).toBeUndefined()
  expect(effects).toEqual([])

  const told: string[] = []
  port.leaveWorkToDiagnose = async (task) => {
    effects.push('guards')
    return async (message) => {
      effects.push('move:validate')
      told.push(message)
      return task
    }
  }
  await answer(comment, {
    action: 'answer',
    choice: 'Diagnose in Validate',
    text: 'Broken on main',
  })
  expect(effects).toEqual(['guards', 'move:validate'])
  expect(store.getComment(comment.id)?.answer).toMatchObject({
    kind: 'answered',
    choice: 'Diagnose in Validate',
    text: 'Broken on main',
  })
  expect(told[0]).toContain('with Diagnose in Validate')
  expect(told[0]).toContain('The human added:\n\nBroken on main')
  expect(store.listSendBacks(taskId)).toEqual([])
})

test('Diagnose in Validate on an open limit question from before ADR 0187 keeps the Task in Validate and runs the checks with diagnosis', async () => {
  stage('validate')
  port.gateWorkflow = async () => ({ workflow: loopWorkflow(), layers: [] })
  const run = store.startChecks({
    taskId,
    trigger: 'hand-off',
    stage: 'validate',
    checks: [{ name: 'Types', command: 'tsc', timeout: '1m', state: 'waiting' }],
  })
  const comment = post(
    { kind: 'send-back' },
    { choices: ['Try again', 'Back to Design', 'Diagnose in Validate'] },
  )
  store.askAboutSendBack({
    commentId: comment.id,
    taskId,
    from: 'validate',
    to: 'work',
    findings: 'Types failed',
    loop: true,
    checkRunId: run.id,
  })
  const told: string[] = []
  port.diagnoseInValidate = (_task, message) => {
    effects.push('diagnose')
    told.push(message)
  }
  await answer(comment, {
    action: 'answer',
    choice: 'Diagnose in Validate',
    text: 'Broken on main',
  })
  expect(effects).toEqual(['diagnose'])
  expect(store.getTask(taskId)?.stage).toBe('validate')
  expect(store.getComment(comment.id)?.answer).toMatchObject({
    kind: 'answered',
    choice: 'Diagnose in Validate',
    text: 'Broken on main',
  })
  expect(told[0]).toContain('with Diagnose in Validate')
  expect(told[0]).toContain('The human added:\n\nBroken on main')
  expect(store.listSendBacks(taskId)).toEqual([])
})

const simulatorQuestion = () =>
  store.requestSimulator({
    taskId,
    runId: 'simulator-run',
    title: 'A simulator request',
    body: 'Choose a device',
    simulator: { app: 'iOS', repo: 'widgets', device: 'iPhone', limit: 1, booted: [] },
  })
const simulatorEffects = (room = false) => {
  port.withSimulatorRequest = async (_comment, work) =>
    work({
      assertApp: () => {},
      hasRoom: async () => room,
      boot: async () => {
        effects.push('boot')
      },
      shutDown: async (udid) => {
        effects.push(`shutdown:${udid}`)
        return 'OTHER-1'
      },
    })
}

test('simulator denial is recorded without touching a device', async () => {
  const comment = simulatorQuestion()
  await answer(comment, { action: 'deny', text: 'Keep it running' })
  expect(store.getComment(comment.id)?.answer).toMatchObject({
    kind: 'denied',
    text: 'Keep it running',
  })
  expect(effects).toEqual([])
})

test('simulator approval requires a choice while full, then shuts down and boots in order', async () => {
  simulatorEffects()
  const comment = simulatorQuestion()
  await expect(answer(comment, { action: 'approve' })).rejects.toThrow('pick the simulator')
  expect(store.getComment(comment.id)?.answer).toBeUndefined()
  await answer(comment, { action: 'approve', simulator: 'other-device' })
  expect(effects).toEqual(['shutdown:other-device', 'boot'])
  expect(store.getComment(comment.id)?.answer).toMatchObject({
    kind: 'approved',
    shutDown: 'OTHER-1',
  })
})

test('a freed simulator slot withdraws the request after booting, without shutting down another device', async () => {
  simulatorEffects(true)
  const comment = simulatorQuestion()
  await answer(comment, { action: 'approve' })
  expect(effects).toEqual(['boot'])
  expect(store.getComment(comment.id)?.answer).toMatchObject({ kind: 'withdrawn', slotFreed: true })
})

test('simulator answers reject missing metadata and the disk hold', async () => {
  const missing = post({ kind: 'simulator' }, { kind: 'permission' })
  await expect(answer(missing, { action: 'deny' })).rejects.toThrow('no simulator')
  const comment = simulatorQuestion()
  store.holdNewWork('disk full')
  await expect(answer(comment, { action: 'approve', simulator: 'other-device' })).rejects.toThrow(
    'disk is almost full',
  )
  expect(store.getComment(comment.id)?.answer).toBeUndefined()
  expect(effects).toEqual([])
})

test.each(['proposal', 'simulator', 'size-check', 'ci-stuck', 'linear-team', 'send-back'] as const)(
  '%s rules reject stale requests before their effects',
  async (kind) => {
    const comment =
      kind === 'proposal'
        ? proposalQuestion()
        : kind === 'simulator'
          ? simulatorQuestion()
          : kind === 'size-check'
            ? sizeQuestion()
            : kind === 'ci-stuck'
              ? ciQuestion()
              : kind === 'linear-team'
                ? linearQuestion()
                : sendBackQuestion()
    store.answerComment(comment.id, { kind: 'withdrawn', at: at(), cancelled: true })
    const request: AnswerRequest =
      kind === 'proposal' || kind === 'simulator'
        ? { action: 'approve', simulator: 'other-device' }
        : {
            action: 'answer',
            choice:
              kind === 'size-check'
                ? 'Split it'
                : kind === 'ci-stuck'
                  ? 'Keep waiting'
                  : kind === 'linear-team'
                    ? 'Allow'
                    : 'Try again',
          }
    await expect(answer(comment, request)).rejects.toThrow('withdrawn')
    expect(effects).toEqual([])
  },
)

test('a simulator App that stopped cannot consume its pending approval', async () => {
  port.withSimulatorRequest = async (_comment, work) =>
    work({
      assertApp: () => {
        throw new Error('the App that asked has stopped')
      },
      hasRoom: unexpected,
      boot: unexpected,
      shutDown: unexpected,
    })
  const comment = simulatorQuestion()
  await expect(answer(comment, { action: 'approve', simulator: 'other-device' })).rejects.toThrow(
    'App that asked has stopped',
  )
  expect(store.getComment(comment.id)?.answer).toBeUndefined()
  expect(effects).toEqual([])
})

test('Sign-off obligations receive the next Stage so a repair may return through validation', async () => {
  const comment = post({ kind: 'gate' }, { kind: 'signoff', gate: { approveLabel: 'Approve' } })
  const resolution = await port.gateWorkflow(port.find(taskId))
  port.gateWorkflow = async () => ({
    ...resolution,
    workflow: { ...loopWorkflow(), next: () => 'work' },
  })
  port.requireObligations = async (_task, target) => {
    effects.push(`obligations:${target}`)
  }
  await answer(comment, { action: 'approve' })
  expect(effects).toEqual(['obligations:work', 'approval', 'moved'])
})

test('approving a sign-off while the Checks are out of date records it and moves after they run', async () => {
  const comment = post({ kind: 'gate' }, { kind: 'signoff', gate: { approveLabel: 'Approve' } })
  let stale = true
  port.requireObligations = async () => {
    effects.push('obligations')
    if (stale) throw new StaleCoverageError()
  }
  let afterChecks: (() => Promise<unknown>) | undefined
  port.checksThen = async (_id, action) => {
    effects.push('checks')
    afterChecks = action
  }
  const answered = await answer(comment, { action: 'approve' })
  expect(answered.answer?.kind).toBe('approved')
  expect(effects).toEqual(['obligations', 'checks', 'approval'])
  stale = false
  await afterChecks?.()
  expect(effects).toEqual(['obligations', 'checks', 'approval', 'obligations', 'moved'])
})

test('a preparation Sign-off validates its Workflow before recording approval', async () => {
  store.queueTask(taskId, 'design', { prepare: true })
  expect(store.getTask(taskId)?.preparation).toBe('preparing')
  const comment = post({ kind: 'gate' }, { kind: 'review', gate: { approveLabel: 'Approve' } })
  port.gateWorkflow = async () => ({
    workflow: {
      ...loopWorkflow(),
      next: () => 'review',
      stages: ['intake', 'design', 'review'],
      order: ['intake', 'design', 'review'],
    },
    layers: [],
  })
  await expect(answer(comment, { action: 'approve' })).rejects.toThrow(
    'Prepare through Design needs Work enabled after Clarify and Design',
  )
  expect(store.getComment(comment.id)?.answer).toBeUndefined()
  expect(effects).toEqual([])

  port.gateWorkflow = async () => ({ workflow: loopWorkflow(), layers: [] })
  await answer(comment, { action: 'approve' })
  expect(store.getComment(comment.id)?.answer?.kind).toBe('approved')
  expect(effects).toEqual(['obligations', 'approval', 'moved'])
})

test('an explanation request is saved for delivery with guidance to answer and ask again', async () => {
  const question = post({ kind: 'question' }, { choices: ['Disable tools', 'Keep tools'] })
  const deliver = vi.fn(port.deliverAnswer)
  port.deliverAnswer = deliver
  const replied = await answer(question, {
    action: 'answer',
    text: 'Tell me more about why it is helpful for tools to be disabled',
  })
  expect(replied.answer).toMatchObject({ kind: 'answered' })
  expect(replied.answer).not.toHaveProperty('choice')
  expect(replied.answerDelivery).toEqual({ queuedAt: replied.answer?.at })
  expect(store.heldAnswers(taskId).map((c) => c.id)).toEqual([question.id])
  const message = deliver.mock.calls[0]?.[2]
  expect(message).toContain('answer it in the Task Thread with `ted comment`')
  expect(message).toContain('ask it again')
  expect(message).toContain('A request for explanation gives no consent')
  await store.persisted()
  await store.close()
  store = await openStore({ directory })
  expect(store.getComment(question.id)?.answerDelivery).toEqual(replied.answerDelivery)
  expect(store.heldAnswers(taskId).map((c) => c.id)).toEqual([question.id])
  const updates: string[] = []
  const stop = store.subscribe((event) => {
    if (event.type === 'comment-updated') updates.push(event.comment.id)
  })
  store.answersDelivered([question.id], 'replacement-lead')
  stop()
  expect(updates).toContain(question.id)
  expect(store.getComment(question.id)?.answerDelivery?.sent).toMatchObject({
    runId: 'replacement-lead',
  })
  expect(store.heldAnswers(taskId)).toEqual([])
  await store.persisted()
  await store.close()
  store = await openStore({ directory })
  expect(store.getComment(question.id)?.answerDelivery?.sent?.runId).toBe('replacement-lead')
})

test('explicit choices retain their meaning, and older answers acquire no invented receipt', async () => {
  const explicit = post({ kind: 'question' }, { choices: ['Continue'] })
  const replied = await answer(explicit)
  expect(replied.answer).toMatchObject({ kind: 'answered', choice: 'Continue' })
  expect(replied.answerDelivery?.sent).toBeUndefined()
  const legacy = post({ kind: 'question' })
  finish(legacy)
  store.holdAnswer(legacy.id)
  store.answersDelivered([legacy.id], 'lead')
  expect(store.getComment(legacy.id)?.answerDelivery).toBeUndefined()
})

test('queued Autopilot answers preserve their attribution after merging continuation handling', async () => {
  const question = post({ kind: 'question' }, { choices: ['Continue'] })
  const deliver = vi.fn(port.deliverAnswer)
  port.deliverAnswer = deliver
  const replied = await createRequestAnswers(port, { guard: async () => {} })(
    question.id,
    { action: 'answer', choice: 'Continue' },
    true,
  )
  expect(replied.autopilotAnswered).toBe(true)
  expect(replied.answerDelivery?.queuedAt).toBe(replied.answer?.at)
  expect(deliver.mock.calls[0]?.[2]).toContain('Autopilot replied')
})
