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
  agents: [
    {
      id: 'release',
      name: 'Release helper',
      about: 'Cuts a release',
      powers: ['ask', 'read_code', 'run_commands'],
      commands: [
        { name: 'test', command: 'pnpm test' },
        { name: 'lint', command: 'pnpm lint', repo: 'web' },
      ],
      agent: 'claude',
      model: 'opus',
      instructions: '# Release helper\n',
    },
  ],
  files: [{ path: '.ted/workflow.yaml', about: 'Workflow' }],
  defaults: 'Keep other defaults.',
} satisfies Required<P.SetupProposal>
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
  factory: 'Ted',
  priority: 'high',
  clarifyDepth: 'few',
  lead,
  blockedBy: ['TED-1'],
  parent: 'TED-2',
  child: true,
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
  startChosen: true,
  moreOpen: true,
  clarifyDepth: 'few',
  lead,
  source: 'https://example.com/issue',
  parent: 'TED-2',
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
  children: 'detach',
  hierarchyRevision: 'a'.repeat(64),
})
roundTrip(P.parseRequestArchiveRequest, {
  reason: 'Duplicate of TED-255',
  pullRequests: { recommend: 'close', why: 'TED-255 has the same changes' },
})
test('parseRequestArchiveRequest keeps the reason to one line', () => {
  expect(P.parseRequestArchiveRequest({ reason: '  Duplicate\n of TED-255 ' })).toEqual({
    reason: 'Duplicate of TED-255',
  })
})
rejects(P.parseRequestArchiveRequest, {}, 'a reason must be text')
rejects(P.parseRequestArchiveRequest, { reason: ' ' }, 'give a reason')
rejects(P.parseRequestArchiveRequest, { reason: 'x'.repeat(301) }, 'at most 300 characters')
rejects(
  P.parseRequestArchiveRequest,
  { reason: 'Done', pullRequests: { recommend: 'merge', why: 'x' } },
  'pullRequests.recommend must be close or keep',
)
rejects(P.parseAnswerRequest, { action: 'answer', archive: true }, 'archive must be an object')
roundTrip(P.parseReportCleanupStepRequest, {
  step: 'Post note',
  result: 'failed',
  text: 'The tracker refused the login.\nI tried twice.',
})
test('parseReportCleanupStepRequest keeps the step name to one line and trims the report', () => {
  expect(
    P.parseReportCleanupStepRequest({ step: ' Post\n note ', result: 'done', text: ' Posted \n' }),
  ).toEqual({ step: 'Post note', result: 'done', text: 'Posted' })
})
rejects(
  P.parseReportCleanupStepRequest,
  { result: 'done', text: 'x' },
  'give the Cleanup step’s name',
)
rejects(
  P.parseReportCleanupStepRequest,
  { step: 'Post note', result: 'passed', text: 'x' },
  'result must be one of done, skipped, failed',
)
rejects(
  P.parseReportCleanupStepRequest,
  { step: 'Post note', result: 'done', text: ' ' },
  'say what happened in the step',
)
rejects(
  P.parseReportCleanupStepRequest,
  { step: 'Post note', result: 'done', text: 'x'.repeat(4001) },
  'at most 4000 characters',
)
roundTrip(P.parseSetPullRequestTitleRequest, {
  title: 'fix(app): keep the sidebar open',
  body: 'The sidebar stayed shut after a restart.\n\nIt now opens.',
})
test('parseSetPullRequestTitleRequest keeps the title to one line and drops an empty body', () => {
  expect(P.parseSetPullRequestTitleRequest({ title: ' fix: a\n b ', body: ' \n' })).toEqual({
    title: 'fix: a b',
  })
})
rejects(P.parseSetPullRequestTitleRequest, { title: ' ' }, 'give the pull request’s title')
rejects(P.parseSetPullRequestTitleRequest, { title: 'fix: a', body: 1 }, 'body must be text')
rejects(
  P.parseSetPullRequestTitleRequest,
  { title: 'fix: a', body: 'x'.repeat(4001) },
  'at most 4000 characters',
)
test('commitTitleProblem accepts Conventional Commits titles without the Task ID', () => {
  expect(P.commitTitleProblem('fix(app): keep the sidebar open', 'TED-12')).toBeUndefined()
  expect(P.commitTitleProblem('feat!: drop the old flag', 'TED-12')).toBeUndefined()
  expect(P.commitTitleProblem('Keep the sidebar open', 'TED-12')).toMatch(/Conventional Commits/)
  expect(P.commitTitleProblem('fix(App): a', 'TED-12')).toMatch(/Conventional Commits/)
  expect(P.commitTitleProblem('fix: keep it open (TED-12)', 'TED-12')).toMatch(/leave the Task ID/)
  expect(P.commitTitleProblem(`fix: ${'x'.repeat(60)}`, 'TED-12')).toMatch(/keep it to 72/)
  expect(P.commitTitleProblem(`fix: ${'A'.repeat(100_000)}`, 'TED-12')).toMatch(/keep it to 72/)
  expect(P.commitTitleProblem('fix: keep it open TED-12', 'TED-12')).toMatch(/leave the Task ID/)
  expect(P.commitTitle('fix: keep it open', 'TED-12')).toBe('fix: keep it open (TED-12)')
})
roundTrip(P.parseDeleteTaskRequest, {
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
  { body: 'A note', choices: ['Yes'], supersedes: 'request-1' },
  { body: 'Which?', choices: ['Board', 'List'], multiple: true },
  { body: '', round },
  { body: '', proposal },
  { body: '', sizeCheck: { why: 'Big', settle: ['Boundary'] } },
  { body: 'Files', attachments: [file] },
])
test('a Comment request no longer carries the tutorial mark', () => {
  expect(P.parsePostCommentRequest({ body: 'A note', tutorial: true })).toEqual({ body: 'A note' })
})
roundTrip(P.parseCancelMergeRequest, { comment: 'Change this', attachments: [file] })
roundTrip(P.parseMarkDoneRequest, {})
test('parseMarkDoneRequest accepts an empty body', () => {
  expect(P.parseMarkDoneRequest(undefined)).toEqual({})
  expect(P.parseMarkDoneRequest(null)).toEqual({})
})
rejects(P.parseMarkDoneRequest, { force: true }, 'marking a Task done takes no fields')
rejects(P.parseMarkDoneRequest, [], 'marking a Task done takes no fields')
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
variant(P.parseReportOutcomeRequest, { outcome: 'back', to: 'security', findings: 'Fix this' })
roundTrip(P.parseReportOutcomeRequest, {
  outcome: 'ask',
  question: 'Proceed?',
  choices: ['Yes', 'No'],
  multiple: true,
})
for (const answer of [
  {
    action: 'approve',
    text: 'Approved',
    simulator: 'sim',
    proposal: { skip: [2], startUnblocked: true },
    removeAgents: ['release'],
  },
  { action: 'request-changes', text: 'Change this' },
  { action: 'deny', text: 'Denied' },
  {
    action: 'answer',
    text: 'Yes',
    choice: 'Archive',
    choices: ['Board', 'List'],
    archive: {
      closePullRequests: true,
      children: 'detach',
      hierarchyRevision: 'a'.repeat(64),
    },
    move: { factoryId: 'factory-b', planKey: '{"factoryId":"factory-b"}' },
  },
  { action: 'accept-recommended' },
  {
    action: 'answer-round',
    answers: [
      { answer: 'This', note: 'Reason' },
      { answer: 'Other', choices: ['Board'], note: 'Reason' },
    ],
  },
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

const agent = setup.agents[0]
for (const [agents, message] of [
  ['release', 'the setup proposal’s Agents must be a list'],
  [[{ ...agent, id: 'Release' }], 'Release isn’t an Agent id'],
  [[{ ...agent, id: 'coordinator' }], 'coordinator is one of Ted’s own Agents'],
  [[agent, agent], 'the setup proposal suggests release twice'],
  [[{ ...agent, powers: ['ask', 'push'] }], 'release asks for a power Ted doesn’t have'],
  [[{ ...agent, powers: ['ask', 'ask'] }], 'release lists a power twice'],
  [[{ ...agent, name: ' ' }], 'release’s name is required'],
  [[{ ...agent, agent: undefined }], 'release names a model without a Provider'],
  [[{ ...agent, instructions: '' }], 'release’s instructions are empty'],
  [[{ ...agent, powers: ['run_commands'] }], 'Run commands in the copy needs Read the code'],
  [[{ ...agent, powers: ['read_code'] }], 'release lists commands without the run_commands power'],
  [[{ ...agent, commands: [{ name: 'Test', command: 'x' }] }], 'Test isn’t a command name'],
  [[{ ...agent, commands: [{ name: 'test', command: ' ' }] }], 'release’s test must be a command'],
] as const) {
  rejects(P.parseDesignReviewInput, { ...design, setup: { ...setup, agents } }, message)
}
rejects(
  P.parseAnswerRequest,
  { action: 'approve', removeAgents: ['Not An Id'] },
  'removeAgents must be a list of Agent ids',
)

rejects(P.parseCreateTaskRequest, { start: 'yes' }, 'start must be true or false')
rejects(P.parseCreateTaskRequest, { child: 'yes' }, 'child must be true or false')
rejects(
  P.parseCreateTaskRequest,
  { startInBackground: 'yes' },
  'startInBackground must be true or false',
)
rejects(P.parseTaskLead, { agent: 'other' }, 'agent must be claude, codex, antigravity or pi')
for (const to of ['backlog', 'Security', 'security_review'])
  rejects(
    P.parseReportOutcomeRequest,
    { outcome: 'back', to, findings: 'Fix this' },
    'to must be a Stage id, such as intake, clarify, design, work, validate, review, merge, cleanup',
  )
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
rejects(
  P.parseSaveTaskDraftRequest,
  {
    revision: 'rev',
    title: '',
    description: '',
    priority: 'none',
    blockedBy: [],
    attachments: [],
    start: true,
    startChosen: 'yes',
    moreOpen: false,
    dismissed: [],
    filled: {},
  },
  'startChosen must be true or false',
)
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
rejects(P.parseBlockTaskRequest, {}, 'by is required')
rejects(P.parseSetTaskReposRequest, { add: [], set: [] }, 'give exactly one')
rejects(P.parseSetClarifyDepthRequest, { depth: 'other' }, 'depth must be')
rejects(P.parseSetTaskGatesRequest, { revision: 'r', overrides: { work: 1 } }, 'Sign-off overrides')
rejects(
  P.parseRoundInput,
  { ...round, questions: Array(13).fill(question) },
  'at most 12 questions',
)
const several = {
  question: 'Which views?',
  multiple: true,
  choices: ['Board', 'List', 'Map'],
  recommended: ['Board', 'Map'],
}
test('a question that allows several answers keeps its recommended choices', () => {
  expect(P.parseRoundInput({ ...round, questions: [several] }).questions).toEqual([
    {
      question: 'Which views?',
      choices: ['Board', 'List', 'Map'],
      recommended: 'Board; Map',
      multiple: true,
      recommendedChoices: ['Board', 'Map'],
    },
  ])
  expect(
    P.parseRoundInput({ ...round, questions: [{ ...several, recommended: 'List' }] }).questions[0]
      ?.recommendedChoices,
  ).toEqual(['List'])
  const parsed = P.parseRoundInput({ ...round, questions: [several] })
  expect(P.parseRoundInput(parsed)).toEqual(parsed)
  expect(
    P.parseRoundInput({ ...round, questions: [{ ...question, multiple: false }] }).questions,
  ).toEqual([question])
})
rejects(
  P.parseRoundInput,
  { ...round, questions: [{ ...several, recommended: ['Board', 'Grid'] }] },
  'question 1’s recommended answers must each be one of its choices',
)
rejects(
  P.parseRoundInput,
  { ...round, questions: [{ ...several, recommended: [] }] },
  'question 1 needs at least one recommended answer',
)
rejects(
  P.parseRoundInput,
  { ...round, questions: [{ question: 'Which?', multiple: true, recommended: ['A'] }] },
  'question 1 needs choices to allow several',
)
rejects(
  P.parseRoundInput,
  { ...round, questions: [{ ...several, multiple: 'yes' }] },
  'question 1’s multiple must be true or false',
)
rejects(P.parsePostCommentRequest, { body: 'Which?', multiple: true }, 'needs choices')
rejects(P.parseAnswerRequest, { action: 'answer', choices: ['Board', 3] }, 'choices must be a list')
rejects(
  P.parseAnswerRequest,
  { action: 'answer', choices: ['1', '2', '3', '4', '5', '6', '7'] },
  'at most 6 choices',
)
test('long choices keep their line breaks and match a multi-line recommended answer', () => {
  const long = `Keep both\n${'x'.repeat(990)}`
  const parsed = P.parseRoundInput({
    ...round,
    questions: [
      {
        question: `Why?\n\n${'q'.repeat(3994)}`,
        choices: [' Keep both \r\n  first  line\n\n\n\nlast ', long],
        recommended: 'Keep both\nfirst line\n\nlast',
      },
    ],
  })
  expect(parsed.questions[0]?.choices).toEqual(['Keep both\nfirst line\n\nlast', long])
  expect(parsed.questions[0]?.recommended).toBe('Keep both\nfirst line\n\nlast')
  expect(P.parseReportOutcomeRequest({ outcome: 'ask', question: 'Q', choices: [long] })).toEqual({
    outcome: 'ask',
    question: 'Q',
    choices: [long],
  })
})
rejects(
  P.parseRoundInput,
  { ...round, questions: [{ ...question, choices: ['x'.repeat(1001), 'This'] }] },
  'a choice is limited to 1000 characters',
)
rejects(
  P.parsePostCommentRequest,
  { body: 'Which?', choices: ['x'.repeat(1001)] },
  'a choice is limited to 1000 characters',
)
rejects(
  P.parseRoundInput,
  { ...round, questions: [{ ...question, question: 'q'.repeat(4001) }] },
  'question 1 is limited to 4000 characters',
)
rejects(P.parseRoundInput, { ...round, title: 'x'.repeat(201) }, 'title is limited to 200')
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
  expect(P.parseArchiveTaskRequest(null)).toEqual({ closePullRequests: false })
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
roundTrip(P.parseUnarchiveTaskRequest, {
  unlinkParent: true,
  children: 'restore',
  hierarchyRevision: 'a'.repeat(64),
})
rejects(P.parseUnarchiveTaskRequest, { children: 'all' }, 'children must be restore')
rejects(P.parseArchiveTaskRequest, { children: 'keep' }, 'children must be archive or detach')
rejects(P.parseCreateTaskRequest, { title: 'T', parent: 7 }, 'parent must be text')
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
