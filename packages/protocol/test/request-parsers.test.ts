import { expect, test } from 'vitest'
import * as P from '../src/index.ts'
import { rejects, roundTrip } from './parser-cases.ts'

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
  factory: 'TED',
  message: 'Plan',
  from: 'old-plan',
  agent: 'codex',
  model: 'gpt-5.5',
  effort: 'high',
})
roundTrip(P.parseRenamePlanRequest, { title: 'New title' })
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
  agent: 'codex',
  model: 'gpt-5.5',
  effort: 'high',
})
const version = 'a'.repeat(64)
const completeAction: Required<P.CoordinatorAction> = {
  operation: 'unique',
  version,
  after: 'TED-1',
  before: 'TED-3',
  neighbours: { 'TED-1': version },
  message: 'Continue',
  request: 'comment-1',
  choice: 'Yes',
}
for (const kind of ['start', 'move', 'tell', 'answer'] as const) {
  test(`parseCoordinatorAction keeps every ${kind} field`, () => {
    const base = { operation: 'unique', version }
    const body =
      kind === 'start' || kind === 'move'
        ? { ...base, after: 'TED-1', before: 'TED-3', neighbours: { 'TED-1': version } }
        : kind === 'tell'
          ? { ...base, message: 'Continue' }
          : { ...base, request: 'comment-1', choice: 'Yes', message: 'Continue' }
    expect(P.parseCoordinatorAction(completeAction, kind)).toEqual(body)
  })
}
roundTrip(P.parseShellSize, { cols: 80, rows: 24 })
roundTrip(P.parseShellInputRequest, { data: 'ls\n' })
roundTrip(P.parseOpenInEditorRequest, { file: 'src/main.ts', line: 10, column: 2 })
roundTrip(P.parseRunFixRequest, { fix: 'gh-login', host: 'github.com' })
roundTrip(P.parseSaveLinearKeyRequest, { key: 'test-key', inFile: true })
roundTrip(P.parseLinearLookupRequest, { url: 'https://linear.app/team/issue/ENG-1/title' })
roundTrip(P.parseAllowLinearTeamRequest, { factoryId: 'factory', team: 'ENG' })
roundTrip(P.parseRestoreBackupRequest, { name: 'backup', stopRuns: true })
roundTrip(P.parseShutdownRequest, { keepRuns: true })
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
roundTrip(P.parseAssessFailureRequest, { assessment: 'regression', recommendation: 'Fix this' })
roundTrip(P.parseResolveFailureRequest, {
  requestId: 'request',
  resolution: 'fixed',
  reason: 'Resolved',
})

rejects(P.parseAppRef, {}, 'name the App')
rejects(P.parseStartAppRequest, { name: 'Dev', shutDown: 2 }, 'shutDown must name')
rejects(P.parseRecordAppRequest, { name: 'Dev', action: 'other' }, 'action must be')
rejects(P.parseStartSubAgentRequest, { prompt: '' }, 'prompt file is empty')
rejects(P.parseSendSubAgentRequest, { text: ' ' }, 'text is required')
rejects(P.parseSendRunMessageRequest, { text: 'Hi', interrupt: 1 }, 'interrupt must be')
rejects(P.parseStartDevRunRequest, { prompt: 'Work', cwd: 'relative' }, 'absolute path')
rejects(P.parseStartPlanRequest, { factory: '', message: 'Plan' }, 'name the Factory')
rejects(P.parseRenamePlanRequest, { title: 2 }, 'title must be text')
rejects(P.parsePostPlanRequest, { supersedes: 2 }, 'supersedes must be')
rejects(P.parseSendPeerMessage, { operation: 'id' }, 'operation and text are required')
rejects(P.parseCoordinatorMessage, { text: 1 }, 'text is required')
rejects(
  (v) => P.parseCoordinatorAction(v, 'tell'),
  { operation: 'id', version, message: 'a'.repeat(8001) },
  'limited to 8000',
)
rejects(P.parseShellSize, { cols: 1, rows: 24 }, 'whole number from 2 to 1000')
rejects(P.parseShellInputRequest, { data: '' }, 'data must be text')
rejects(P.parseOpenInEditorRequest, { line: 2 }, 'line and column need a file')
rejects(P.parseRunFixRequest, { fix: 'other' }, 'fix must be')
rejects(P.parseSaveLinearKeyRequest, { key: 'key', inFile: 2 }, 'inFile must be')
rejects(P.parseLinearLookupRequest, { url: 2 }, 'url must be text')
rejects(P.parseAllowLinearTeamRequest, { factoryId: 'factory', team: 'bad key' }, 'Linear team key')
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
rejects(P.parseResolveFailureRequest, { resolution: 'other' }, 'unknown failure resolution')

test('permissive optional bodies retain defaults', () => {
  expect(P.parseBannerActionInput({ folder: 2 })).toEqual({})
  expect(P.parseRestoreBackupRequest(null)).toEqual({ name: '', stopRuns: false })
  expect(P.parseShutdownRequest(null)).toEqual({ keepRuns: false })
  expect(P.parseOpenInEditorRequest(null)).toEqual({})
  expect(P.parseSendRunMessageRequest({ text: ' Hi ' })).toEqual({ text: 'Hi', interrupt: false })
  expect(P.parseStartAppRequest({ name: ' Dev ', reason: 'x'.repeat(501) }).reason).toHaveLength(
    500,
  )
})
