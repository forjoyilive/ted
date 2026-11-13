import { expect, test } from 'vitest'
import * as P from '../src/index.ts'
import { rejects, roundTrip, variant, variants } from './parser-cases.ts'

const file = { hash: 'a'.repeat(64), name: 'image.png', mediaType: 'image/png' }
const lead = { agent: 'codex', model: 'gpt-5.5', effort: 'high', effortMode: 'stage' } as const
const question = { question: 'Which?', choices: ['This', 'That'], recommended: 'This' }
const round = { title: 'Options', summary: 'Choose one.', questions: [question] }
const proposal = {
  title: 'Pieces',
  summary: 'Two pieces.',
  tasks: [
    {
      title: 'First',
      scope: 'First scope',
      description: 'Details',
      priority: 'high',
    },
    {
      title: 'Second',
      scope: 'Second scope',
      description: 'Details',
      priority: 'low',
      blockedBy: [1],
    },
  ],
} satisfies P.ProposalInput
const setup = {
  workflow: [{ stage: 'work', setting: 'enabled' }],
  checks: [
    {
      name: 'Typecheck',
      command: 'pnpm typecheck',
      repo: 'ted',
      passed: true,
      durationMs: 100,
      reason: 'Passed',
    },
  ],
  apps: [
    {
      name: 'Dev',
      repo: 'ted',
      kind: 'command',
      run: 'pnpm app',
      ready: 'start',
      passed: true,
      reason: 'Ready',
    },
  ],
  files: [{ path: '.ted/workflow.yaml', about: 'Workflow' }],
  defaults: 'Keep other defaults.',
} satisfies P.SetupProposal
const design = {
  title: 'Design',
  summary: 'Approach',
  screenshots: [{ ...file, caption: 'Screenshot' }],
  video: { ...file, name: 'demo.mp4', mediaType: 'video/mp4', caption: 'Video' },
  prototype: { ...file, name: 'demo.html', mediaType: 'text/html', caption: 'Prototype' },
  figma: { url: 'https://www.figma.com/design/example', label: 'Frame' },
  worthYourEye: ['A point'],
  setup,
} satisfies Required<P.DesignReviewInput>

roundTrip(P.parseCreateTaskRequest, {
  draftRevision: 'rev',
  title: 'Title',
  description: 'Details',
  factory: 'TED',
  priority: 'high',
  clarifyDepth: 'few',
  lead,
  blockedBy: ['TED-1'],
  attachments: [file],
  source: 'https://example.com/issue',
  sentryId: 'APP-1',
  followUp: 'TED-1',
  start: true,
  startInBackground: true,
})
roundTrip(P.parseSaveTaskDraftRequest, {
  revision: 'rev',
  title: 'Title',
  description: 'Details',
  priority: 'high',
  blockedBy: ['TED-1'],
  attachments: [file],
  start: true,
  moreOpen: true,
  clarifyDepth: 'few',
  lead,
  source: 'https://example.com/issue',
  dismissed: ['old'],
  filled: { title: 'Source title', priority: 'high' },
})
roundTrip(P.parseSaveMessageDraftRequest, {
  text: 'Not sent yet',
  attachments: [file],
  fields: '{"skip":[2]}',
})
roundTrip(P.parseTaskLead, lead)
roundTrip(P.parseResumeTaskRequest, { comment: 'Continue', attachments: [file] })
roundTrip(P.parseAnswerTedStopsRequest, { restart: ['task-1'], leave: ['task-2'] })
roundTrip(P.parseFollowUpRequest, { comment: 'Next', attachments: [file] })
roundTrip(P.parseMoveTaskRequest, { after: 'TED-1', before: 'TED-3' })
roundTrip(P.parseSetPriorityRequest, { priority: 'high' })
roundTrip(P.parseEditTaskRequest, { title: 'Title', description: 'Details' })
roundTrip(P.parseArchiveTaskRequest, {
  closePullRequests: true,
  blocked: 'keep',
  hierarchyRevision: 'a'.repeat(64),
})
roundTrip(P.parseDeleteTaskRequest, {
  blocked: 'unblock',
  children: 'delete',
  hierarchyRevision: 'a'.repeat(64),
})
roundTrip(P.parseBlockTaskRequest, { by: 'TED-1' })
roundTrip(P.parseSetTaskReposRequest, { set: ['ted'], confirm: true })
roundTrip(P.parseSetTaskReposRequest, { add: ['ted'] })
roundTrip(P.parseSetTaskReposRequest, { remove: ['ted'], confirm: true })
roundTrip(P.parseSetClarifyDepthRequest, { depth: 'few', why: 'Two choices' })
roundTrip(P.parseSetTaskGatesRequest, {
  revision: 'rev',
  overrides: { clarify: true, design: false },
})
roundTrip(P.parseRoundInput, round)
roundTrip(P.parseProposalInput, proposal)
roundTrip(P.parseSizeCheckInput, { why: 'Too large', settle: ['Boundary'] })
variants(P.parsePostCommentRequest, [
  { body: 'A note', choices: ['Yes'], supersedes: 'request-1', tutorial: true },
  { body: '', round },
  { body: '', proposal },
  { body: '', sizeCheck: { why: 'Big', settle: ['Boundary'] } },
  { body: 'Files', attachments: [file] },
])
roundTrip(P.parseCancelMergeRequest, { comment: 'Change this', attachments: [file] })
roundTrip(P.parseWriteBriefRequest, { text: 'Brief\n' })
roundTrip(P.parseCloseRoundRequest, { summary: 'Agreed' })
roundTrip(P.parseTalkThroughRequest, { confirmResume: true })
variants(P.parseTalkThroughRequest, [{}, { confirmResume: false }])
rejects(P.parseTalkThroughRequest, { confirmResume: 'yes' }, 'confirmResume must be a boolean')
roundTrip(P.parseSetActivityRequest, { text: 'Working' })
roundTrip(P.parseRunChecksRequest, { name: 'Typecheck' })
roundTrip(P.parseDesignReviewInput, design)
roundTrip(
  P.parseReportOutcomeRequest,
  {
    outcome: 'advance',
    skip: false,
    judged: { review: { passed: true, notes: 2 }, visual: { passed: false, notes: 1 } },
    changes: 'Changes',
    design,
  },
  {
    outcome: 'advance',
    judged: { review: { passed: true, notes: 2 }, visual: { passed: false, notes: 1 } },
    changes: 'Changes',
    design,
  },
)
variant(P.parseReportOutcomeRequest, { outcome: 'advance', skip: true })
roundTrip(P.parseReportOutcomeRequest, {
  outcome: 'back',
  to: 'work',
  findings: 'Fix this',
  judged: { review: { passed: false, notes: 1 } },
  cause: 'base-conflict',
  severity: 'p1',
})
variant(P.parseReportOutcomeRequest, {
  outcome: 'back',
  to: 'work',
  findings: 'Fix this',
  severity: 'unfixed',
})
roundTrip(P.parseReportOutcomeRequest, {
  outcome: 'ask',
  question: 'Proceed?',
  choices: ['Yes', 'No'],
})
for (const answer of [
  {
    action: 'approve',
    text: 'Approved',
    simulator: 'sim',
    proposal: { skip: [2], startUnblocked: true },
  },
  { action: 'request-changes', text: 'Change this' },
  { action: 'deny', text: 'Denied' },
  { action: 'answer', text: 'Yes', choice: 'Yes' },
  { action: 'accept-recommended' },
  { action: 'answer-round', answers: [{ answer: 'This', note: 'Reason' }] },
] satisfies P.AnswerRequest[])
  roundTrip(P.parseAnswerRequest, answer)
roundTrip(P.parseAttachmentRefs, [file])
roundTrip((value): P.DesignFileSpec => P.parseDesignFileSpec(value, 'screenshot'), {
  path: 'image.png',
  caption: 'Caption',
})
roundTrip(P.parseLocalDesignReviewInput, {
  ...design,
  screenshots: [{ path: 'image.png', caption: 'Screenshot' }],
  video: { path: 'demo.mp4', caption: 'Video' },
  prototype: { path: 'demo.html', caption: 'Prototype' },
})

rejects(P.parseCreateTaskRequest, { start: 'yes' }, 'start must be true or false')
rejects(
  P.parseCreateTaskRequest,
  { startInBackground: 'yes' },
  'startInBackground must be true or false',
)
rejects(P.parseTaskLead, { agent: 'other' }, 'agent must be claude, codex or antigravity')
rejects(
  P.parseReportOutcomeRequest,
  { outcome: 'back', to: 'work', findings: 'Fix this', cause: 'tired' },
  'cause must be one of base-conflict',
)
rejects(
  P.parseReportOutcomeRequest,
  { outcome: 'back', to: 'work', findings: 'Fix this', severity: 'p2' },
  'severity must be one of p1, unfixed',
)
rejects(P.parseSaveTaskDraftRequest, {}, 'invalid draft priority')
rejects(P.parseSaveMessageDraftRequest, { attachments: [] }, 'text must be text')
rejects(
  P.parseSaveMessageDraftRequest,
  { text: 'x'.repeat(P.maxMessageDraftText + 1) },
  'text is too long to keep',
)
rejects(P.parseSaveMessageDraftRequest, { text: '', fields: {} }, 'fields must be text')
rejects(() => P.parseMessageBox('settings', 'a'), undefined, 'no such message box')
rejects(() => P.parseMessageBox('comment', ''), undefined, 'invalid message box')
rejects(P.parseResumeTaskRequest, { comment: 2 }, 'comment must be text')
rejects(P.parseAnswerTedStopsRequest, {}, 'name at least one Task')
rejects(P.parseAnswerTedStopsRequest, { restart: [1] }, 'restart must be a list of Task IDs')
rejects(P.parseAnswerTedStopsRequest, { restart: ['a'], leave: ['a'] }, 'can’t be both')
rejects(P.parseFollowUpRequest, { attachments: {} }, 'attachments must be a list')
rejects(P.parseMoveTaskRequest, { after: 2 }, 'after must be a Task ID')
rejects(P.parseSetPriorityRequest, {}, 'priority must be')
rejects(P.parseEditTaskRequest, {}, 'send a title, a description or both')
rejects(P.parseArchiveTaskRequest, { closePullRequests: 1 }, 'closePullRequests must be')
rejects(P.parseDeleteTaskRequest, { blocked: 'other' }, 'blocked must be')
rejects(P.parseBlockTaskRequest, {}, 'by is required')
rejects(P.parseSetTaskReposRequest, { add: [], set: [] }, 'give exactly one')
rejects(P.parseSetClarifyDepthRequest, { depth: 'other' }, 'depth must be')
rejects(P.parseSetTaskGatesRequest, { revision: 'r', overrides: { work: 1 } }, 'Sign-off overrides')
rejects(
  P.parseRoundInput,
  { ...round, questions: Array(13).fill(question) },
  'at most 12 questions',
)
rejects(
  P.parseProposalInput,
  { ...proposal, tasks: [{ ...proposal.tasks[0], blockedBy: [1] }] },
  'itself',
)
rejects(P.parseSizeCheckInput, { why: '' }, 'why')
rejects(
  P.parsePostCommentRequest,
  { body: 'Note', attachments: [file], choices: ['Yes'] },
  'only a note can carry attachments',
)
rejects(P.parseCancelMergeRequest, { comment: '' }, 'comment is required')
rejects(P.parseWriteBriefRequest, { text: '' }, 'text is required')
rejects(P.parseCloseRoundRequest, { summary: '' }, 'summary is required')
rejects(P.parseSetActivityRequest, { text: 'x'.repeat(201) }, 'limited to 200')
rejects(
  P.parseDesignReviewInput,
  { ...design, screenshots: Array(13).fill(file) },
  'at most 12 screenshots',
)
rejects(P.parseReportOutcomeRequest, { outcome: 'advance', skip: true, design }, 'skipped Design')
rejects(P.parseAnswerRequest, { action: 'other' }, 'action must be')
rejects(P.parseAttachmentRefs, Array(51).fill(file), 'at most 50')
rejects(P.parseLocalDesignReviewInput, { screenshots: [1] }, 'needs a path')

test('legacy defaults, normalization and unknown fields remain explicit', () => {
  expect(P.parseRunChecksRequest({ name: 1 })).toEqual({})
  expect(P.parseArchiveTaskRequest(null)).toEqual({ closePullRequests: false, blocked: 'unblock' })
  expect(P.parseMoveTaskRequest({ after: null, unknown: true })).toEqual({})
  expect(P.parseSetActivityRequest({ text: '\u001b[31m Working\n now \u0000' })).toEqual({
    text: 'Working now',
  })
  expect(
    P.parseCreateTaskRequest({ source: ' https://example.com/issue ', sentryId: 'app-1' }),
  ).toEqual({ source: 'https://example.com/issue', sentryId: 'APP-1' })
  expect(P.parseAnswerRequest({ action: 'request-changes' })).toEqual({
    action: 'request-changes',
    text: '',
  })
})

rejects(P.parseTaskLead, { agent: 'codex', effortMode: 'other' }, 'effortMode must be stage')

test('start requests preserve the normal default and validate preparation intent', () => {
  expect(P.parseStartTaskRequest(undefined)).toEqual({})
  expect(P.parseStartTaskRequest({ prepare: true })).toEqual({ prepare: true })
  expect(P.parseStartTaskRequest({ prepare: false })).toEqual({ prepare: false })
  expect(() => P.parseStartTaskRequest({ prepare: 'yes' })).toThrow('prepare')
})

roundTrip(P.parseSetTaskParentRequest, { parentId: 'TED-1', revision: 'a'.repeat(64) })
roundTrip(P.parseUnarchiveTaskRequest, { unlinkParent: true, hierarchyRevision: 'a'.repeat(64) })
rejects(P.parseSetTaskParentRequest, { parentId: 'TED-1' }, 'hierarchyRevision')
rejects(P.parseSetTaskParentRequest, { revision: 'a'.repeat(64) }, 'parentId')
rejects(P.parseSetTaskParentRequest, { parentId: [], revision: 'a'.repeat(64) }, 'parentId')
rejects(P.parseUnarchiveTaskRequest, { unlinkParent: 'yes' }, 'unlinkParent')
rejects(P.parseArchiveTaskRequest, { hierarchyRevision: 'old' }, 'hierarchyRevision')
rejects(P.parseDeleteTaskRequest, { children: 'cancel' }, 'children')
test('unlinking requires an explicit null parent; ordinary restoration needs no options', () => {
  expect(P.parseSetTaskParentRequest({ parentId: null, revision: 'b'.repeat(64) })).toEqual({
    parentId: null,
    revision: 'b'.repeat(64),
  })
  expect(P.parseUnarchiveTaskRequest({})).toEqual({})
})
