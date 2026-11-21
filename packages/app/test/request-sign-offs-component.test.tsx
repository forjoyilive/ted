// @vitest-environment jsdom
import type { FailureCase } from '@ted/protocol'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AnsweredCard, RequestCard } from '../src/renderer/components/RequestCard.tsx'
import { bridge, deferred, user } from './support/component.ts'
import { comment, createdAt, task } from './support/fixtures.ts'
import { requestApi } from './support/requests.ts'

test('grilling sign-off displays decisions, open questions and button guidance', async () => {
  requestApi()
  render(
    <RequestCard
      task={task()}
      request={comment({
        kind: 'signoff',
        stage: 'clarify',
        gate: {
          approveLabel: 'Approve',
          caption: 'Approve moves the Task on. Request changes starts another round.',
        },
        body: '## Goal\n\nOffline editing\n\n## Decisions so far\n\n- Notes save locally first.\n- Warn after 30 days offline.\n\n## Open questions\n\nNone.',
      })}
    />,
  )
  expect(
    within(screen.getByRole('region', { name: 'Decisions so far' }))
      .getAllByRole('listitem')
      .map((e) => e.textContent),
  ).toEqual(['Notes save locally first.', 'Warn after 30 days offline.'])
  expect(screen.getByText('Open questions: None.')).toBeTruthy()
  expect(
    screen.getByText('Approve moves the Task on. Request changes starts another round.'),
  ).toBeTruthy()
  expect(
    (screen.getByRole('button', { name: 'Request changes' }) as HTMLButtonElement).disabled,
  ).toBe(true)
})

test('gate requests require text for changes and send approval or changes through the bridge', async () => {
  const { answer } = requestApi()
  render(
    <RequestCard
      task={task()}
      request={comment({ kind: 'review', stage: 'design', gate: { approveLabel: 'Approve' } })}
    />,
  )
  const u = user()
  await u.type(screen.getByLabelText('Your answer'), 'Split the sync step.')
  await u.click(screen.getByRole('button', { name: 'Request changes' }))
  expect(answer).toHaveBeenCalledWith('c1', {
    action: 'request-changes',
    text: 'Split the sync step.',
  })
  await u.click(screen.getByRole('button', { name: 'Approve' }))
  expect(answer).toHaveBeenLastCalledWith('c1', { action: 'approve' })
})

test('a Review confirmation shows completed Checks once when progress is available', async () => {
  const check = { name: 'Typecheck', command: 'echo typed', timeout: '1m', state: 'passed' }
  bridge({
    simulators: () => ({ supported: false }),
    emulators: () => ({ supported: false }),
    listApps: () => [],
    listFailures: () => [],
    listThreadEvents: () => [
      {
        id: 'validated-1',
        taskId: 'NB-1',
        at: createdAt,
        tone: 'success',
        text: 'Validate passed',
        validate: 'passed',
        checkRunId: 'checks-1',
      },
    ],
    listCheckRuns: () => [
      {
        id: 'checks-1',
        taskId: 'NB-1',
        stage: 'validate',
        trigger: 'validate',
        startedAt: createdAt,
        outcome: 'passed',
        checks: [check],
      },
    ],
    validationObligations: () => ({
      satisfied: true,
      cases: [],
      blockers: [],
      checkRuns: [],
      progress: {
        taskId: 'NB-1',
        visit: createdAt,
        checks: [check],
        next: 1,
        pending: false,
        executions: [{ runId: 'checks-1', start: 0 }],
      },
    }),
  })
  render(
    <RequestCard
      task={task()}
      request={comment({ kind: 'signoff', stage: 'review', gate: { approveLabel: 'Approve' } })}
    />,
  )
  await screen.findByRole('button', { name: '✓Typecheck' })
  expect(screen.getAllByRole('button', { name: '✓Typecheck' })).toHaveLength(1)
})

test('Review and Merge sign-offs show sandbox access changes on their own line, and only when there are some', () => {
  requestApi()
  const sandboxAccess = [
    {
      kind: 'app' as const,
      repo: 'mobile',
      name: 'iOS simulator',
      gained: ['ios-xcode' as const],
      lost: [],
    },
    {
      kind: 'setup' as const,
      repo: 'mobile',
      name: 'setup',
      gained: [],
      lost: ['ios-xcode' as const],
    },
  ]
  const review = render(
    <RequestCard
      task={task()}
      request={comment({
        kind: 'signoff',
        stage: 'review',
        gate: { approveLabel: 'Approve', sandboxAccess },
      })}
    />,
  )
  const line = within(screen.getByRole('region', { name: 'Sandbox access changes' }))
  expect(line.getByText('Sandbox access changes in .ted/workflow.yaml')).toBeTruthy()
  expect(line.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
    'iOS simulator App in mobile gains ios-xcode',
    'Worktree setup in mobile loses ios-xcode',
  ])
  expect(line.getByText(/ios-xcode is shared access on your Mac/)).toBeTruthy()
  review.unmount()

  const merge = render(
    <RequestCard
      task={task()}
      request={comment({
        kind: 'signoff',
        stage: 'merge',
        title: 'Ready to merge: PR #7',
        gate: {
          approveLabel: 'Merge',
          pullRequests: [
            {
              name: 'mobile',
              repo: 'acme/mobile',
              number: 7,
              title: 'Build iOS',
              url: 'https://github.com/acme/mobile/pull/7',
              checks: { passed: 1, failed: 0, pending: 0 },
              mergeable: true,
              method: 'squash',
              reviewMissing: false,
            },
          ],
          sandboxAccess: sandboxAccess.slice(1),
        },
      })}
    />,
  )
  expect(
    within(screen.getByRole('region', { name: 'Sandbox access changes' })).getByText(
      'Worktree setup in mobile loses ios-xcode',
    ),
  ).toBeTruthy()
  expect(screen.queryByText(/ios-xcode is shared access/)).toBeNull()
  merge.unmount()

  const plain = render(
    <RequestCard
      task={task()}
      request={comment({ kind: 'signoff', stage: 'review', gate: { approveLabel: 'Approve' } })}
    />,
  )
  expect(screen.queryByRole('region', { name: 'Sandbox access changes' })).toBeNull()
  plain.unmount()

  render(
    <RequestCard
      task={task()}
      request={comment({
        kind: 'signoff',
        stage: 'review',
        gate: { approveLabel: 'Approve', sandboxAccessUnknown: true },
      })}
    />,
  )
  expect(
    within(screen.getByRole('region', { name: 'Sandbox access changes' })).getByText(
      'Ted couldn’t compare sandbox access in .ted/workflow.yaml. Check the file’s changes.',
    ),
  ).toBeTruthy()
})

test.each(['Review', 'Visual'])(
  'Review confirmation keeps a failed %s judgment beside its accepted Finding',
  async (name) => {
    const failure: FailureCase = {
      id: 'review-failure',
      taskId: 'NB-1',
      validation: true,
      source: {
        kind: 'finding',
        runId: 'reviewer-1',
        finding: 'Protected action verification failed',
      },
      recordedBy: 'lead-1',
      provenance: 'task-lead-reported',
      evidence: 'The fixture service rejected the action.',
      createdAt,
      assessments: [
        {
          id: 'assessment-1',
          assessment: 'unrelated',
          recommendation: 'Accept this fixture failure.',
          runId: 'lead-1',
          at: createdAt,
        },
      ],
      additions: [],
      decisions: [{ commentId: 'decision-1', assessmentId: 'assessment-1' }],
      resolutions: [
        {
          requestId: 'decision-1',
          assessmentId: 'assessment-1',
          resolution: 'accepted',
          at: createdAt,
        },
      ],
      invalidations: [],
    }
    bridge({
      simulators: () => ({ supported: false }),
      emulators: () => ({ supported: false }),
      listApps: () => [],
      listFailures: () => [failure],
      listCheckRuns: () => [],
      listThreadEvents: () => [
        {
          id: 'validated-1',
          taskId: 'NB-1',
          at: createdAt,
          tone: 'done',
          text: 'Validate passed',
          validate: 'passed',
          judgments: [{ name, passed: false }],
        },
      ],
      validationObligations: () => ({
        satisfied: true,
        blockers: [],
        cases: [{ id: failure.id, disposition: 'accepted', context: 'current' }],
        checkRuns: [],
        progress: {
          taskId: 'NB-1',
          visit: createdAt,
          checks: [],
          next: 0,
          pending: false,
          executions: [],
        },
      }),
    })
    render(
      <RequestCard
        task={task()}
        request={comment({ kind: 'signoff', stage: 'review', gate: { approveLabel: 'Approve' } })}
      />,
    )
    const judgment = await screen.findByText(name, { exact: true })
    expect(judgment.textContent).toBe(`✗${name}`)
    expect(await screen.findByText('Protected action verification failed')).toBeTruthy()
    expect(screen.getByText(/failed, accepted by you/)).toBeTruthy()
  },
)

test('Review keeps its brief and separates current files from changes since approval', async () => {
  const { answer } = requestApi()
  const open = vi.fn()
  const all = vi.fn()
  const changes = {
    taskId: 'NB-1',
    files: 1,
    repos: [
      {
        name: 'widgets',
        baseBranch: 'main',
        added: 4,
        removed: 1,
        files: [{ path: 'src/sync.ts', added: 4, removed: 1, uncommitted: false }],
      },
    ],
  }
  render(
    <RequestCard
      task={task()}
      taskChanges={changes}
      onOpenFile={open}
      onAllChanges={all}
      request={comment({
        kind: 'signoff',
        stage: 'review',
        body: '## Goal\n\nKeep the review evidence.',
        gate: {
          approveLabel: 'Approve',
          changes: {
            since: 'previous',
            summary: 'Fixed the conflict.',
            repos: [
              {
                name: 'widgets',
                files: [
                  { path: 'src/sync.ts', added: 2, removed: 0 },
                  { path: 'removed.ts', added: 0, removed: 1 },
                ],
              },
            ],
          },
        },
      })}
    />,
  )
  expect(screen.getByText('Approval needed again', { exact: false })).toBeTruthy()
  expect(screen.getByText('Keep the review evidence.')).toBeTruthy()
  const current = within(screen.getByRole('region', { name: 'Current Task changes' }))
  expect(current.getByText('1 file · +4 −1')).toBeTruthy()
  expect(current.getByText('Changed since approval')).toBeTruthy()
  expect(screen.getByText('Not in the current Task diff')).toBeTruthy()
  const file = current.getByRole('button', { name: /sync.ts/ })
  expect(file.hasAttribute('data-nav-item')).toBe(true)
  await user().click(file)
  expect(open).toHaveBeenCalledWith({
    ...changes.repos[0]?.files[0],
    repo: 'widgets',
    baseBranch: 'main',
  })
  await user().click(current.getByRole('button', { name: 'View all changes' }))
  expect(all).toHaveBeenCalledOnce()
  expect(answer).not.toHaveBeenCalled()
})

test('Review shows ten changed files in each list until Show more', async () => {
  requestApi()
  const paths = Array.from({ length: 13 }, (_, n) => `src/file-${n + 1}.ts`)
  render(
    <RequestCard
      task={task()}
      taskChanges={{
        taskId: 'NB-1',
        files: 13,
        repos: [
          {
            name: 'widgets',
            baseBranch: 'main',
            added: 13,
            removed: 0,
            files: paths.map((path) => ({ path, added: 1, removed: 0, uncommitted: false })),
          },
        ],
      }}
      onOpenFile={vi.fn()}
      onAllChanges={vi.fn()}
      request={comment({
        kind: 'signoff',
        stage: 'review',
        body: '## Goal\n\nShort lists.',
        gate: {
          approveLabel: 'Approve',
          changes: {
            since: 'previous',
            repos: [
              { name: 'widgets', files: paths.map((path) => ({ path, added: 1, removed: 0 })) },
            ],
          },
        },
      })}
    />,
  )
  const current = within(screen.getByRole('region', { name: 'Current Task changes' }))
  expect(current.getAllByRole('listitem')).toHaveLength(10)
  await user().click(current.getByRole('button', { name: 'Show 3 more' }))
  expect(current.getAllByRole('listitem')).toHaveLength(13)
  expect(current.getByRole('button', { name: 'Show fewer' })).toBeTruthy()

  const since = within(screen.getByRole('region', { name: 'Since your last approval' }))
  expect(since.getAllByRole('listitem')).toHaveLength(10)
  await user().click(since.getByRole('button', { name: 'Show 3 more' }))
  expect(since.getAllByRole('listitem')).toHaveLength(13)
})

test('Review shows loading, missing worktree, empty and unavailable repos without approval actions changing', () => {
  requestApi()
  const props = {
    task: task(),
    request: comment({ kind: 'signoff', stage: 'review', gate: { approveLabel: 'Approve' } }),
    onOpenFile: vi.fn(),
    onAllChanges: vi.fn(),
  }
  const view = render(<RequestCard {...props} />)
  expect(screen.getByText('Loading changes…')).toBeTruthy()
  view.rerender(<RequestCard {...props} taskChanges={{ taskId: 'NB-1', files: 0, repos: [] }} />)
  expect(screen.getByText('No worktree is available for this Task.')).toBeTruthy()
  const repo = { name: 'widgets', baseBranch: 'main', added: 0, removed: 0, files: [] }
  view.rerender(
    <RequestCard {...props} taskChanges={{ taskId: 'NB-1', files: 0, repos: [repo] }} />,
  )
  expect(screen.getByText('No current Task changes.')).toBeTruthy()
  view.rerender(
    <RequestCard
      {...props}
      taskChanges={{
        taskId: 'NB-1',
        files: 0,
        repos: [repo, { ...repo, name: 'api', unavailable: 'Worktree unavailable' }],
      }}
    />,
  )
  expect(screen.getByText('Worktree unavailable')).toBeTruthy()
  expect(screen.getByText('api')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'View all changes' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
})

test('previous review resolves the referenced approval rather than the first sign-off', async () => {
  const api = requestApi()
  const previous = comment({
    id: 'second',
    kind: 'signoff',
    stage: 'review',
    body: '## Goal\n\nThe latest approved evidence.',
    gate: { approveLabel: 'Approve' },
    answer: { kind: 'approved', at: createdAt },
  })
  api.handle('listComments', () => [
    comment({
      id: 'first',
      kind: 'signoff',
      stage: 'review',
      body: 'The obsolete evidence.',
      answer: { kind: 'approved', at: createdAt },
    }),
    previous,
  ])
  render(
    <RequestCard
      task={task()}
      request={comment({
        kind: 'signoff',
        stage: 'review',
        gate: { approveLabel: 'Approve', changes: { since: 'second', repos: [] } },
      })}
    />,
  )
  await user().click(screen.getByRole('button', { name: 'View previously approved review' }))
  const old = await screen.findByRole('region', { name: 'Sign-off, read-only' })
  expect(within(old).getByText('The latest approved evidence.')).toBeTruthy()
  expect(within(old).queryByRole('textbox')).toBeNull()
  expect(screen.queryByText('The obsolete evidence.')).toBeNull()
  expect(screen.getByText(/^Approved /)).toBeTruthy()
})

test('previous Review keeps its own Check execution after a second Validate visit', async () => {
  const later = '2026-11-10T12:00:00.000Z'
  const old = comment({
    id: 'previous',
    kind: 'signoff',
    stage: 'review',
    gate: { approveLabel: 'Approve' },
    answer: { kind: 'approved', at: createdAt },
  })
  const oldCheck = {
    name: 'Old Check',
    command: 'echo old',
    timeout: '1m',
    state: 'passed',
    durationMs: 1,
  }
  const newCheck = {
    name: 'New Check',
    command: 'echo new',
    timeout: '1m',
    state: 'passed',
    durationMs: 1,
  }
  bridge({
    listComments: () => [old],
    listThreadEvents: () => [
      {
        id: 'old-validation',
        taskId: 'NB-1',
        at: createdAt,
        tone: 'done',
        text: 'Validate passed',
        validate: 'passed',
        checkRunId: 'old-run',
        judgments: [{ name: 'Review', passed: true }],
      },
    ],
    listCheckRuns: () => [
      {
        id: 'old-run',
        taskId: 'NB-1',
        trigger: 'validate',
        stage: 'validate',
        outcome: 'passed',
        startedAt: createdAt,
        finishedAt: createdAt,
        checks: [oldCheck],
      },
      {
        id: 'new-run',
        taskId: 'NB-1',
        trigger: 'validate',
        stage: 'validate',
        outcome: 'passed',
        startedAt: later,
        finishedAt: later,
        checks: [newCheck],
      },
    ],
    listFailures: () => [],
    validationObligations: () => ({
      satisfied: true,
      cases: [],
      blockers: [],
      checkRuns: [],
      progress: {
        taskId: 'NB-1',
        visit: later,
        checks: [newCheck],
        next: 1,
        pending: false,
        executions: [{ runId: 'new-run', start: 0 }],
      },
    }),
    listApps: () => [],
    simulators: () => ({ supported: false }),
    emulators: () => ({ supported: false }),
  })
  render(
    <RequestCard
      task={task()}
      request={comment({
        id: 'current',
        kind: 'signoff',
        stage: 'review',
        createdAt: later,
        gate: { approveLabel: 'Approve', changes: { since: 'previous', repos: [] } },
      })}
    />,
  )
  await user().click(screen.getByRole('button', { name: 'View previously approved review' }))
  const history = await screen.findByRole('region', { name: 'Sign-off, read-only' })
  await waitFor(() => expect(history.textContent).toMatch(/Old Check|New Check/))
  const text = history.textContent ?? ''
  expect({
    oldExecution: text.includes('Old Check'),
    newExecution: text.includes('New Check'),
  }).toEqual({ oldExecution: true, newExecution: false })
  expect(within(history).queryByRole('button', { name: 'Approve' })).toBeNull()
})

test('previous Review retains its recorded Check plan and acceptance after later repair and decisions', async () => {
  const later = '2026-11-10T12:00:00.000Z'
  const accepted: FailureCase = {
    id: 'old-failure',
    taskId: 'NB-1',
    validation: true,
    source: { kind: 'factory-check', checkRunId: 'old-run', position: 0 },
    recordedBy: 'old-lead',
    provenance: 'stored-check',
    evidence: 'Original service failure',
    createdAt,
    contextId: 'old-context',
    additions: [],
    invalidations: [],
    assessments: [
      {
        id: 'old-assessment',
        runId: 'old-lead',
        assessment: 'unrelated',
        recommendation: 'Original recommendation',
        at: createdAt,
        evidenceCount: 0,
      },
    ],
    decisions: [
      { commentId: 'old-decision', assessmentId: 'old-assessment', contextId: 'old-context' },
    ],
    resolutions: [
      {
        requestId: 'old-decision',
        assessmentId: 'old-assessment',
        resolution: 'accepted',
        reason: 'Original decision',
        at: createdAt,
      },
    ],
  }
  const oldCheck = {
    name: 'Old Check',
    command: 'echo old',
    timeout: '1m',
    state: 'failed',
    exitCode: 1,
  }
  const tail = {
    name: 'Old remaining Check',
    command: 'echo tail',
    timeout: '1m',
    state: 'passed',
    exitCode: 0,
  }
  const newCheck = {
    name: 'New Check',
    command: 'echo new',
    timeout: '1m',
    state: 'passed',
    exitCode: 0,
  }
  const oldProgress = {
    taskId: 'NB-1',
    visit: createdAt,
    checks: [oldCheck, tail],
    next: 2,
    pending: false,
    executions: [
      { runId: 'old-run', start: 0 },
      { runId: 'old-tail', start: 1 },
    ],
  }
  const currentFailure = {
    ...accepted,
    additions: [{ runId: 'new-lead', at: later, evidence: 'Future evidence' }],
    assessments: [
      ...accepted.assessments,
      {
        id: 'new-assessment',
        runId: 'new-lead',
        assessment: 'regression',
        recommendation: 'Future recommendation',
        at: later,
      },
    ],
    resolutions: [
      ...accepted.resolutions,
      {
        requestId: 'future-decision',
        assessmentId: 'new-assessment',
        resolution: 'fixed',
        reason: 'Future decision',
        at: later,
      },
    ],
    invalidations: [{ requestId: 'old-decision', reason: 'Future context', at: later }],
  }
  const old = comment({
    id: 'previous',
    kind: 'signoff',
    stage: 'review',
    gate: { approveLabel: 'Approve' },
    answer: { kind: 'approved', at: createdAt },
  })
  const api = bridge({
    listComments: () => [old],
    listThreadEvents: () => [
      {
        id: 'old-validation',
        taskId: 'NB-1',
        at: createdAt,
        tone: 'done',
        text: 'Validate passed',
        validate: 'passed',
        checkRunId: 'old-tail',
        judgments: [{ name: 'Review', passed: false }],
        validation: { progress: oldProgress, failures: [accepted] },
      },
    ],
    listCheckRuns: () => [
      {
        id: 'old-run',
        taskId: 'NB-1',
        checks: [oldCheck, { ...tail, state: 'not-run' }],
        startedAt: createdAt,
      },
      { id: 'old-tail', taskId: 'NB-1', checks: [tail], startedAt: createdAt },
      { id: 'new-run', taskId: 'NB-1', checks: [newCheck], startedAt: later },
    ],
    listFailures: () => [currentFailure],
    validationObligations: () => ({
      satisfied: true,
      cases: [],
      blockers: [],
      checkRuns: [],
      progress: {
        taskId: 'NB-1',
        visit: later,
        checks: [newCheck],
        next: 1,
        pending: false,
        executions: [{ runId: 'new-run', start: 0 }],
      },
    }),
    checkOutput: () => ({ text: 'Original output', log: 'original-log' }),
    listApps: () => [],
    simulators: () => ({ supported: false }),
    emulators: () => ({ supported: false }),
  })
  render(
    <RequestCard
      task={task()}
      request={comment({
        id: 'current',
        kind: 'signoff',
        stage: 'review',
        createdAt: later,
        gate: { approveLabel: 'Approve', changes: { since: 'previous', repos: [] } },
      })}
    />,
  )
  expect(await screen.findByText('New Check', { exact: false })).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'View previously approved review' }))
  const history = await screen.findByRole('region', { name: 'Sign-off, read-only' })
  await within(history).findByText('Original recommendation')
  expect(history.textContent).toContain('failed, accepted by you')
  expect(history.textContent).toContain('Original decision')
  expect(history.textContent).toContain('Old remaining Check')
  expect(history.textContent).not.toMatch(/New Check|Future|acceptance invalidated/)
  await user().click(within(history).getByTitle('Open Old Check’s output'))
  const output = await screen.findByRole('dialog', { name: 'Old Check output' })
  await within(output).findByText('Original output')
  expect(api.request).toHaveBeenCalledWith('checkOutput', 'old-run', 0)
  expect(output.textContent).toContain('Original recommendation')
  expect(output.textContent).not.toContain('Future')
  await user().click(within(output).getByRole('button', { name: 'Close' }))
  await user().click(within(history).getByTitle('Open Old remaining Check’s output'))
  await screen.findByRole('dialog', { name: 'Old remaining Check output' })
  expect(api.request).toHaveBeenCalledWith('checkOutput', 'old-tail', 0)
})

test('sign-off sections preserve headings inside fenced code and formatted user answers', () => {
  requestApi()
  const request = comment({
    kind: 'signoff',
    stage: 'review',
    gate: { approveLabel: 'Approve' },
    body: '## Goal\n\n**Readable** messages\n\n## Current state\n\n```md\n# This is code\n\n**literal**\n```',
  })
  const view = render(<RequestCard task={task()} request={request} readOnly />)
  expect(screen.getByText('Readable').tagName).toBe('STRONG')
  expect(screen.getByRole('region', { name: 'Code block' }).textContent).toBe(
    '# This is code\n\n**literal**\n',
  )
  expect(screen.queryByRole('heading', { name: 'This is code' })).toBeNull()
  view.rerender(
    <AnsweredCard
      task={task()}
      request={{
        ...request,
        answer: { kind: 'approved', at: createdAt, text: '## Feedback\n\n**Looks good**' },
      }}
    />,
  )
  expect(screen.getByRole('heading', { name: 'Feedback' }).closest('blockquote')).toBeTruthy()
  expect(screen.getByText('Looks good').tagName).toBe('STRONG')
})

test('design summaries and review points use Markdown without changing media controls', () => {
  requestApi()
  render(
    <RequestCard
      task={task()}
      request={comment({
        kind: 'review',
        title: 'Design',
        design: {
          summary: 'A **shared** renderer.',
          worthYourEye: ['Inspect `code` in narrow panels.'],
        },
      })}
      readOnly
    />,
  )
  expect(screen.getByText('shared').tagName).toBe('STRONG')
  expect(screen.getByText('code').tagName).toBe('CODE')
  expect(screen.getByRole('region', { name: 'Worth your eye' })).toBeTruthy()
})

test('keyboard sign-off changes show pending feedback on the matching answer only', async () => {
  const completion = deferred<never>()
  const answer = vi.fn(() => completion.promise)
  bridge({
    simulators: () => ({ supported: false }),
    emulators: () => ({ supported: false }),
    answerRequest: answer,
  })
  render(
    <RequestCard
      task={task()}
      request={comment({ kind: 'review', stage: 'design', gate: { approveLabel: 'Approve' } })}
    />,
  )
  const box = screen.getByRole('textbox', { name: 'Your answer' })
  fireEvent.change(box, { target: { value: 'Keep the pending label stable.' } })
  fireEvent.keyDown(box, { key: 'Enter' })
  const changes = screen.getByRole('button', { name: 'Request changes' })
  expect(changes.getAttribute('aria-busy')).toBe('true')
  expect(screen.getByRole('button', { name: 'Approve' }).getAttribute('aria-busy')).toBeNull()
  fireEvent.keyDown(box, { key: 'Enter' })
  expect(answer).toHaveBeenCalledOnce()
  await act(async () => completion.reject(new Error('Couldn’t send changes')))
  expect(changes.getAttribute('aria-busy')).toBeNull()
  expect(screen.getByRole('alert').textContent).toBe('Couldn’t send changes')
})
