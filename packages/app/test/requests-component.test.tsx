// @vitest-environment jsdom
import type { TaskMovePlan } from '@ted/protocol'
import { movePlanKey } from '@ted/protocol/task-move'
import { act, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AnsweredCard, RequestCard } from '../src/renderer/components/RequestCard.tsx'
import { bridge, deferred, user } from './support/component.ts'
import { comment, createdAt, factory, task } from './support/fixtures.ts'
import { requestApi } from './support/requests.ts'

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
  expect(within(full).getByRole('radio', { name: 'A hint' }).matches(':disabled')).toBe(true)
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
  bridge({
    simulators: () => ({ supported: false }),
    emulators: () => ({ supported: false }),
    answerRequest: () => pending.promise,
  })
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

test('idle ask shows the reason and sends Restart from the brief', async () => {
  const { answer } = requestApi()
  render(
    <RequestCard
      task={task()}
      request={comment({
        body: 'The fixture has no empty template.\n\nIt stopped again after 3 nudges without asking you anything.',
        choices: ['Nudge again', 'Restart from the brief'],
      })}
    />,
  )
  expect(screen.getByText('The fixture has no empty template.')).toBeTruthy()
  expect(screen.getByRole('radio', { name: 'Nudge again' })).toBeTruthy()
  await user().click(screen.getByRole('radio', { name: 'Restart from the brief' }))
  expect(answer).not.toHaveBeenCalled()
  await user().click(screen.getByRole('button', { name: 'Send' }))
  expect(answer).toHaveBeenCalledWith('c1', { action: 'answer', choice: 'Restart from the brief' })
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

test.each(['working', 'waiting', 'idle', 'paused', 'stopped'] as const)(
  'reply transport stays separate from the Task Lead’s actual %s state',
  async (state) => {
    requestApi()
    const open = vi.fn()
    const current = task({
      stage: 'work',
      leadRunId: 'current-lead',
      runs:
        state === 'stopped'
          ? []
          : [
              {
                id: 'current-lead',
                agent: 'claude',
                role: 'lead',
                name: 'Task Lead',
                state: state === 'paused' ? 'idle' : state,
                ...(state === 'paused' && { paused: 'Usage limit' }),
              },
            ],
    })
    const request = comment({
      author: { kind: 'run', runId: 'previous-lead' },
      purpose: { kind: 'question' },
      answer: { kind: 'answered', at: createdAt, text: 'Why disable tools?' },
      answerDelivery: { queuedAt: createdAt },
    })
    const view = render(<AnsweredCard request={request} task={current} onOpenRun={open} />)
    expect(screen.getByText('You replied in your own words')).toBeTruthy()
    expect(screen.getByText('Waiting to reach Task Lead')).toBeTruthy()
    expect(screen.queryByText('Sent to Task Lead')).toBeNull()
    expect(
      screen.getByText(
        state === 'paused' ? 'Task Lead paused · Usage limit' : `Task Lead ${state}`,
      ),
    ).toBeTruthy()
    await user().click(screen.getByRole('button', { name: 'Open conversation' }))
    expect(open).toHaveBeenCalledWith('current-lead')
    view.rerender(
      <AnsweredCard
        request={{
          ...request,
          answerDelivery: {
            queuedAt: createdAt,
            sent: { runId: 'previous-lead', at: createdAt },
          },
        }}
        task={current}
        onOpenRun={open}
      />,
    )
    expect(screen.getByText('Sent to Task Lead')).toBeTruthy()
    expect(screen.queryByText('Waiting to reach Task Lead')).toBeNull()
    expect(
      screen.getByText(
        state === 'paused' ? 'Task Lead paused · Usage limit' : `Task Lead ${state}`,
      ),
    ).toBeTruthy()
  },
)

test('older replies have no invented sent receipt, and permission cards keep their approval wording', () => {
  requestApi()
  const request = comment({
    author: { kind: 'run', runId: 'lead' },
    answer: { kind: 'answered', at: createdAt, text: 'Why?' },
  })
  const view = render(<AnsweredCard request={request} task={task()} />)
  expect(screen.getByText('Delivery not recorded')).toBeTruthy()
  expect(screen.queryByText('Sent to Task Lead')).toBeNull()
  view.rerender(
    <AnsweredCard
      request={{ ...request, kind: 'permission', answer: { kind: 'approved', at: createdAt } }}
      task={task()}
    />,
  )
  expect(screen.getByText('You approved')).toBeTruthy()
  expect(screen.queryByLabelText('Reply delivery')).toBeNull()
})

test('an archive request presets the pull request choice, sends Keep it with a message and opens the Archive dialog when Tasks are blocked', async () => {
  const { answer, handle } = requestApi()
  const withPr = task({
    repos: [
      {
        name: 'widgets',
        repo: 'acme/widgets',
        branch: 'ted/nb-1-sync-notes',
        worktree: '/tmp/NB-1/widgets',
        copied: [],
        skipped: [],
        pullRequest: {
          number: 212,
          state: 'draft',
          url: 'https://github.com/acme/widgets/pull/212',
          base: 'main',
        },
      } as ReturnType<typeof task>['repos'][number],
    ],
  })
  const request = comment({
    title: 'Archive NB-1?',
    body: 'Duplicate of NB-2',
    author: { kind: 'run', runId: 'r1' },
    choices: ['Archive', 'Keep it'],
    purpose: { kind: 'archive' },
    archive: {
      reason: 'Duplicate of NB-2',
      pullRequests: { recommend: 'keep', why: 'NB-2 reuses the branch' },
    },
  })
  handle('listTasks', () => [withPr])
  const view = render(<RequestCard task={withPr} request={request} />)
  const u = user()
  const close = await screen.findByRole('checkbox', { name: /Close the pull request/ })
  expect((close as HTMLInputElement).checked).toBe(false)
  expect(screen.getByText(/recommends keeping it: NB-2 reuses the branch/)).toBeTruthy()
  await u.click(close)
  await u.click(screen.getByRole('button', { name: 'Archive' }))
  expect(answer).toHaveBeenLastCalledWith('c1', {
    action: 'answer',
    choice: 'Archive',
    archive: { closePullRequests: true },
  })
  await u.type(screen.getByLabelText('Message to the Task Lead'), 'Still needed for NB-3')
  await u.click(screen.getByRole('button', { name: 'Keep it' }))
  expect(answer).toHaveBeenLastCalledWith('c1', {
    action: 'answer',
    choice: 'Keep it',
    text: 'Still needed for NB-3',
  })
  view.unmount()

  const blocked = task({ id: 'NB-3', displayId: 'NB-3', number: 3, blockedBy: ['NB-1'] })
  handle('listTasks', () => [withPr, blocked])
  render(<RequestCard task={withPr} request={request} />)
  expect(await screen.findByRole('region', { name: 'Unblocks 1 Task' })).toBeTruthy()
  expect(
    (screen.getByRole('checkbox', { name: /Close the pull request/ }) as HTMLInputElement).checked,
  ).toBe(false)
  await u.type(screen.getByLabelText('Message to the Task Lead'), 'Merged into NB-2')
  await u.click(screen.getByRole('button', { name: 'Archive' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(answer).toHaveBeenLastCalledWith('c1', {
    action: 'answer',
    choice: 'Archive',
    text: 'Merged into NB-2',
    archive: { closePullRequests: false },
  })
})

test('a move request preselects the suggested Factory, shows its plan and sends Move with that plan', async () => {
  const { answer, handle } = requestApi()
  const website = factory({ id: 'web', key: 'WEB', name: 'Website', position: 1 })
  const mobile = factory({ id: 'mob', key: 'MOB', name: 'Mobile', position: 2 })
  const started = task({ stage: 'work' })
  const plan = (factoryId: string, name: string, refusal?: string): TaskMovePlan => ({
    factoryId,
    factoryName: name,
    repos: [name.toLowerCase()],
    tasks: [
      {
        id: 'NB-1',
        displayId: 'NB-1',
        title: started.title,
        newDisplayId: `${name.slice(0, 3).toUpperCase()}-7`,
        stage: 'work',
        lands: 'intake',
        startsLead: true,
        worktrees: 1,
        branches: ['ted/nb-1-sync-notes'],
        pullRequests: [],
        openRequests: 0,
        unlinked: [],
      },
    ],
    ...(refusal !== undefined && { refusal }),
  })
  handle('listTasks', () => [started])
  handle('listFactories', () => [factory(), website, mobile])
  handle('taskMovePlan', (...args) =>
    args[1] === 'mob'
      ? plan('mob', 'Mobile', 'NB-1 has a merged pull request, so it can’t move')
      : plan('web', 'Website'),
  )
  const request = comment({
    title: 'Move NB-1 to Website?',
    body: 'The pricing page is in Website’s repo',
    author: { kind: 'run', runId: 'r1' },
    choices: ['Move', 'Keep it'],
    purpose: { kind: 'move' },
    move: {
      factoryId: 'web',
      reason: 'The pricing page is in Website’s repo',
      askedBy: 'task-lead',
    },
  })
  render(<RequestCard task={started} request={request} />)
  const u = user()
  expect((await screen.findByText(/^NB-1 becomes/)).textContent).toBe(
    'NB-1 becomes WEB-7 in Intake. A new Task Lead starts there at once, with a copy of the conversation so far.',
  )
  expect(screen.getByRole('region', { name: 'What is lost' })).toBeTruthy()
  await u.type(screen.getByLabelText('Message to the Task Lead'), 'Go ahead')
  await u.click(screen.getByRole('button', { name: 'Move to Website' }))
  expect(answer).toHaveBeenLastCalledWith('c1', {
    action: 'answer',
    choice: 'Move',
    text: 'Go ahead',
    move: { factoryId: 'web', planKey: movePlanKey(plan('web', 'Website')) },
  })

  await u.click(screen.getByRole('combobox', { name: 'Factory' }))
  await u.click(screen.getByRole('option', { name: 'Mobile' }))
  expect((await screen.findByRole('alert')).textContent).toBe(
    'NB-1 has a merged pull request, so it can’t move',
  )
  expect(screen.getByText('Suggested by the Task Lead: Website.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Move to Mobile' }).hasAttribute('disabled')).toBe(true)
  await u.click(screen.getByRole('button', { name: 'Keep it' }))
  expect(answer).toHaveBeenLastCalledWith('c1', { action: 'answer', choice: 'Keep it' })
})
