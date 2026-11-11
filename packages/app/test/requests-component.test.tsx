// @vitest-environment jsdom
import type { Round } from '@ted/protocol'
import { act, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
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
  const api = bridge({ simulators: () => ({ supported: false }), answerRequest: answer })
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
  if (answer.kind !== 'withdrawn') expect(screen.getByText('“For this request”')).toBeTruthy()
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
  const props = inboxProps()
  const first = { task: task(), request: comment({ id: 'c1' }) }
  const second = { task: task(), request: comment({ id: 'c2', body: 'Second question?' }) }
  const view = render(<Inbox {...props} items={[first, second]} selected="c1" />)
  view.rerender(<Inbox {...props} items={[second]} selected="c1" />)
  expect(props.onOpen).toHaveBeenCalledWith(second)
  view.rerender(<Inbox {...props} items={[]} selected="c2" />)
  expect(props.onClear).toHaveBeenCalledOnce()
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
  expect(screen.getByText('“I’ll check the empty template next.”')).toBeTruthy()
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
