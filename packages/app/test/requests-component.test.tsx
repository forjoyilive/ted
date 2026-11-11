// @vitest-environment jsdom
import type { AutomationRequest, FailureCase, PlanInboxItem, Round } from '@ted/protocol'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { FailureDetails } from '../src/renderer/components/FailureDetails.tsx'
import { AnsweredCard, RequestCard } from '../src/renderer/components/RequestCard.tsx'
import { Inbox } from '../src/renderer/views/Inbox.tsx'
import { appState } from './support/app.tsx'
import { bridge, deferred, user } from './support/component.ts'
import { comment, createdAt, factory, task } from './support/fixtures.ts'

const round: Round = {
  number: 1,
  questions: [
    {
      question: 'When edits conflict?',
      choices: ['Keep both', 'Keep latest'],
      recommended: 'Keep both',
    },
    { question: 'Which wins?', recommended: 'The edit wins.' },
  ],
}

function requestApi() {
  const answer = vi.fn(() => comment())
  const api = bridge({
    listThreadEvents: () => [],
    listCheckRuns: () => [],
    listFailures: () => [],
    validationObligations: () => ({
      satisfied: true,
      cases: [],
      checkRuns: [],
      blockers: [],
    }),
    listApps: () => [],
    simulators: () => ({ supported: false }),
    answerRequest: answer,
  })
  return { ...api, answer }
}

test('rounds submit preselected recommendations with one submission action', async () => {
  const { answer } = requestApi()
  render(
    <RequestCard request={comment({ kind: 'round', round })} task={task()} onOpenRun={vi.fn()} />,
  )
  expect(screen.queryByRole('button', { name: 'Accept all recommended' })).toBeNull()
  await user().click(screen.getByRole('button', { name: 'Submit answers' }))
  expect(answer).toHaveBeenCalledWith('c1', {
    action: 'answer-round',
    answers: [{ answer: 'Keep both' }, { answer: 'The edit wins.' }],
  })
})

test('Submit answers preserves changed choices, written answers and added notes', async () => {
  const { answer } = requestApi()
  render(
    <RequestCard request={comment({ kind: 'round', round })} task={task()} onOpenRun={vi.fn()} />,
  )
  const u = user()
  await u.click(screen.getByRole('radio', { name: 'Keep latest' }))
  await u.type(screen.getByLabelText('Add to answer 1'), 'Clashes are rare.')
  await u.clear(screen.getByLabelText('Answer 2'))
  await u.type(screen.getByLabelText('Answer 2'), 'Keep both versions.')
  await u.click(screen.getByRole('button', { name: 'Submit answers' }))
  expect(answer).toHaveBeenCalledWith('c1', {
    action: 'answer-round',
    answers: [
      { answer: 'Keep latest', note: 'Clashes are rare.' },
      { answer: 'Keep both versions.' },
    ],
  })
})

test('round recommendations, reset, Other validation and notes are sent as answers', async () => {
  const { answer } = requestApi()
  render(
    <RequestCard request={comment({ kind: 'round', round })} task={task()} onOpenRun={vi.fn()} />,
  )
  const u = user()
  expect(screen.getAllByText('Recommended')).toHaveLength(2)
  const first = screen.getByRole('group', { name: /When edits conflict/ })
  const f = within(first)
  expect((f.getByRole('radio', { name: /Keep both/ }) as HTMLInputElement).checked).toBe(true)
  await u.click(f.getByText('Keep latest'))
  expect(f.getByText('Changed ·')).toBeTruthy()
  await u.click(f.getByRole('button', { name: 'Reset' }))
  expect(f.queryByText('Changed ·')).toBeNull()
  await u.click(f.getByText('Keep latest'))
  await u.type(f.getByLabelText('Add to answer 1'), 'Clashes are rare.')
  await u.click(f.getByRole('radio', { name: 'Other' }))
  const submit = screen.getByRole('button', { name: 'Submit answers' }) as HTMLButtonElement
  expect(submit.disabled).toBe(true)
  await u.type(f.getByLabelText('Your answer 1'), '   ')
  expect(submit.disabled).toBe(true)
  await u.clear(f.getByLabelText('Your answer 1'))
  await u.type(f.getByLabelText('Your answer 1'), 'Ask me to resolve each conflict.')
  await u.click(f.getByRole('button', { name: 'Reset' }))
  expect((f.getByRole('radio', { name: /Keep both/ }) as HTMLInputElement).checked).toBe(true)
  await u.click(f.getByText('Keep latest'))
  expect((f.getByLabelText('Add to answer 1') as HTMLInputElement).value).toBe('Clashes are rare.')
  await u.click(f.getByRole('radio', { name: 'Other' }))
  expect((f.getByLabelText('Your answer 1') as HTMLInputElement).value).toBe(
    'Ask me to resolve each conflict.',
  )
  await u.click(submit)
  expect(answer).toHaveBeenCalledWith('c1', {
    action: 'answer-round',
    answers: [{ answer: 'Ask me to resolve each conflict.' }, { answer: 'The edit wins.' }],
  })
})

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

test('answered and superseded cards expand read-only and never send again', async () => {
  const { answer } = requestApi()
  const request = comment({
    choices: ['Recent notes', 'A hint'],
    answer: { kind: 'answered', at: createdAt, choice: 'Recent notes' },
  })
  const view = render(<AnsweredCard task={task()} request={request} />)
  expect(screen.getByText('You answered: Recent notes')).toBeTruthy()
  const u = user()
  await u.click(screen.getByRole('button', { name: 'Show request' }))
  const full = screen.getByRole('region', { name: 'Question, read-only' })
  expect(within(full).queryByRole('textbox')).toBeNull()
  expect((within(full).getByRole('button', { name: 'A hint' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  await u.click(screen.getByRole('button', { name: 'Hide request' }))
  expect(screen.queryByRole('region', { name: 'Question, read-only' })).toBeNull()
  view.rerender(
    <AnsweredCard
      task={task({ leadRunId: 'lead' })}
      request={comment({
        author: { kind: 'run', runId: 'lead' },
        answer: { kind: 'superseded', at: createdAt, by: 'c2' },
      })}
      newer={comment({ author: { kind: 'run', runId: 'lead' } })}
    />,
  )
  expect(screen.getByText('Superseded by a newer question from the Task Lead')).toBeTruthy()
  expect(answer).not.toHaveBeenCalled()
})

test.each([
  { kind: 'approved', at: createdAt, text: 'For this request' },
  { kind: 'denied', at: createdAt, text: 'For this request' },
  { kind: 'withdrawn', at: createdAt, runStopped: true },
] as const)('resolved permissions retain their full request: $kind', (answer) => {
  const api = requestApi()
  const request = comment({
    kind: 'permission',
    title: 'Run a command',
    body: 'Install the CRDT library',
    permission: {
      command: 'npm install --save yjs@13.6.27',
      repo: 'ted',
      details: 'Network access is required.\nWrites package.json and pnpm-lock.yaml.',
    },
  })
  const view = render(<RequestCard task={task()} request={request} />)
  expect(screen.getByText('Install the CRDT library')).toBeTruthy()
  view.rerender(<AnsweredCard task={task()} request={{ ...request, answer }} />)
  expect(screen.getByRole('heading', { name: 'Run a command' })).toBeTruthy()
  expect(screen.getByText('Install the CRDT library')).toBeTruthy()
  expect(screen.getAllByText(/npm install --save yjs@13\.6\.27/)).toHaveLength(1)
  expect(screen.getByText('ted $')).toBeTruthy()
  expect(screen.getByText(/Network access is required/).textContent).toBe(
    request.permission?.details,
  )
  expect(screen.getAllByText('Permission')).toHaveLength(1)
  expect(screen.queryByRole('button', { name: /Show request|Hide request/ })).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('button', { name: /Approve|Deny/ })).toBeNull()
  expect(
    screen.getByText(
      answer.kind === 'approved'
        ? 'You approved · this request only'
        : answer.kind === 'denied'
          ? 'You denied'
          : /Run stopped before you answered/,
    ),
  ).toBeTruthy()
  if (answer.kind !== 'withdrawn') expect(screen.getByText('For this request')).toBeTruthy()
  view.rerender(<AnsweredCard task={task()} request={{ ...request, answer }} expanded />)
  expect(screen.getAllByText(/npm install --save yjs@13\.6\.27/)).toHaveLength(1)
  expect(api.answer).not.toHaveBeenCalled()
})

test.each([
  [
    'Finish the current Stage and move the Task on.',
    'Finish the current Stage and move the Task on.',
  ],
  ['', 'The agent didn’t provide an explanation for this request.'],
  [' \n\t ', 'The agent didn’t provide an explanation for this request.'],
])('permission card explains a request with body %j', (body, explanation) => {
  requestApi()
  const view = render(
    <RequestCard
      task={task()}
      request={comment({
        kind: 'permission',
        title: 'Run a command',
        body,
        permission: { command: '/tmp/ted-run-c58cea04.sh outcome advance', repo: 'ted' },
      })}
    />,
  )
  expect(screen.getByText(explanation)).toBeTruthy()
  expect(screen.getByText(/\/tmp\/ted-run-c58cea04.sh outcome advance/).textContent).toBe(
    'ted $ /tmp/ted-run-c58cea04.sh outcome advance',
  )
  expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy()
  view.rerender(
    <AnsweredCard
      task={task()}
      request={comment({
        kind: 'permission',
        title: 'Run a command',
        body,
        permission: { command: '/tmp/ted-run-c58cea04.sh outcome advance', repo: 'ted' },
        answer: { kind: 'approved', at: createdAt },
      })}
    />,
  )
  expect(screen.getByText(explanation)).toBeTruthy()
})

test.each(['approve', 'deny'] as const)(
  'permission card sends %s with command and optional comment',
  async (action) => {
    const { answer } = requestApi()
    render(
      <RequestCard
        task={task()}
        request={comment({ kind: 'permission', permission: { command: 'npm install' } })}
      />,
    )
    expect(screen.getByText('npm install')).toBeTruthy()
    await user().type(screen.getByLabelText('Your answer'), 'For this request')
    await user().click(
      screen.getByRole('button', { name: action === 'approve' ? 'Approve' : 'Deny' }),
    )
    expect(answer).toHaveBeenCalledWith('c1', { action, text: 'For this request' })
  },
)

test('pending answers disable actions and rejected answers preserve text with an error', async () => {
  const pending = deferred<never>()
  bridge({ simulators: () => ({ supported: false }), answerRequest: () => pending.promise })
  render(<RequestCard task={task()} request={comment()} />)
  const u = user()
  await u.type(screen.getByLabelText('Your answer'), 'Keep this answer')
  await u.click(screen.getByRole('button', { name: 'Send' }))
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => pending.reject(new Error('Couldn’t answer')))
  expect(screen.getByRole('alert').textContent).toBe('Couldn’t answer')
  expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe(
    'Keep this answer',
  )
})

test('a failure decision asks for a reason before Fixed or No longer applicable and shows only the daemon’s refusal', async () => {
  const refusal =
    'The Task’s code or Checks changed since this failure was assessed, so it can’t be accepted as it is. Ask the Task Lead to assess it again.'
  const answer = vi.fn((_id: unknown, request: unknown) => {
    if ((request as { choice?: string }).choice === 'Accept this failure')
      throw new Error(`Error invoking remote method 'ted:request': Error: ${refusal}`)
    return comment()
  })
  bridge({
    simulators: () => ({ supported: false }),
    answerRequest: answer,
    listFailures: () => [],
  })
  render(
    <RequestCard
      task={task()}
      request={comment({
        kind: 'question',
        author: { kind: 'ted' },
        choices: ['Accept this failure', 'Fixed', 'No longer applicable'],
      })}
    />,
  )
  const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
  expect(button('Accept this failure').disabled).toBe(false)
  expect(button('Fixed').disabled).toBe(true)
  expect(button('No longer applicable').disabled).toBe(true)
  expect(button('Fixed').title).toBe('Write your reason below first')
  expect(
    screen.getByPlaceholderText('Your reason. Fixed and No longer applicable need one…'),
  ).toBeTruthy()
  const u = user()
  await u.click(button('Accept this failure'))
  expect((await screen.findByRole('alert')).textContent).toBe(refusal)
  await u.type(screen.getByLabelText('Your answer'), 'A rerun passed.')
  expect(button('No longer applicable').disabled).toBe(false)
  await u.click(button('Fixed'))
  expect(answer).toHaveBeenLastCalledWith('c1', {
    action: 'answer',
    choice: 'Fixed',
    text: 'A rerun passed.',
  })
})

function inboxProps() {
  return {
    items: [],
    answered: [],
    factories: [factory()],
    factoryId: undefined,
    showAnswered: false,
    anyTasks: false,
    selected: undefined,
    onOpen: vi.fn(),
    onClear: vi.fn(),
    onFilter: vi.fn(),
    onShowAnswered: vi.fn(),
    onNewTask: vi.fn(),
  }
}

test('empty Inbox offers New Task, Show answered, and a Factory-filter reset', async () => {
  requestApi()
  const props = inboxProps()
  const view = render(<Inbox {...props} />)
  await user().click(screen.getByRole('button', { name: 'New Task' }))
  expect(props.onNewTask).toHaveBeenCalledOnce()
  view.rerender(<Inbox {...props} anyTasks />)
  await user().click(screen.getByRole('button', { name: 'Show answered' }))
  expect(props.onShowAnswered).toHaveBeenCalledWith(true)
  view.rerender(<Inbox {...props} factoryId="f1" />)
  expect(screen.getByText(/widgets/)).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Show all Factories' }))
  expect(props.onFilter).toHaveBeenCalledWith(undefined)
})

test('resolving a selected request opens the next request and clears when none remain', () => {
  requestApi()
  const props = inboxProps()
  const first = { task: task(), request: comment({ id: 'c1' }) }
  const second = { task: task(), request: comment({ id: 'c2', body: 'Second question?' }) }
  const view = render(<Inbox {...props} items={[first, second]} selected="c1" />)
  view.rerender(<Inbox {...props} items={[second]} selected="c1" />)
  expect(props.onOpen).toHaveBeenCalledWith(second)
  view.rerender(<Inbox {...props} items={[]} selected="c2" />)
  expect(props.onClear).toHaveBeenCalledOnce()
})

test('Inbox interleaves request types newest first, filters without reordering, and selects the next visible row', async () => {
  const props = inboxProps()
  const onOpenPlan = vi.fn()
  const onOpenQuestion = vi.fn()
  const old = {
    task: task({ priority: 'urgent' }),
    request: comment({ id: 'old', body: 'Old urgent request', createdAt: '2026-11-09T10:00:00Z' }),
  }
  const recent = {
    task: task({ priority: 'low' }),
    request: comment({ id: 'recent', body: 'Recent request', createdAt: '2026-11-09T13:00:00Z' }),
  }
  const plan: PlanInboxItem = {
    plan: {
      id: 'p1',
      factoryId: 'f1',
      factoryKey: 'NB',
      title: 'Planning chat',
      message: '',
      agent: 'codex',
      status: 'working',
      createdTasks: 0,
      createdAt,
    },
    request: {
      id: 'plan',
      planId: 'p1',
      runId: 'r1',
      kind: 'round',
      author: 'run',
      title: 'Plan request',
      body: '',
      createdAt: '2026-11-09T12:00:00Z',
    },
  }
  const question: AutomationRequest = {
    id: 'auto',
    automationId: 'a1',
    automationName: 'Automation',
    factoryId: 'f2',
    runId: 'r2',
    kind: 'question',
    body: 'Automation request',
    createdAt: '2026-11-09T11:00:00Z',
  }
  const all = {
    ...props,
    items: [old, recent],
    plans: [plan],
    questions: [question],
    factories: [factory(), factory({ id: 'f2', name: 'Other' })],
    onOpenPlan,
    onOpenQuestion,
  }
  const view = render(<Inbox {...all} selected="recent" />)
  const headlines = () =>
    [...view.container.querySelectorAll('[data-headline]')].map((el) => el.textContent)
  expect(headlines()).toEqual([
    'Recent request',
    'Plan request',
    'Automation request',
    'Old urgent request',
  ])
  await user().click(screen.getByText('Plan request', { exact: true }))
  expect(onOpenPlan).toHaveBeenCalledWith(plan)
  await user().click(screen.getByText('Automation request', { exact: true }))
  expect(onOpenQuestion).toHaveBeenCalledWith(question)

  view.rerender(<Inbox {...all} factoryId="f1" selected="recent" />)
  expect(headlines()).toEqual(['Recent request', 'Plan request', 'Old urgent request'])
  onOpenPlan.mockClear()
  view.rerender(<Inbox {...all} factoryId="f1" items={[old]} selected="recent" />)
  expect(onOpenPlan).toHaveBeenCalledWith(plan)

  const newest = {
    ...recent,
    request: comment({ id: 'new', body: 'New request', createdAt: '2026-11-09T14:00:00Z' }),
  }
  props.onOpen.mockClear()
  onOpenPlan.mockClear()
  view.rerender(<Inbox {...all} items={[old, newest]} selected="plan" />)
  expect(headlines()).toEqual([
    'New request',
    'Plan request',
    'Automation request',
    'Old urgent request',
  ])
  expect(props.onOpen).not.toHaveBeenCalled()
  expect(onOpenPlan).not.toHaveBeenCalled()
  expect(screen.getByText('Plan request').closest('button')?.getAttribute('aria-current')).toBe(
    'true',
  )
})

test('Inbox equal timestamps keep a consistent order and Answered keeps answer-time order', () => {
  const props = inboxProps()
  const a = { task: task(), request: comment({ id: 'a', body: 'First', createdAt }) }
  const b = { task: task(), request: comment({ id: 'b', body: 'Second', createdAt }) }
  const view = render(<Inbox {...props} items={[b, a]} />)
  const headlines = () =>
    [...view.container.querySelectorAll('[data-headline]')].map((el) => el.textContent)
  expect(headlines()).toEqual(['First', 'Second'])
  view.rerender(<Inbox {...props} items={[a, b]} />)
  expect(headlines()).toEqual(['First', 'Second'])
  view.rerender(
    <Inbox
      {...props}
      showAnswered
      answered={[
        {
          ...a,
          request: { ...a.request, answer: { kind: 'answered', at: '2026-11-09T14:00:00Z' } },
        },
        {
          ...b,
          request: {
            ...b.request,
            createdAt: '2026-11-09T13:00:00Z',
            answer: { kind: 'answered', at: '2026-11-09T13:30:00Z' },
          },
        },
      ]}
    />,
  )
  expect(headlines()).toEqual(['First', 'Second'])
})

test('answered rounds distinguish recommended and changed responses', () => {
  requestApi()
  render(
    <AnsweredCard
      task={task()}
      request={comment({
        kind: 'round',
        round,
        answer: {
          kind: 'answered',
          at: createdAt,
          answers: [
            { answer: 'Ask me.', changed: true },
            { answer: 'The edit wins.', changed: false },
          ],
        },
      })}
    />,
  )
  expect(screen.getByText('You answered · 1 recommended, 1 changed')).toBeTruthy()
  expect(screen.getAllByRole('listitem').map((e) => e.textContent)).toEqual([
    '1.Ask me.changed',
    '2.The edit wins.recommended',
  ])
})

test('idle ask quotes the last response and sends Nudge again', async () => {
  const { answer } = requestApi()
  render(
    <RequestCard
      task={task()}
      request={comment({
        body: 'The Task Lead stopped without saying why\n\n> I’ll check the empty template next.',
        choices: ['Nudge again'],
      })}
    />,
  )
  expect(screen.getByText('The Task Lead stopped without saying why')).toBeTruthy()
  expect(screen.getByText('I’ll check the empty template next.')).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Nudge again' }))
  expect(answer).toHaveBeenCalledWith('c1', { action: 'answer', choice: 'Nudge again' })
})

test('empty Inbox opens New Task and Show answered opens the empty Answered view', async () => {
  const a = appState()
  a.mount()
  const inbox = await screen.findByRole('region', { name: 'Inbox' })
  await user().click(within(inbox).getByRole('button', { name: 'New Task' }))
  const dialog = await screen.findByRole('dialog', { name: 'New Task' })
  await user().click(within(dialog).getByRole('button', { name: 'Close' }))
  await a.emitTask(task())
  await user().click(within(inbox).getByRole('button', { name: 'Show answered' }))
  expect(within(inbox).getByText('Nothing answered in the last 30 days')).toBeTruthy()
})

test('Validate failure decisions display evidence and send the selected action', async () => {
  const { answer, handle } = requestApi()
  handle('listFailures', () => [
    {
      id: 'failure-1',
      taskId: 'NB-1',
      validation: true,
      source: { kind: 'finding', runId: 'run-1', finding: 'Visual failure' },
      recordedBy: 'run-1',
      provenance: 'task-lead-reported',
      evidence: 'Reproduced before the changed code executes.',
      createdAt,
      contextId: 'context-1',
      additions: [],
      invalidations: [],
      resolutions: [],
      assessments: [
        {
          id: 'assessment-1',
          runId: 'run-1',
          at: createdAt,
          assessment: 'uncertain',
          recommendation: 'Retry the identified verification.',
        },
      ],
      decisions: [{ commentId: 'request-1', assessmentId: 'assessment-1' }],
    },
  ])
  render(
    <RequestCard
      request={comment({
        id: 'request-1',
        kind: 'question',
        choices: ['Retry', 'Fix in this Task', 'Accept this failure'],
      })}
      task={task()}
    />,
  )
  await screen.findByText('Reproduced before the changed code executes.')
  expect(screen.getByText('Visual failure')).toBeTruthy()
  expect(screen.getByText('The cause isn’t known')).toBeTruthy()
  expect(screen.getByText('Retry the identified verification.')).toBeTruthy()
  expect(screen.getByText(/Accepting covers only this failure/)).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Accept this failure' }))
  expect(answer).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ action: 'answer', choice: 'Accept this failure' }),
  )
  cleanup()
  render(
    <RequestCard
      request={comment({
        id: 'request-1',
        kind: 'question',
        choices: ['Retry', 'Fix in this Task'],
      })}
      task={task()}
    />,
  )
  expect(await screen.findByText(/This failure can’t be accepted/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Accept this failure' })).toBeNull()
})

test('historical failure request keeps its own assessment and decision', async () => {
  bridge({
    simulators: () => ({ supported: false }),
    listFailures: () => [
      {
        id: 'failure-1',
        taskId: 'NB-1',
        validation: true,
        source: { kind: 'finding', runId: 'run-1', finding: 'Original Finding' },
        recordedBy: 'run-1',
        provenance: 'task-lead-reported',
        evidence: 'Original evidence',
        createdAt,
        additions: [],
        invalidations: [],
        assessments: [
          {
            id: 'assessment-1',
            runId: 'run-1',
            at: createdAt,
            assessment: 'uncertain',
            recommendation: 'Retry verification',
          },
          {
            id: 'assessment-2',
            runId: 'run-1',
            at: createdAt,
            assessment: 'unrelated',
            recommendation: 'Accept this execution',
          },
        ],
        decisions: [
          { commentId: 'request-1', assessmentId: 'assessment-1' },
          { commentId: 'request-2', assessmentId: 'assessment-2' },
        ],
        resolutions: [
          {
            requestId: 'request-1',
            assessmentId: 'assessment-1',
            resolution: 'retry',
            at: createdAt,
          },
          {
            requestId: 'request-2',
            assessmentId: 'assessment-2',
            resolution: 'accepted',
            at: createdAt,
          },
        ],
      },
    ],
  })
  render(
    <AnsweredCard
      task={task()}
      expanded
      request={comment({
        id: 'request-1',
        kind: 'question',
        choices: ['Retry', 'Fix in this Task', 'Accept this failure'],
        answer: { kind: 'answered', at: createdAt, choice: 'Retry' },
      })}
    />,
  )
  await screen.findByText('Original Finding')
  expect(screen.queryByText(/Human decision: accepted/)).toBeNull()
  expect(screen.getByText(/Human decision: retry/)).toBeTruthy()
  expect(screen.getByText('The cause isn’t known')).toBeTruthy()
})

test('a Review confirmation shows completed Checks once when progress is available', async () => {
  const check = { name: 'Typecheck', command: 'echo typed', timeout: '1m', state: 'passed' }
  bridge({
    simulators: () => ({ supported: false }),
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

test('an obsolete Check repair does not claim a later execution', () => {
  const value: FailureCase = {
    id: 'obsolete',
    taskId: 'fixture',
    source: { kind: 'factory-check', checkRunId: 'failed-run', position: 0 },
    recordedBy: 'lead',
    provenance: 'stored-check',
    evidence: 'The original Check failed.',
    createdAt: '2026-01-01T00:00:00Z',
    validation: true,
    assessments: [],
    additions: [],
    decisions: [],
    resolutions: [],
    invalidations: [],
    verifications: [
      {
        at: '2026-01-02T00:00:00Z',
        evidence:
          'Task Lead reported repair against a fresh Validate visit. Current Checks: (empty plan). Original execution remains failed.',
      },
    ],
  }
  render(<FailureDetails failure={value} />)
  expect(screen.queryByText(/verified by a later execution/)).toBeNull()
  expect(screen.getByText(/verified with recorded evidence/)).toBeTruthy()
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

test('request bodies and expanded answered history share nested Markdown formatting', async () => {
  requestApi()
  const request = comment({
    title: 'Choose the rollout',
    body: '## Rollout\n\n- **First**\n  - Nested\n\n```sh\necho one\n\necho two\n```',
    choices: ['Proceed'],
  })
  const view = render(<RequestCard task={task()} request={request} />)
  expect(screen.getByRole('heading', { name: 'Rollout' })).toBeTruthy()
  expect(screen.getByText('First').tagName).toBe('STRONG')
  expect(screen.getByText('Nested').closest('ul')?.parentElement?.tagName).toBe('LI')
  expect(screen.getByRole('region', { name: 'Code block' }).textContent).toBe(
    'echo one\n\necho two\n',
  )
  view.rerender(
    <AnsweredCard
      task={task()}
      request={{ ...request, answer: { kind: 'answered', at: createdAt, choice: 'Proceed' } }}
    />,
  )
  await user().click(screen.getByRole('button', { name: 'Show request' }))
  expect(screen.getByRole('heading', { name: 'Rollout' })).toBeTruthy()
  expect(screen.getByText('First').tagName).toBe('STRONG')
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
