import { expect, test } from 'vitest'
import * as P from '../src/index.ts'
import { type AllFields, rejects, roundTrip, variant, variants } from './parser-cases.ts'

roundTrip(P.parseAppRef, { name: 'Dev', repo: 'ted' })
roundTrip(P.parseStartAppRequest, {
  name: 'Dev',
  repo: 'ted',
  shutDown: 'simulator',
  reason: 'Try app',
})
roundTrip(P.parseRecordAppRequest, { name: 'Dev', repo: 'ted', action: 'start' })
roundTrip(P.parseRecordAppRequest, { name: 'Dev', repo: 'ted', action: 'stop' })
roundTrip(P.parseStartSubAgentRequest, {
  prompt: 'Review',
  agent: 'codex',
  model: 'gpt-5.5',
  effort: 'high',
  name: 'Reviewer',
  ownWorktree: true,
  reviewer: true,
})
roundTrip(P.parseSendSubAgentRequest, { text: 'Follow up' })
roundTrip(P.parseSendRunMessageRequest, { text: 'Continue', interrupt: true })
roundTrip(P.parseStartDevRunRequest, { prompt: 'Work', cwd: '/tmp/work', agent: 'codex' })
roundTrip(P.parseStartPlanRequest, {
  factory: 'Ted',
  message: 'Plan',
  from: 'old-plan',
  agent: 'codex',
  model: 'gpt-5.5',
  effort: 'high',
  agentId: 'planner',
})
roundTrip(P.parseRenamePlanRequest, { title: 'New title' })
roundTrip(P.parseRenameCoordinatorChatRequest, { title: 'Release review' })
roundTrip(P.parseResumePlanRequest, { message: 'Carry on' })
const round = {
  title: 'Choices',
  summary: 'Pick',
  questions: [{ question: 'Which?', choices: ['Yes'], recommended: 'Yes' }],
}
const proposal = {
  title: 'Pieces',
  summary: 'Plan',
  tasks: [{ title: 'One', scope: 'Scope', description: 'Details', priority: 'high' }],
} satisfies P.ProposalInput
roundTrip(P.parsePostPlanRequest, { round, proposal, supersedes: 'old' })
roundTrip(P.parseSendPeerMessage, { operation: 'unique', text: 'Coordinate' })
roundTrip(P.parseCoordinatorMessage, {
  text: 'Coordinate',
  agentId: 'release-scout',
  agent: 'codex',
  model: 'gpt-5.5',
  effort: 'high',
})
roundTrip(P.parseRunChatCommandRequest, { name: 'web-test' })
rejects(P.parseRunChatCommandRequest, { name: 'rm -rf /' }, 'command names')
rejects(P.parseRunChatCommandRequest, {}, 'name must be')
variants(P.parsePostChatRequest, [
  { question: { text: 'Which repo?', choices: ['web', 'api'], multiple: true }, supersedes: 'old' },
  { round },
  { proposal, supersedes: 'old' },
  {
    agent: {
      id: 'billing-guide',
      name: 'Billing guide',
      instructions: '# Billing guide\n',
      powers: ['ask', 'read_code'],
      change: true,
      summary: 'Answers billing questions.',
    },
    supersedes: 'old',
  },
])
roundTrip(P.parseAgentDraftInput, {
  id: 'billing-guide',
  name: 'Billing guide',
  instructions: '# Billing guide\n',
  powers: ['ask', 'read_code'],
  change: true,
  summary: 'Answers billing questions.',
})
variants<P.AgentDraftAnswer, P.AgentDraftAnswer[]>(P.parseAgentDraftAnswer, [
  {
    action: 'create',
    where: 'factory',
    name: 'Billing guide',
    instructions: '# Billing guide\n',
    powers: ['read_code'],
  },
  { action: 'dismiss' },
])
test('an Agent draft refuses an outside power and caps its text, and keeps the power order', () => {
  const draft = { id: 'helper', name: 'Helper', instructions: 'Help.', powers: ['read_code'] }
  expect(() => P.parseAgentDraftInput({ ...draft, powers: ['deploy'] })).toThrow(
    '"deploy" isn’t a power',
  )
  expect(() => P.parseAgentDraftInput({ ...draft, id: 'Not An Id' })).toThrow('agent.id')
  expect(() => P.parseAgentDraftInput({ ...draft, name: 'x'.repeat(61) })).toThrow('agent.name')
  expect(() => P.parseAgentDraftInput({ ...draft, instructions: 'x'.repeat(20_001) })).toThrow(
    'agent.instructions has 1–20,000 characters',
  )
  expect(
    P.parseAgentDraftInput({ ...draft, powers: ['manage_agents', 'ask', 'ask'], change: false }),
  ).toEqual({ ...draft, powers: ['ask', 'manage_agents'] })
  expect(() => P.parseAgentDraftAnswer({ action: 'create', where: 'elsewhere', ...draft })).toThrow(
    'where is library or factory',
  )
})
test('parsePostChatRequest takes exactly one request and checks the Agent id rule', () => {
  expect(() => P.parsePostChatRequest({ round, proposal })).toThrow(
    'send one of question, round, proposal or agent',
  )
  expect(() => P.parsePostChatRequest({})).toThrow('send one of question, round, proposal or agent')
  expect(() => P.parsePostChatRequest({ question: { text: ' ' } })).toThrow('a question has')
  expect(() => P.parsePostChatRequest({ question: { text: 'Why?' }, supersedes: '' })).toThrow(
    'supersedes',
  )
  expect(() => P.parseCoordinatorMessage({ text: 'Hi', agentId: 'Not An Id' })).toThrow('agentId')
})
const version = 'a'.repeat(64)
const completeAction: Required<P.CoordinatorAction> = {
  operation: 'unique',
  parentId: 'TED-2',
  hierarchyRevision: version,
  version,
  after: 'TED-1',
  before: 'TED-3',
  neighbours: { 'TED-1': version },
  message: 'Continue',
  request: 'comment-1',
  choice: 'Yes',
  choices: ['Board', 'List'],
  decision: 'approve',
  answers: [
    { answer: 'Yes', note: 'Reason' },
    { answer: '', choices: ['Board', 'List'], note: 'Both' },
  ],
  recommended: true,
  skipRows: [2],
  startUnblocked: true,
  closePullRequests: false,
}
for (const kind of ['start', 'move', 'tell', 'resume', 'done'] as const) {
  test(`parseCoordinatorAction keeps every ${kind} field`, () => {
    const base = { operation: 'unique', version }
    const body =
      kind === 'start' || kind === 'move'
        ? { ...base, after: 'TED-1', before: 'TED-3', neighbours: { 'TED-1': version } }
        : kind === 'done'
          ? base
          : kind === 'tell' || kind === 'resume'
            ? { ...base, message: 'Continue' }
            : { ...base, request: 'comment-1', choice: 'Yes', message: 'Continue' }
    expect(P.parseCoordinatorAction(completeAction, kind)).toEqual(body)
  })
}
test('parseCoordinatorCreate keeps every field', () => {
  const body = {
    operation: 'create-1',
    title: 'Add offline badge',
    description: 'Show a badge while edits wait to sync.',
    parentId: 'TED-1',
    blockedBy: ['TED-2'],
    source: 'https://linear.app/team/issue/ENG-1/title',
    priority: 'high',
    clarifyDepth: 'few',
    lead: { agent: 'codex', model: 'gpt-5', effort: 'high' },
    start: true,
    after: 'TED-3',
    before: 'TED-4',
    neighbours: { 'TED-3': version, 'TED-4': version },
  }
  expect(P.parseCoordinatorCreate(body)).toEqual(body)
})
test('parseCoordinatorRemoval keeps every field and refuses choices that don’t fit the kind', () => {
  const body: Required<P.CoordinatorRemoval> = {
    operation: 'archive-1',
    tasks: [
      { id: 'TED-1', version },
      { id: 'TED-2', version },
    ],
    children: 'detach',
    closePullRequests: true,
  }
  expect(P.parseCoordinatorRemoval(body, 'archive')).toEqual(body)
  expect(
    P.parseCoordinatorRemoval(
      { ...body, children: 'unparent', closePullRequests: undefined },
      'delete',
    ),
  ).toEqual({ ...body, children: 'unparent', closePullRequests: undefined })
  expect(() => P.parseCoordinatorRemoval(body, 'delete')).toThrow('children must be')
  expect(() => P.parseCoordinatorRemoval({ ...body, children: undefined }, 'unarchive')).toThrow(
    'only applies to archive',
  )
  expect(() => P.parseCoordinatorRemoval({ ...body, tasks: [] }, 'archive')).toThrow('tasks lists')
  expect(() =>
    P.parseCoordinatorRemoval({ ...body, tasks: [body.tasks[0], body.tasks[0]] }, 'archive'),
  ).toThrow('name each Task once')
})
test('parseCoordinatorTransfer keeps every field', () => {
  const body: Required<P.CoordinatorTransfer> = {
    operation: 'transfer-1',
    task: { id: 'TED-1', version },
    factory: 'WEB',
    reason: 'The user asked to move it',
  }
  expect(P.parseCoordinatorTransfer(body)).toEqual(body)
  expect(P.parseCoordinatorTransfer({ ...body, factory: ' WEB ' })).toEqual(body)
  expect(() => P.parseCoordinatorTransfer({ ...body, factory: ' ' })).toThrow('factory must be')
  expect(() => P.parseCoordinatorTransfer({ ...body, task: { id: 'TED-1' } })).toThrow('version')
  expect(() => P.parseCoordinatorTransfer({ ...body, operation: 'a b' })).toThrow('operation')
  expect(() => P.parseCoordinatorTransfer({ ...body, reason: ' ' })).toThrow('give a reason')
})
test('parseCoordinatorConfirmationAnswer keeps every field', () => {
  const body: Required<P.CoordinatorConfirmationAnswer> = {
    decision: 'confirm',
    choices: {
      'TED-1': { children: 'archive', closePullRequests: true },
      'TED-2': { children: 'delete' },
    },
  }
  expect(P.parseCoordinatorConfirmationAnswer(body)).toEqual(body)
  expect(
    P.parseCoordinatorConfirmationAnswer({
      decision: 'confirm',
      choices: { 'TED-1': { closePullRequests: false } },
    }),
  ).toEqual({ decision: 'confirm', choices: { 'TED-1': { closePullRequests: false } } })
  expect(P.parseCoordinatorConfirmationAnswer({ decision: 'cancel' })).toEqual({
    decision: 'cancel',
  })
  expect(() => P.parseCoordinatorConfirmationAnswer({ decision: 'maybe' })).toThrow('decision')
})
test('parseCoordinatorTaskQuery keeps every field and coordinatorTaskSearch writes them', () => {
  const query: AllFields<P.CoordinatorTaskQuery> = {
    offset: 100,
    all: true,
    stages: ['backlog', 'work'],
    statuses: ['waiting-on-you', 'failed'],
    waiting: true,
    search: 'offline badge & sync',
  }
  expect(P.parseCoordinatorTaskQuery(P.coordinatorTaskSearch(query))).toEqual(query)
  expect(P.parseCoordinatorTaskQuery('?stage=work&stage=work&search=%20%20')).toEqual({
    stages: ['work'],
  })
  expect(P.parseCoordinatorTaskQuery('?stage=security-review')).toEqual({
    stages: ['security-review'],
  })
  expect(P.coordinatorTaskSearch({})).toBe('')
})
test('parseAsanaChoicesQuery keeps the offset and refuses anything else', () => {
  const query: AllFields<P.AsanaChoicesQuery> = {
    offset: 'eyJ0eXAiOiJKV1Qi.LCJhbGc-iOi_JIUzI1NiJ9',
  }
  expect(P.parseAsanaChoicesQuery(`?offset=${encodeURIComponent(query.offset)}`)).toEqual(query)
  expect(P.parseAsanaChoicesQuery('')).toEqual({})
  expect(() => P.parseAsanaChoicesQuery('?offset=a&offset=b')).toThrow('given once')
  expect(() => P.parseAsanaChoicesQuery('?offset=a%20b')).toThrow('next page')
  expect(() => P.parseAsanaChoicesQuery('?limit=5')).toThrow('unknown query parameter limit')
})
const taskQueryRejections: [string, string][] = [
  ['stage=Queued', 'unknown Stage Queued'],
  ['status=idle', 'unknown status idle'],
  ['offset=-1', 'offset must be a whole number'],
  ['all=yes', 'all takes no value'],
  ['waiting=1&waiting=1', 'waiting may be given once'],
  ['factory=NB', 'unknown Task list filter factory'],
  [`search=${'a'.repeat(201)}`, 'limited to 200'],
]
for (const [search, message] of taskQueryRejections)
  test(`parseCoordinatorTaskQuery rejects ${message}`, () => {
    expect(() => P.parseCoordinatorTaskQuery(search)).toThrow(message)
    expect(() => P.parseCoordinatorTaskQuery(search)).toThrow(P.RequestValidationError)
  })
roundTrip(P.parseShellSize, { cols: 80, rows: 24 })
roundTrip(P.parseShellInputRequest, { data: 'ls\n' })
roundTrip(P.parseOpenInEditorRequest, { file: 'src/main.ts', line: 10, column: 2, snapshot: true })
roundTrip(P.parseRunFixRequest, { fix: 'gh-login', host: 'github.com' })
roundTrip(P.parseSaveLinearKeyRequest, { key: 'test-key', inFile: true })
roundTrip(P.parseLinearLookupRequest, { url: 'https://linear.app/team/issue/ENG-1/title' })
roundTrip(P.parseAllowLinearTeamRequest, { factoryId: 'factory', team: 'ENG' })
roundTrip(P.parseSetFactoryLinearIntakeRequest, {
  scope: {
    kind: 'team',
    id: 'team-one',
    name: 'One',
    workspaceId: 'workspace-one',
    workspace: 'acme',
  },
})
variant(P.parseSetFactoryLinearIntakeRequest, { scope: null })
roundTrip(P.parseSetFactoryAsanaIntakeRequest, {
  scope: {
    workspace: { gid: '1', name: 'Acme' },
    project: { gid: '9', name: 'Roadmap' },
    section: { gid: '91', name: 'Now' },
  },
})
variant(P.parseSetFactoryAsanaIntakeRequest, { scope: null })
roundTrip(P.parseSetFactoryGitHubIntakeRequest, { scope: { label: 'ready for Ted' } })
roundTrip(
  P.parseSetFactoryGitHubIntakeRequest,
  { scope: { label: '  ready  ' } },
  { scope: { label: 'ready' } },
)
variant(P.parseSetFactoryGitHubIntakeRequest, { scope: null })
roundTrip(P.parseAsanaIntakeRequest, { factory: 'NB' })
roundTrip(P.parseGitHubIntakeRequest, { factory: 'NB' })
variant(P.parseGitHubIntakeRequest, {})
roundTrip(P.parseLinearIntakeRequest, { factory: 'NB' })
roundTrip(P.parseAllowAsanaProjectRequest, { factoryId: 'factory', project: '9' })
roundTrip(P.parseForgetAsanaProjectRequest, { factoryId: 'factory', project: '9', list: 'allowed' })
variant(P.parseForgetAsanaProjectRequest, { factoryId: 'factory', project: '9', list: 'declined' })

roundTrip(P.parseRestoreBackupRequest, { name: 'backup', stopRuns: true })
roundTrip(P.parseShutdownRequest, { keepRuns: true })
roundTrip(P.parseProfileRequest, { seconds: 45 })
roundTrip(P.parseBannerActionInput, { folder: '/tmp/repo' })
roundTrip(P.parseDraftLineCommentRequest, {
  repo: 'ted',
  path: 'src/main.ts',
  from: { old: 1, new: 1 },
  to: { old: 2, new: 2 },
  body: 'Change this',
})
roundTrip(P.parseEditLineCommentRequest, { body: 'Change this' })
for (const source of [
  { kind: 'factory-check', checkRunId: 'check', position: 0 },
  { kind: 'post-rebase-check', checkRunId: 'check', position: 1 },
  { kind: 'finding', runId: 'run', finding: 'Finding' },
  { kind: 'github-ci', repo: 'owner/repo', number: 1, head: 'a'.repeat(40), attempt: '1' },
] satisfies P.FailureSource[])
  roundTrip(P.parseRecordFailureRequest, { source, evidence: 'Evidence', contextId: 'context' })
roundTrip(P.parseAddFailureEvidenceRequest, { evidence: 'More evidence', contextId: 'context' })
roundTrip(P.parseAssessFailureRequest, {
  assessment: 'unrelated',
  recommendation: 'Wait for TED-639',
  repairTask: 'TED-639',
})
roundTrip(P.parseResolveFailureRequest, {
  requestId: 'request',
  resolution: 'repair',
  reason: 'Wait for a focused repair',
  repair: { kind: 'existing', taskId: 'repair-task' },
})

rejects(P.parseAppRef, {}, 'name the App')
rejects(P.parseSetFactoryGitHubIntakeRequest, { scope: { label: ' ' } }, 'Type a GitHub label')
rejects(
  P.parseSetFactoryGitHubIntakeRequest,
  { scope: { label: 'x'.repeat(51) } },
  'Type a GitHub label',
)
rejects(P.parseSetFactoryGitHubIntakeRequest, { scope: { label: 'a\nb' } }, 'Type a GitHub label')
rejects(
  P.parseSetFactoryGitHubIntakeRequest,
  { scope: { label: 'ok', extra: 1 } },
  'Type a GitHub label',
)
rejects(P.parseProfileRequest, { seconds: 121 }, 'whole number from 5 to 120')
rejects(P.parseProfileRequest, { seconds: '30' }, 'whole number from 5 to 120')
rejects(P.parseStartAppRequest, { name: 'Dev', shutDown: 2 }, 'shutDown must name')
rejects(P.parseRecordAppRequest, { name: 'Dev', action: 'other' }, 'action must be')
rejects(P.parseStartSubAgentRequest, { prompt: '' }, 'prompt file is empty')
rejects(P.parseSendSubAgentRequest, { text: ' ' }, 'text is required')
rejects(P.parseSendRunMessageRequest, { text: 'Hi', interrupt: 1 }, 'interrupt must be')
rejects(P.parseStartDevRunRequest, { prompt: 'Work', cwd: 'relative' }, 'absolute path')
rejects(P.parseStartPlanRequest, { factory: '', message: 'Plan' }, 'name the Factory')
rejects(P.parseRenamePlanRequest, { title: 2 }, 'title must be text')
rejects(P.parseResumePlanRequest, { message: 2 }, 'message must be text')
rejects(P.parsePostPlanRequest, { supersedes: 2 }, 'supersedes must be')
rejects(P.parseSendPeerMessage, { operation: 'id' }, 'operation and text are required')
rejects(P.parseCoordinatorMessage, { text: 1 }, 'text is required')
rejects(P.parseRenameCoordinatorChatRequest, { title: 2 }, 'title must be text')
rejects(
  (v) => P.parseCoordinatorAction(v, 'tell'),
  { operation: 'id', version, message: 'a'.repeat(8001) },
  'limited to 8000',
)
rejects(P.parseCoordinatorCreate, { operation: 'id', title: ' ' }, 'title is required')
rejects(P.parseCoordinatorCreate, { operation: 'id', title: 'a'.repeat(301) }, 'limited to 300')
rejects(
  P.parseCoordinatorCreate,
  { operation: 'id', title: 'T', description: 'a'.repeat(8001) },
  'limited to 8000',
)
rejects(
  P.parseCoordinatorCreate,
  { operation: 'id', title: 'T', attachments: [] },
  'can’t be set when the Coordinator creates a Task',
)
rejects(P.parseShellSize, { cols: 1, rows: 24 }, 'whole number from 2 to 1000')
rejects(P.parseShellInputRequest, { data: '' }, 'data must be text')
rejects(P.parseOpenInEditorRequest, { line: 2 }, 'line, column and snapshot need a file')
rejects(P.parseRunFixRequest, { fix: 'other' }, 'fix must be')
rejects(P.parseSaveLinearKeyRequest, { key: 'key', inFile: 2 }, 'inFile must be')
rejects(P.parseLinearLookupRequest, { url: 2 }, 'url must be text')
rejects(P.parseAllowLinearTeamRequest, { factoryId: 'factory', team: 'bad key' }, 'Linear team key')
rejects(
  P.parseSetFactoryLinearIntakeRequest,
  { scope: { kind: 'both' } },
  'Choose a valid Linear scope',
)
rejects(P.parseSetFactoryLinearIntakeRequest, {}, 'Choose a valid Linear scope')
rejects(
  P.parseSetFactoryAsanaIntakeRequest,
  { scope: { workspace: { gid: '1', name: 'Acme' }, project: { gid: 'x', name: 'Roadmap' } } },
  'Choose an Asana workspace and project',
)
rejects(P.parseSetFactoryAsanaIntakeRequest, {}, 'Choose an Asana workspace and project')
rejects(P.parseAsanaIntakeRequest, { factory: '' }, 'Factory key')
rejects(P.parseGitHubIntakeRequest, { factory: '' }, 'Factory key')
rejects(P.parseGitHubIntakeRequest, { factory: 3 }, 'Factory key')
rejects(P.parseLinearIntakeRequest, { factory: '' }, 'Factory key')
rejects(P.parseLinearIntakeRequest, { factory: 7 }, 'Factory key')
rejects(
  P.parseAllowAsanaProjectRequest,
  { factoryId: 'factory', project: 'https://app.asana.com/0/9' },
  'Asana project ID',
)
rejects(P.parseAllowAsanaProjectRequest, { project: '9' }, 'Factory ID')
rejects(
  P.parseForgetAsanaProjectRequest,
  { factoryId: 'factory', project: '9', list: 'all' },
  'allowed or declined',
)

rejects(
  P.parseDraftLineCommentRequest,
  { repo: 'ted', path: 'file', from: { old: 0 }, body: 'Hi' },
  'line number',
)
rejects(P.parseEditLineCommentRequest, { body: '' }, 'needs some text')
rejects(
  P.parseRecordFailureRequest,
  { source: { kind: 'other' }, evidence: 'Hi' },
  'unknown failure source',
)
rejects(P.parseAddFailureEvidenceRequest, { evidence: '' }, 'nonempty text')
rejects(P.parseAssessFailureRequest, { assessment: 'other' }, 'unknown failure assessment')
rejects(
  P.parseAssessFailureRequest,
  { assessment: 'unrelated', recommendation: 'Wait', repairTask: '' },
  'repairTask must be nonempty text',
)
rejects(P.parseResolveFailureRequest, { resolution: 'other' }, 'unknown failure resolution')
for (const body of [null, [], 'text', 0])
  rejects(P.parseVerifyFailureRequest, body, 'failure request must be an object')
rejects(
  P.parseAddFailureEvidenceRequest,
  { evidence: 'x'.repeat(16_001) },
  'evidence must be nonempty text up to 16000 characters',
)
rejects(
  P.parseAddFailureEvidenceRequest,
  { evidence: 'Evidence', contextId: 7 },
  'contextId must be nonempty text',
)
for (const position of [-1, 1.5, '1'])
  rejects(
    P.parseRecordFailureRequest,
    { source: { kind: 'factory-check', checkRunId: 'check', position }, evidence: 'Hi' },
    'position must be a nonnegative integer',
  )
const ci = { kind: 'github-ci', repo: 'owner/repo', number: 1, head: 'a'.repeat(40), attempt: '1' }
for (const number of [0, 1.5, '1'])
  rejects(
    P.parseRecordFailureRequest,
    { source: { ...ci, number }, evidence: 'Hi' },
    'number must be a positive PR number',
  )
rejects(
  P.parseRecordFailureRequest,
  { source: { ...ci, head: 'main' }, evidence: 'Hi' },
  'head must be a commit ID',
)
rejects(
  P.parseRecordFailureRequest,
  { source: 'finding', evidence: 'Hi' },
  'failure request must be an object',
)
rejects(
  P.parseResolveFailureRequest,
  { requestId: 'r', resolution: 'repair' },
  'failure request must be an object',
)
rejects(
  P.parseResolveFailureRequest,
  { requestId: 'r', resolution: 'repair', repair: {} },
  'choose an existing or new repair Task',
)
rejects(
  P.parseResolveFailureRequest,
  { requestId: 'r', resolution: 'repair', repair: { kind: 'new', title: 'T', start: 'yes' } },
  'start must be a boolean',
)
rejects(
  P.parseResolveFailureRequest,
  { requestId: 'r', resolution: 'fix', repair: { kind: 'existing', taskId: 't' } },
  'repair selection needs repair resolution',
)

test('permissive optional bodies retain defaults', () => {
  expect(P.parseBannerActionInput({ folder: 2 })).toEqual({})
  expect(P.parseRestoreBackupRequest(null)).toEqual({ name: '', stopRuns: false })
  expect(P.parseShutdownRequest(null)).toEqual({ keepRuns: false })
  expect(P.parseProfileRequest(null)).toEqual({ seconds: 30 })
  expect(P.parseOpenInEditorRequest(null)).toEqual({})
  expect(P.parseSendRunMessageRequest({ text: ' Hi ' })).toEqual({ text: 'Hi', interrupt: false })
  expect(P.parseStartAppRequest({ name: ' Dev ', reason: 'x'.repeat(501) }).reason).toHaveLength(
    500,
  )
})

test('Coordinator answer variants keep every request field', () => {
  const base = {
    operation: completeAction.operation,
    version,
    request: completeAction.request,
    message: completeAction.message,
    skipRows: completeAction.skipRows,
    startUnblocked: completeAction.startUnblocked,
  }
  const inputs = [
    { ...base, choice: completeAction.choice },
    { ...base, choices: completeAction.choices },
    { ...base, choice: 'Archive', closePullRequests: completeAction.closePullRequests },
    { ...base, decision: completeAction.decision },
    { ...base, answers: completeAction.answers },
    { ...base, recommended: completeAction.recommended },
  ]
  for (const body of inputs) expect(P.parseCoordinatorAction(body, 'answer')).toEqual(body)
})
rejects(
  (value) => P.parseCoordinatorAction(value, 'answer'),
  { operation: 'id', version, request: 'comment', choice: 'Yes', decision: 'approve' },
  'give one of:',
)
rejects(
  (value) => P.parseCoordinatorAction(value, 'answer'),
  { operation: 'id', version, request: 'comment', choice: 'Yes', choices: ['Yes', 'No'] },
  'give choice or choices, not both',
)
rejects(
  (value) => P.parseCoordinatorAction(value, 'answer'),
  { operation: 'id', version, request: 'comment', choices: ['Yes', 7] },
  'choices must be a list',
)
rejects(
  (value) => P.parseCoordinatorAction(value, 'answer'),
  { operation: 'id', version, request: 'comment', choice: 'Archive', closePullRequests: 'yes' },
  'closePullRequests must be true or false',
)
rejects(
  (value) => P.parseCoordinatorAction(value, 'answer'),
  { operation: 'id', version, request: 'comment', answers: [] },
  'answers must be a list',
)
rejects(
  (value) => P.parseCoordinatorAction(value, 'answer'),
  { operation: 'id', version, request: 'comment', decision: 'approve', skipRows: [0] },
  'skipRows must be',
)
rejects(P.parseOpenInEditorRequest, { file: 'file', snapshot: 'yes' }, 'snapshot must be a boolean')

roundTrip(P.parseShellWorkspaceRequest, { cols: 80, rows: 24, create: true })
roundTrip(P.parseShellWorkspaceRequest, { cols: 80, rows: 24, create: false })
roundTrip(P.parseShellChange, {
  kind: 'split',
  revision: 2,
  shellId: 'shell-1',
  direction: 'right',
  size: { cols: 80, rows: 24 },
})
roundTrip(P.parseShellChange, {
  kind: 'split',
  revision: 3,
  shellId: 'shell-2',
  direction: 'below',
  size: { cols: 80, rows: 24 },
})
roundTrip(P.parseShellChange, { kind: 'close', revision: 4, shellId: 'shell-2' })
roundTrip(P.parseShellChange, { kind: 'ratio', revision: 5, branchId: 'divider-1', ratio: 0.65 })
rejects(
  P.parseShellWorkspaceRequest,
  { cols: 80, rows: 24, create: 'yes' },
  'create must be a boolean',
)
rejects(P.parseShellChange, { kind: 'close', revision: -1, shellId: 'shell-1' }, 'revision must be')
rejects(P.parseShellChange, { kind: 'close', revision: 1, shellId: '../shell' }, 'ID is required')
rejects(
  P.parseShellChange,
  { kind: 'ratio', revision: 1, branchId: 'divider', ratio: 1 },
  'ratio must be',
)

test('Validate failure requests preserve all category, action and verification fields', () => {
  for (const category of ['test', 'review', 'visual'] as const) {
    const body = {
      source: { kind: 'finding', runId: 'reviewer', finding: 'Original failure', category },
      evidence: 'Reproduced before the repair',
      contextId: 'tested-context',
    }
    expect(P.parseRecordFailureRequest(body)).toEqual(body)
  }
  for (const resolution of ['retry', 'fix'] as const) {
    const body = { requestId: 'request', resolution, reason: 'Repeat the identified verification' }
    expect(P.parseResolveFailureRequest(body)).toEqual(body)
  }
  expect(P.parseVerifyFailureRequest({ evidence: ' Fresh reproduction passed ' })).toEqual({
    evidence: 'Fresh reproduction passed',
  })
  expect(P.parseVerifyFailureRequest({ evidence: 'Checks passed', fixedBy: ' TED-492 ' })).toEqual({
    evidence: 'Checks passed',
    fixedBy: 'TED-492',
  })
})

test('Validate failure parsers reject unknown categories and empty verification evidence', () => {
  expect(() =>
    P.parseRecordFailureRequest({
      source: { kind: 'finding', runId: 'reviewer', finding: 'Failure', category: 'other' },
      evidence: 'Evidence',
    }),
  ).toThrow('category must be test, review or visual')
  expect(() => P.parseVerifyFailureRequest({ evidence: '' })).toThrow('nonempty text')
  expect(() => P.parseVerifyFailureRequest({ evidence: 'Passed', fixedBy: '' })).toThrow(
    'fixedBy must be nonempty text',
  )
})

test('Coordinator parent edits retain all fields and require an explicit parent and hierarchy revision', () => {
  const input = { operation: 'parent-edit', version, parentId: 'TED-2', hierarchyRevision: version }
  expect(P.parseCoordinatorAction(input, 'parent')).toEqual(input)
  expect(P.parseCoordinatorAction({ ...input, parentId: null }, 'parent')).toEqual({
    ...input,
    parentId: null,
  })
  expect(() =>
    P.parseCoordinatorAction({ ...input, hierarchyRevision: undefined }, 'parent'),
  ).toThrow('hierarchyRevision')
  expect(() => P.parseCoordinatorAction({ ...input, parentId: undefined }, 'parent')).toThrow(
    'parentId',
  )
})

test('repair decisions parse existing selection and explicit new-Task approval', () => {
  for (const repair of [
    { kind: 'existing', taskId: 'repair-task' },
    { kind: 'new', title: 'Repair export', description: 'Restore timezone labels', start: true },
    { kind: 'new', title: 'Repair export', description: 'Restore timezone labels', start: false },
  ]) {
    const body = { requestId: 'decision', resolution: 'repair', repair }
    expect(P.parseResolveFailureRequest(body)).toEqual(body)
  }
  for (const repair of [
    undefined,
    {},
    { kind: 'existing', taskId: '' },
    { kind: 'new', title: '', description: 'Evidence', start: true },
    { kind: 'new', title: 'Repair', description: 'Evidence', start: 'yes' },
  ]) {
    expect(() =>
      P.parseResolveFailureRequest({ requestId: 'decision', resolution: 'repair', repair }),
    ).toThrow()
  }
  expect(() =>
    P.parseResolveFailureRequest({
      requestId: 'decision',
      resolution: 'accepted',
      repair: { kind: 'existing', taskId: 'task' },
    }),
  ).toThrow()
})
