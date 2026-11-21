// @vitest-environment jsdom
import type { Round } from '@ted/protocol'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { AnsweredCard, RequestCard } from '../src/renderer/components/RequestCard.tsx'
import { writtenText } from '../src/renderer/components/RoundCard.tsx'
import { deferred, user } from './support/component.ts'
import { comment, createdAt, task } from './support/fixtures.ts'
import { requestApi } from './support/requests.ts'

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

test('rounds require explicit choices and keep written recommendations prefilled', async () => {
  const { answer } = requestApi()
  const questions = [
    ...round.questions,
    {
      question: 'When to sync?',
      choices: ['Now', 'Later\n\nAfter the next app start.'],
      recommended: 'Now',
    },
  ]
  render(
    <RequestCard
      request={comment({ kind: 'round', round: { ...round, questions } })}
      task={task()}
      onOpenRun={vi.fn()}
    />,
  )
  expect(screen.queryByRole('button', { name: 'Accept all recommended' })).toBeNull()
  for (const radio of screen.getAllByRole('radio'))
    expect((radio as HTMLInputElement).checked).toBe(false)
  expect((screen.getByLabelText('Answer 2') as HTMLTextAreaElement).value).toBe('The edit wins.')
  const submit = screen.getByRole('button', { name: 'Submit answers' }) as HTMLButtonElement
  expect(submit.disabled).toBe(true)
  const u = user()
  await u.type(screen.getByLabelText('Add to answer 1'), 'Clashes are rare.')
  await u.click(submit)
  expect(answer).not.toHaveBeenCalled()
  expect(submit.disabled).toBe(true)
  await u.click(screen.getByRole('radio', { name: /Keep both/ }))
  expect(submit.disabled).toBe(true)
  const detail = screen.getByText('After the next app start.')
  expect(detail.textContent).toBe('\nAfter the next app start.')
  expect(screen.getByText('Later').className).not.toBe(detail.className)
  await u.click(screen.getByRole('radio', { name: /^Later/ }))
  expect(submit.disabled).toBe(false)
  await u.click(submit)
  expect(answer).toHaveBeenCalledWith('c1', {
    action: 'answer-round',
    answers: [
      { answer: 'Keep both', note: 'Clashes are rare.' },
      { answer: 'The edit wins.' },
      { answer: 'Later\n\nAfter the next app start.' },
    ],
  })
})

test('⌘↵ from anywhere in a round, its buttons included, submits changed choices, written answers and added notes', async () => {
  const api = requestApi()
  const { answer } = api
  const talk = vi.fn()
  api.handle('talkThrough', talk)
  render(
    <RequestCard request={comment({ kind: 'round', round })} task={task()} onOpenRun={vi.fn()} />,
  )
  const u = user()
  await u.click(screen.getByRole('radio', { name: 'Keep latest' }))
  await u.type(screen.getByLabelText('Add to answer 1'), 'Clashes are rare.')
  await u.clear(screen.getByLabelText('Answer 2'))
  await u.type(screen.getByLabelText('Answer 2'), 'Keep both versions.')
  expect(
    screen.getByRole('button', { name: 'Submit answers' }).querySelector('kbd')?.textContent,
  ).toBe('⌘↵')
  screen.getByRole('button', { name: 'Talk it through' }).focus()
  await u.keyboard('{Meta>}{Enter}{/Meta}')
  expect(talk).not.toHaveBeenCalled()
  expect(answer).toHaveBeenCalledWith('c1', {
    action: 'answer-round',
    answers: [
      { answer: 'Keep latest', note: 'Clashes are rare.' },
      { answer: 'Keep both versions.' },
    ],
  })
})

test('chat edits synchronize with the still-mounted thread before submission', async () => {
  const { answer } = requestApi()
  const request = comment({ kind: 'round', round })
  const props = { request, task: task() }
  const cards = (talking: boolean) => (
    <div>
      <div data-testid="thread" hidden={talking}>
        <RequestCard {...props} active={!talking} />
      </div>
      <div data-testid="chat">{talking && <RequestCard {...props} />}</div>
    </div>
  )
  const view = render(cards(false))
  const u = user()
  await u.click(screen.getByRole('radio', { name: 'Keep latest' }))
  await u.type(screen.getByLabelText('Add to answer 1'), 'Thread note.')
  view.rerender(cards(true))
  const chat = within(screen.getByTestId('chat'))
  await u.click(chat.getByRole('radio', { name: /Keep both/ }))
  await u.clear(chat.getByLabelText('Add to answer 1'))
  await u.type(chat.getByLabelText('Add to answer 1'), 'Agreed in chat.')
  await u.clear(chat.getByLabelText('Answer 2'))
  await u.type(chat.getByLabelText('Answer 2'), 'Keep every edit.')
  view.rerender(cards(false))
  expect((screen.getByRole('radio', { name: /Keep both/ }) as HTMLInputElement).checked).toBe(true)
  expect((screen.getByLabelText('Add to answer 1') as HTMLInputElement).value).toBe(
    'Agreed in chat.',
  )
  await u.click(screen.getByRole('button', { name: 'Submit answers' }))
  expect(answer).toHaveBeenCalledWith('c1', {
    action: 'answer-round',
    answers: [{ answer: 'Keep both', note: 'Agreed in chat.' }, { answer: 'Keep every edit.' }],
  })
})

test('round recommendations, written-answer reset, Other validation and notes are sent as answers', async () => {
  const { answer } = requestApi()
  render(
    <RequestCard request={comment({ kind: 'round', round })} task={task()} onOpenRun={vi.fn()} />,
  )
  const u = user()
  expect(screen.getAllByText('Recommended')).toHaveLength(2)
  const first = screen.getByRole('group', { name: /When edits conflict/ })
  const f = within(first)
  expect((f.getByRole('radio', { name: /Keep both/ }) as HTMLInputElement).checked).toBe(false)
  await u.click(f.getByText('Keep latest'))
  expect(f.queryByText('Changed ·')).toBeNull()
  expect(screen.getAllByText('Recommended')).toHaveLength(2)
  await u.type(f.getByLabelText('Add to answer 1'), 'Clashes are rare.')
  await u.click(f.getByRole('radio', { name: 'Other' }))
  const submit = screen.getByRole('button', { name: 'Submit answers' }) as HTMLButtonElement
  expect((f.getByLabelText('Your answer 1') as HTMLInputElement).value).toBe('Clashes are rare.')
  expect(submit.disabled).toBe(false)
  await u.clear(f.getByLabelText('Your answer 1'))
  expect(submit.disabled).toBe(true)
  await u.type(f.getByLabelText('Your answer 1'), '   ')
  expect(submit.disabled).toBe(true)
  await u.clear(f.getByLabelText('Your answer 1'))
  await u.type(f.getByLabelText('Your answer 1'), 'Ask me to resolve each conflict.')
  await u.click(f.getByText('Keep latest'))
  expect((f.getByLabelText('Add to answer 1') as HTMLInputElement).value).toBe(
    'Ask me to resolve each conflict.',
  )
  await u.click(f.getByRole('radio', { name: 'Other' }))
  expect((f.getByLabelText('Your answer 1') as HTMLInputElement).value).toBe(
    'Ask me to resolve each conflict.',
  )
  expect(f.queryByText('Changed ·')).toBeNull()
  const second = within(screen.getByRole('group', { name: /Which wins/ }))
  await u.type(second.getByLabelText('Answer 2'), ' Mostly.')
  expect(second.getByText('Changed ·')).toBeTruthy()
  await u.click(second.getByRole('button', { name: 'Reset' }))
  expect((second.getByLabelText('Answer 2') as HTMLTextAreaElement).value).toBe('The edit wins.')
  expect(second.getByText('Recommended')).toBeTruthy()
  await u.click(submit)
  expect(answer).toHaveBeenCalledWith('c1', {
    action: 'answer-round',
    answers: [{ answer: 'Ask me to resolve each conflict.' }, { answer: 'The edit wins.' }],
  })
})

test('a round question that allows several answers sends every ticked choice', async () => {
  const { answer } = requestApi()
  const several: Round = {
    number: 1,
    questions: [
      {
        question: 'Which views?',
        choices: ['Board', 'List', 'Map\nPins Tasks on a map.'],
        recommended: 'Board; Map',
        multiple: true,
        recommendedChoices: ['Board', 'Map\nPins Tasks on a map.'],
      },
    ],
  }
  render(
    <RequestCard
      request={comment({ kind: 'round', round: several })}
      task={task()}
      onOpenRun={vi.fn()}
    />,
  )
  const u = user()
  const f = within(screen.getByRole('group', { name: /Which views/ }))
  expect(f.getByText('Pick any that apply.').parentElement?.firstElementChild?.textContent).toBe(
    'Which views?',
  )
  expect(f.queryAllByRole('radio')).toHaveLength(0)
  expect(f.getAllByText('Recommended').map((tag) => tag.parentElement?.textContent)).toEqual([
    'Board Recommended',
    'Map Recommended',
  ])
  const submit = screen.getByRole('button', { name: 'Submit answers' }) as HTMLButtonElement
  expect(submit.disabled).toBe(false)
  await u.click(f.getByRole('checkbox', { name: /^Map/ }))
  await u.click(f.getByRole('checkbox', { name: /^Board/ }))
  expect(f.queryByText('Changed ·')).toBeNull()
  await u.click(f.getByRole('checkbox', { name: /^List/ }))
  expect(f.queryByText('Changed ·')).toBeNull()
  expect(f.getAllByText('Recommended')).toHaveLength(2)
  await u.click(f.getByRole('checkbox', { name: /^Map/ }))
  await u.type(f.getByLabelText('Add to answer 1'), 'Map later.')
  await u.click(submit)
  expect(answer).toHaveBeenCalledWith('c1', {
    action: 'answer-round',
    answers: [{ answer: '', choices: ['Board', 'List'], note: 'Map later.' }],
  })
})

test('a round question that allows several answers can be sent with nothing ticked', async () => {
  const { answer } = requestApi()
  const several: Round = {
    number: 1,
    questions: [
      {
        question: 'Which views?',
        choices: ['Board', 'List'],
        recommended: 'Board',
        multiple: true,
        recommendedChoices: ['Board'],
      },
    ],
  }
  render(
    <RequestCard
      request={comment({ kind: 'round', round: several })}
      task={task()}
      onOpenRun={vi.fn()}
    />,
  )
  const u = user()
  const f = within(screen.getByRole('group', { name: /Which views/ }))
  const submit = screen.getByRole('button', { name: 'Submit answers' }) as HTMLButtonElement
  await u.click(f.getByRole('checkbox', { name: /^Other/ }))
  expect(submit.disabled).toBe(true)
  await u.click(f.getByRole('checkbox', { name: /^Other/ }))
  await u.click(submit)
  expect(answer).toHaveBeenCalledWith('c1', {
    action: 'answer-round',
    answers: [{ answer: '', choices: [] }],
  })
})

test('Talk it through confirms a stopped Task, preserves edits on cancel, and opens only when ready', async () => {
  const api = requestApi()
  const request = comment({ kind: 'round', round })
  const start = vi.fn().mockReturnValue({ resumeRequired: true })
  api.handle('talkThrough', start)
  const open = vi.fn()
  const props = { request, task: task(), onOpenRun: open }
  const view = render(<RequestCard {...props} />)
  const u = user()
  await u.click(screen.getByRole('radio', { name: 'Keep latest' }))
  await u.type(screen.getByLabelText('Add to answer 1'), 'Keep this note.')
  await u.click(screen.getByRole('button', { name: 'Talk it through' }))
  expect(start).toHaveBeenLastCalledWith('c1', { confirmResume: false })
  await screen.findByRole('dialog', { name: 'Resume Task to talk?' })
  await u.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(start).toHaveBeenCalledTimes(1)
  expect((screen.getByLabelText('Add to answer 1') as HTMLInputElement).value).toBe(
    'Keep this note.',
  )
  await u.click(screen.getByRole('button', { name: 'Talk it through' }))
  await screen.findByRole('dialog', { name: 'Resume Task to talk?' })
  api.handle('talkThrough', (...args) => {
    start(...args)
    return { ...request, talkRequested: true }
  })
  await u.click(screen.getByRole('button', { name: 'Resume and talk' }))
  expect(start).toHaveBeenLastCalledWith('c1', { confirmResume: true })
  view.rerender(<RequestCard {...props} request={{ ...request, talkRequested: true }} />)
  expect(screen.getByRole('status').textContent).toContain('Waiting for Task Lead…')
  expect(
    (screen.getByRole('button', { name: 'Submit answers' }) as HTMLButtonElement).disabled,
  ).toBe(false)
  expect(open).not.toHaveBeenCalled()
  const ready = {
    ...request,
    talk: { runId: 'new-lead', startedAt: createdAt, notifiedAt: createdAt },
  }
  view.rerender(<RequestCard {...props} request={ready} task={task({ leadRunId: 'new-lead' })} />)
  await waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith('new-lead'))
  view.unmount()
  render(<RequestCard request={ready} task={task({ leadRunId: 'new-lead' })} onOpenRun={open} />)
  expect(open).toHaveBeenCalledTimes(1)
  expect((screen.getByRole('radio', { name: /Keep latest/ }) as HTMLInputElement).checked).toBe(
    true,
  )
  expect((screen.getByLabelText('Add to answer 1') as HTMLInputElement).value).toBe(
    'Keep this note.',
  )
  api.handle('talkThrough', () => ready)
  await u.click(screen.getByRole('button', { name: 'Open chat' }))
  expect(open).toHaveBeenCalledTimes(2)
})

test('a talk that becomes ready after leaving the round offers Open chat on the next visit', async () => {
  const api = requestApi()
  const request = comment({ kind: 'round', round })
  api.handle('talkThrough', () => ({ ...request, talkRequested: true }))
  const open = vi.fn()
  const view = render(<RequestCard request={request} task={task()} onOpenRun={open} />)
  await user().click(screen.getByRole('button', { name: 'Talk it through' }))
  view.unmount()
  render(
    <RequestCard
      request={{ ...request, talk: { runId: 'lead', startedAt: createdAt, notifiedAt: createdAt } }}
      task={task({ leadRunId: 'lead' })}
      onOpenRun={open}
    />,
  )
  expect(screen.getByRole('button', { name: 'Open chat' })).toBeTruthy()
  expect(open).not.toHaveBeenCalled()
})

test('a still-mounted hidden round never opens a queued talk over another view', async () => {
  const api = requestApi()
  const request = comment({ kind: 'round', round })
  api.handle('talkThrough', () => ({ ...request, talkRequested: true }))
  const open = vi.fn()
  const props = { task: task({ leadRunId: 'lead' }), onOpenRun: open }
  const view = render(<RequestCard {...props} request={request} active />)
  await user().click(screen.getByRole('button', { name: 'Talk it through' }))
  view.rerender(<RequestCard {...props} request={{ ...request, talkRequested: true }} active />)
  view.rerender(
    <RequestCard {...props} request={{ ...request, talkRequested: true }} active={false} />,
  )
  const ready = { ...request, talk: { runId: 'lead', startedAt: createdAt, notifiedAt: createdAt } }
  view.rerender(<RequestCard {...props} request={ready} active={false} />)
  expect(open).not.toHaveBeenCalled()
  view.rerender(<RequestCard {...props} request={ready} active />)
  expect(open).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Open chat' })).toBeTruthy()
})

test('leaving and returning before a talk request finishes prevents late automatic navigation', async () => {
  const api = requestApi()
  const request = comment({ kind: 'round', round })
  const response = deferred<typeof request>()
  api.handle('talkThrough', () => response.promise)
  const open = vi.fn()
  const props = { task: task({ leadRunId: 'lead' }), onOpenRun: open, request }
  const view = render(<RequestCard {...props} active />)
  await user().click(screen.getByRole('button', { name: 'Talk it through' }))
  view.rerender(<RequestCard {...props} active={false} />)
  view.rerender(<RequestCard {...props} active />)
  await act(async () =>
    response.resolve({
      ...request,
      talk: { runId: 'lead', startedAt: createdAt, notifiedAt: createdAt },
    }),
  )
  expect(open).not.toHaveBeenCalled()
})

test('cancelling a bound talk before acknowledgement never opens the stopped Lead', async () => {
  const api = requestApi()
  const request = comment({ kind: 'round', round })
  api.handle('talkThrough', () => ({ ...request, talkRequested: true }))
  const open = vi.fn()
  const props = {
    task: task({ leadRunId: 'lead', status: { kind: 'waiting-on-you' } }),
    onOpenRun: open,
  }
  const view = render(<RequestCard {...props} request={request} />)
  await user().click(screen.getByRole('button', { name: 'Talk it through' }))
  const bound = { ...request, talk: { runId: 'lead', startedAt: createdAt } }
  view.rerender(<RequestCard {...props} request={{ ...bound, talkRequested: true }} />)
  view.rerender(<RequestCard {...props} request={bound} />)
  expect(open).not.toHaveBeenCalled()
})

test('a pending talk explains a live Lead’s availability and acknowledgement wait', () => {
  requestApi()
  const lead = {
    id: 'lead',
    agent: 'claude' as const,
    role: 'lead' as const,
    name: 'Task Lead',
    state: 'waiting' as const,
  }
  const request = comment({ kind: 'round', round, talkRequested: true })
  const view = render(
    <RequestCard
      request={request}
      task={task({ leadRunId: lead.id, runs: [{ ...lead, paused: 'Signed out' }] })}
    />,
  )
  expect(screen.getByRole('status').textContent).toContain('Signed out')
  view.rerender(
    <RequestCard
      request={{ ...request, talk: { runId: lead.id, startedAt: createdAt } }}
      task={task({ leadRunId: lead.id, runs: [lead] })}
    />,
  )
  expect(screen.getByRole('status').textContent).toContain(
    'Waiting for the Task Lead to receive this request.',
  )
})

test('a round draft saved with two texts shows the selected option’s text', () => {
  expect(writtenText({ note: 'Under a choice', custom: 'Under Other' })).toBe('Under a choice')
  expect(writtenText({ note: 'Under a choice', custom: 'Under Other', other: true })).toBe(
    'Under Other',
  )
  expect(writtenText({ note: 'Under a choice', other: true })).toBe('Under a choice')
  expect(writtenText({ note: '', custom: 'Under Other' })).toBe('Under Other')
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
