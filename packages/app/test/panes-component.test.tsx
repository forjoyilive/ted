// @vitest-environment jsdom
import type { Comment, InboxItem, PlanDetail, PlanInboxItem, RunChat } from '@ted/protocol'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { appState } from './support/app.tsx'
import { deferred, required, user } from './support/component.ts'
import { comment, createdAt, factory, task } from './support/fixtures.ts'

async function openTask(a: ReturnType<typeof appState>) {
  a.state.tasks = [task()]
  a.mount()
  await user().click(await screen.findByRole('button', { name: 'All Tasks' }))
  await user().click(within(screen.getByRole('main')).getByText('Sync notes'))
  return screen.findByRole('region', { name: 'Task thread' })
}

test('thread notes show relative ages and keep advancing while open', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(new Date('2026-11-09T12:02:00.000Z'))
  try {
    const a = appState()
    a.handle('markCommentsRead', () => ({ read: 2 }))
    a.handle('listComments', () => [
      comment({
        kind: 'note',
        body: 'The fix is ready.',
        author: { kind: 'run', runId: 'r1' },
      }),
      comment({
        id: 'c2',
        kind: 'note',
        body: 'Trying it now.',
        author: { kind: 'human' },
        createdAt: '2026-11-09T12:02:00.000Z',
      }),
    ])
    const thread = await openTask(a)
    const lead = within(
      required((await within(thread).findByText('The fix is ready.')).closest('li')),
    )
    const human = within(required(within(thread).getByText('Trying it now.').closest('li')))
    expect(lead.getByText('2m ago', { exact: true })).toBeTruthy()
    expect(human.getByText('just now', { exact: true })).toBeTruthy()
    await act(async () => vi.advanceTimersByTime(60_000))
    expect(lead.getByText('3m ago', { exact: true })).toBeTruthy()
    expect(human.getByText('1m ago', { exact: true })).toBeTruthy()
    expect(human.getByText('Goes to the next Task Lead Run')).toBeTruthy()
  } finally {
    vi.useRealTimers()
  }
})

test('Task back links restore Board, List and All Tasks', async () => {
  const a = appState()
  await openTask(a)
  await user().click(screen.getByRole('button', { name: '← All Tasks' }))
  expect(screen.queryByRole('region', { name: 'Task thread' })).toBeNull()
  const u = user()
  await u.click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: 'Task views',
    }),
  )
  await user().click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: 'Board',
    }),
  )
  await u.click(within(screen.getByRole('main')).getByText('Sync notes'))
  await u.click(screen.getByRole('button', { name: '← Board' }))
  await u.click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: 'List',
    }),
  )
  await u.click(within(screen.getByRole('main')).getByText('Sync notes'))
  await u.click(screen.getByRole('button', { name: '← List' }))
  expect(screen.queryByRole('region', { name: 'Task thread' })).toBeNull()
})

test('Full brief opens its five sections in the middle pane and returns to Thread', async () => {
  const a = appState()
  a.handle('taskBrief', () => ({
    taskId: 'NB-1',
    version: 1,
    stage: 'design',
    createdAt: new Date().toISOString(),
    text: '## Goal\n\nStop the TypeError.\n\n## Decisions so far\n\n- Guard in SearchPanel.\n\n## Current state\n\nDone.\n\n## Open questions\n\nNone.\n\n## Next step\n\nYour sign-off.',
  }))
  await openTask(a)
  await user().click(await screen.findByRole('button', { name: 'Brief' }))
  const full = screen.getByRole('region', { name: 'Full brief' })
  expect(
    within(full)
      .getAllByRole('heading', { level: 3 })
      .map((e) => e.textContent),
  ).toEqual(['Goal', 'Decisions so far', 'Current state', 'Open questions', 'Next step'])
  expect(within(full).getByText('• Guard in SearchPanel.')).toBeTruthy()
  expect(within(full).getByText(/Updated by the Task Lead in Design · just now/)).toBeTruthy()
  expect(screen.queryByRole('region', { name: 'Task thread' })).toBeNull()
  await user().click(within(full).getByRole('button', { name: '← Task Lead' }))
  expect(screen.getByRole('region', { name: 'Task thread' })).toBeTruthy()
})

test('Inbox answers close before its list refresh without recaps and remain in Answered history', async () => {
  const a = appState()
  const nextTask = task({ id: 'NB-2', displayId: 'NB-2', number: 2 })
  a.state.tasks = [task(), nextTask]
  a.state.factories.push(factory({ id: 'f2', key: 'MS', name: 'Marketing' }))
  const first = comment({ body: 'First question?', choices: ['Yes'] })
  const second = comment({
    id: 'c2',
    taskId: nextTask.id,
    kind: 'permission',
    body: 'Second request',
    permission: { command: 'pnpm build' },
  })
  let comments = [first, second]
  a.state.inbox = comments.map((request) => ({
    task: request.taskId === nextTask.id ? nextTask : task(),
    request,
  }))
  a.handle('listComments', (taskId) => comments.filter((request) => request.taskId === taskId))
  a.handle('markCommentsRead', () => ({ read: 1 }))
  a.mount()
  const inbox = await screen.findByRole('region', { name: 'Inbox' })
  await user().click(await within(inbox).findByText('First question?'))
  await screen.findByRole('region', { name: 'Question' })
  const refresh = deferred<never[]>()
  a.handle('listInbox', () => refresh.promise)
  const reply = deferred<ReturnType<typeof comment>>()
  a.handle('answerRequest', (id) => {
    const original = required(comments.find((request) => request.id === id))
    const answered = {
      ...original,
      answer: { kind: 'answered' as const, at: createdAt, choice: 'Yes' },
    }
    comments = comments.map((request) => (request.id === id ? answered : request))
    a.emit({ type: 'comment-updated', comment: answered })
    return reply.promise
  })
  await user().click(
    within(screen.getByRole('region', { name: 'Answer' })).getByRole('radio', { name: 'Yes' }),
  )
  expect(a.request.mock.calls.some(([name]) => name === 'answerRequest')).toBe(false)
  await user().click(
    within(screen.getByRole('region', { name: 'Answer' })).getByRole('button', { name: 'Send' }),
  )
  expect(
    within(screen.getByRole('region', { name: 'Permission' })).getByText('Second request'),
  ).toBeTruthy()
  expect(within(inbox).queryByRole('status')).toBeNull()
  await act(async () =>
    reply.resolve({ ...first, answer: { kind: 'answered', at: createdAt, choice: 'Yes' } }),
  )
  expect(within(inbox).queryByRole('status')).toBeNull()
  expect(screen.queryByRole('region', { name: 'Question, answered' })).toBeNull()
  const openFilter = async () => {
    if (!within(inbox).queryByRole('menu', { name: 'Filter' })) {
      await user().click(within(inbox).getByRole('button', { name: /^Filter/ }))
    }
  }
  await openFilter()
  await user().click(within(inbox).getByRole('button', { name: 'Marketing 0' }))
  expect(within(inbox).queryByRole('status')).toBeNull()
  await openFilter()
  await user().click(within(inbox).getByRole('button', { name: 'All 1' }))
  a.handle('listAnswered', () => [{ task: task(), request: required(comments[0]) }])
  await openFilter()
  await user().click(within(inbox).getByRole('switch', { name: 'Answered' }))
  expect(await within(inbox).findByText('First question?')).toBeTruthy()
  expect(within(inbox).queryByRole('status')).toBeNull()
  await openFilter()
  await user().click(within(inbox).getByRole('switch', { name: 'Answered' }))
  await user().click(within(inbox).getByText('Second request'))
  a.handle('answerRequest', () => {
    throw new Error('Answer could not be saved')
  })
  await user().click(
    within(screen.getByRole('region', { name: 'Answer' })).getByRole('button', { name: 'Deny' }),
  )
  await screen.findByText('Answer could not be saved')
  expect(
    within(screen.getByRole('region', { name: 'Permission' })).getByText('Second request'),
  ).toBeTruthy()
  expect(within(inbox).queryByRole('status')).toBeNull()
  const answered = { ...second, answer: { kind: 'denied' as const, at: createdAt } }
  a.handle('answerRequest', () => answered)
  await user().click(
    within(screen.getByRole('region', { name: 'Answer' })).getByRole('button', { name: 'Deny' }),
  )
  await screen.findByText('Nothing waiting on you')
  expect(within(inbox).queryByRole('status')).toBeNull()
  expect(screen.queryByRole('region', { name: 'Task thread' })).toBeNull()
  expect(screen.queryByRole('complementary', { name: 'Task details' })).toBeNull()
  await act(async () => refresh.resolve([]))
  await user().click(screen.getByRole('button', { name: 'All Tasks' }))
  await user().click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: /^Inbox/,
    }),
  )
  expect(within(screen.getByRole('region', { name: 'Inbox' })).queryByRole('status')).toBeNull()
})

test('external resolution clears an Inbox request without claiming the user answered it', async () => {
  const a = appState()
  a.state.tasks = [task()]
  const request = comment({ body: 'Still needed?' })
  a.state.inbox = [{ task: task(), request }]
  a.handle('listComments', () => [request])
  a.handle('markCommentsRead', () => ({ read: 1 }))
  a.mount()
  const inbox = await screen.findByRole('region', { name: 'Inbox' })
  await user().click(await within(inbox).findByText('Still needed?'))
  await screen.findByRole('region', { name: 'Question' })
  const refresh = deferred<never[]>()
  a.handle('listInbox', () => refresh.promise)
  await act(async () =>
    a.emit({
      type: 'comment-updated',
      comment: { ...request, answer: { kind: 'withdrawn', at: createdAt, cancelled: true } },
    }),
  )
  expect(screen.queryByRole('region', { name: 'Task thread' })).toBeNull()
  expect(within(inbox).queryByRole('status')).toBeNull()
  await act(async () => refresh.resolve([]))
})

test('requests stay in the conversation and repeated jumps preserve answer drafts', async () => {
  const a = appState()
  const current = task({
    stage: 'work',
    track: [
      { stage: 'intake', state: 'past' },
      { stage: 'work', state: 'current' },
    ],
  })
  a.state.tasks = [current]
  const first = comment({ body: 'Where should sync status show?', choices: ['Header'] })
  const second = comment({
    id: 'c2',
    body: 'Can the queue retry offline?',
    choices: ['Yes'],
    createdAt: '2026-11-09T12:02:00.000Z',
  })
  a.state.inbox = [first, second].map((request) => ({ task: current, request }))
  a.handle('listComments', () => [first, second])
  a.handle('listStageEntries', () => [
    { stage: 'intake', at: createdAt },
    { stage: 'work', at: '2026-11-09T12:01:00.000Z' },
  ])
  a.handle('markCommentsRead', () => ({ read: 1 }))
  a.mount()
  const inbox = await screen.findByRole('region', { name: 'Inbox' })
  await user().click(await within(inbox).findByText('Can the queue retry offline?'))
  const thread = screen.getByRole('region', { name: 'Task thread' })
  const cards = within(thread).getAllByRole('region', { name: 'Question' })
  expect(cards).toHaveLength(2)
  const firstCard = required(cards[0])
  const secondCard = required(cards[1])
  const conversation = required(firstCard.closest('[data-scroller]'))
  expect(conversation.contains(secondCard)).toBe(true)
  expect(within(firstCard).getByText(first.body)).toBeTruthy()
  expect(within(secondCard).getByText(second.body)).toBeTruthy()
  expect(document.activeElement?.contains(secondCard)).toBe(true)
  expect(within(secondCard).getByText('Answer at the bottom of the Task ↓')).toBeTruthy()
  expect(within(secondCard).queryByRole('textbox', { name: 'Your answer' })).toBeNull()
  const dock = within(thread).getByRole('region', { name: 'Answer' })
  expect(within(dock).getByText(second.body)).toBeTruthy()
  expect(within(dock).getByText('2 of 2')).toBeTruthy()
  await user().type(within(dock).getByRole('textbox', { name: 'Your answer' }), 'Keep retrying')
  fireEvent.dragOver(secondCard, { dataTransfer: { types: ['Files'] } })
  expect(within(thread).queryByText('Drop to attach')).toBeNull()
  const firstJump = () => jumpTo(thread, /Where should sync status show/)
  const secondJump = () => jumpTo(thread, /Can the queue retry offline/)
  await firstJump()
  expect(document.activeElement?.contains(firstCard)).toBe(true)
  expect(within(dock).getByText(first.body)).toBeTruthy()
  expect(
    (within(dock).getByRole('textbox', { name: 'Your answer' }) as HTMLTextAreaElement).value,
  ).toBe('')
  await user().click(within(inbox).getByText(second.body))
  expect(document.activeElement?.contains(secondCard)).toBe(true)
  await secondJump()
  expect(document.activeElement?.contains(secondCard)).toBe(true)
  expect(
    (within(dock).getByRole('textbox', { name: 'Your answer' }) as HTMLTextAreaElement).value,
  ).toBe('Keep retrying')
  const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView)
  scrollIntoView.mockClear()
  await secondJump()
  const target = required(secondCard.closest('[data-chat-item]'))
  expect(document.activeElement).toBe(target)
  expect(scrollIntoView.mock.contexts).toContain(target)
  expect(within(dock).getByDisplayValue('Keep retrying')).toBeTruthy()
  await user().click(within(dock).getByRole('button', { name: 'Previous request' }))
  expect(within(dock).getByText('1 of 2')).toBeTruthy()
  await user().type(
    within(dock).getByRole('textbox', { name: 'Your answer' }),
    'Keep the header draft',
  )
  a.handle('postComment', () => comment({ id: 'c3', kind: 'note', body: 'Keep the header draft' }))
  const commentInstead = within(dock).getByRole('button', {
    name: 'Comment without answering',
  }) as HTMLButtonElement
  await user().click(commentInstead)
  expect(a.request).toHaveBeenCalledWith('postComment', current.id, {
    body: 'Keep the header draft',
    attachments: [],
  })
  expect(a.request.mock.calls.some(([name]) => name === 'answerRequest')).toBe(false)
  await vi.waitFor(() =>
    expect(within(dock).getByRole('textbox', { name: 'Your answer' })).toHaveProperty('value', ''),
  )
  expect(commentInstead.disabled).toBe(true)
  expect(within(thread).getByRole('region', { name: 'Answer' })).toBe(dock)
  expect(within(dock).getByText('1 of 2')).toBeTruthy()
  expect(within(thread).queryByRole('note', { name: 'Open request' })).toBeNull()
  expect(within(thread).queryByRole('textbox', { name: 'Comment' })).toBeNull()
  await user().type(
    within(dock).getByRole('textbox', { name: 'Your answer' }),
    'Keep the header draft',
  )
  expect(commentInstead.disabled).toBe(false)
  await user().click(within(thread).getByRole('button', { name: 'Work, now' }))
  expect(within(thread).getAllByRole('region', { name: 'Question' })).toHaveLength(1)
  await firstJump()
  expect(within(thread).getAllByRole('region', { name: 'Question' })).toHaveLength(2)
  expect(within(thread).queryByText('Showing Work only ·')).toBeNull()
  expect(within(dock).getByDisplayValue('Keep the header draft')).toBeTruthy()
  expect(firstCard.isConnected).toBe(true)
})

test('S starts the open Task and its menu moves a queued Task back to Backlog', async () => {
  const a = appState()
  a.handle('startTask', () =>
    task({ stage: 'intake', status: { kind: 'queued', place: 1 }, statuses: ['queued'] }),
  )
  a.handle('moveToBacklog', () => task())
  await openTask(a)
  await act(async () => {
    fireEvent.keyDown(window, { key: 's' })
  })
  expect(a.request).toHaveBeenCalledWith('startTask', 'NB-1')
  await a.emitTask(
    task({
      stage: 'intake',
      status: { kind: 'queued', place: 1 },
      statuses: ['queued'],
      activity: 'Waiting for a free Run slot',
    }),
  )
  await user().click(screen.getByRole('button', { name: 'Task actions' }))
  const menu = screen.getByRole('menu', { name: /Task actions/ })
  expect(within(menu).getAllByRole('menuitem')[0]?.textContent).toContain('Move to Backlog')
  await user().click(within(menu).getByRole('menuitem', { name: /^Move to Backlog/ }))
  expect(a.request).toHaveBeenCalledWith('moveToBacklog', 'NB-1')
})

test('live Task and Comment events update the List and an open thread through Done', async () => {
  const a = appState()
  a.mount()
  await user().click(await screen.findByRole('button', { name: 'All Tasks' }))
  expect(screen.getByText('No Tasks yet')).toBeTruthy()
  await a.emitTask(task())
  await user().click(within(screen.getByRole('main')).getByText('Sync notes'))
  a.handle('markCommentsRead', () => ({ read: 1 }))
  a.handle('listComments', () => [
    comment({ kind: 'note', body: 'Halfway there', author: { kind: 'run', runId: 'r1' } }),
  ])
  await a.emitTask(task({ stage: 'intake', status: { kind: 'working' }, statuses: ['working'] }))
  await act(async () =>
    a.emit({
      type: 'comment-posted',
      comment: comment({
        kind: 'note',
        body: 'Halfway there',
        author: { kind: 'run', runId: 'r1' },
      }),
    }),
  )
  expect(
    within(screen.getByRole('region', { name: 'Task thread' })).getByText('Halfway there'),
  ).toBeTruthy()
  await a.emitTask(
    task({
      stage: 'done',
      commentBox: 'done',
      merged: { at: new Date().toISOString(), pullRequests: [] },
    }),
  )
  expect(
    within(screen.getByRole('complementary', { name: 'Task details' })).getByText('Done', {
      exact: true,
    }),
  ).toBeTruthy()
})

test('Review opens repo-specific file and full diffs, then returns with the answer draft intact', async () => {
  const a = appState()
  const request = comment({
    kind: 'signoff',
    stage: 'review',
    gate: { approveLabel: 'Approve' },
    body: '## Goal\n\nReview sync.',
  })
  a.handle('listComments', () => [request])
  a.handle('markCommentsRead', () => ({ read: 1 }))
  a.handle('taskChanges', () => ({
    taskId: 'NB-1',
    files: 2,
    repos: ['widgets', 'api'].map((name) => ({
      name,
      baseBranch: 'main',
      added: 1,
      removed: 0,
      files: [{ path: 'src/sync.ts', added: 1, removed: 0, uncommitted: false }],
    })),
  }))
  a.handle('fileDiffs', () => [])
  const thread = await openTask(a)
  const u = user()
  await u.type(within(thread).getByLabelText('Your answer'), 'Check the retry.')
  const review = within(await screen.findByRole('region', { name: 'Current Task changes' }))
  await u.click(
    within(review.getByRole('list', { name: 'api' })).getByRole('button', { name: /sync.ts/ }),
  )
  await screen.findByRole('region', { name: 'Diff' })
  expect(a.request).toHaveBeenCalledWith('fileDiffs', 'NB-1', 'api', 'src/sync.ts')
  await u.click(screen.getByRole('button', { name: '← Back to Sign-Off' }))
  expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe(
    'Check the retry.',
  )
  await u.click(screen.getByRole('button', { name: 'View all changes' }))
  await screen.findByRole('region', { name: 'All changes' })
  expect(a.request).toHaveBeenCalledWith('fileDiffs', 'NB-1', 'widgets', undefined)
  expect(a.request).toHaveBeenCalledWith('fileDiffs', 'NB-1', 'api', undefined)
  await u.click(screen.getByRole('button', { name: '← Back to Sign-Off' }))
  expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe(
    'Check the retry.',
  )
  expect(a.request.mock.calls.some(([name]) => name === 'answerRequest')).toBe(false)
})

test.each(['response-first', 'event-first'] as const)(
  'answering a thread-chip selection closes that request without remounting the thread (%s)',
  async (order) => {
    const a = appState()
    a.state.tasks = [task()]
    const first = comment({ body: 'Keep the settings?', choices: ['Yes'] })
    const second = comment({
      id: 'c2',
      kind: 'permission',
      body: 'Build the preview?',
      permission: { command: 'pnpm build' },
    })
    const comments = [first, second]
    a.state.inbox = comments.map((request) => ({ task: task(), request }))
    a.handle('listComments', () => comments)
    a.handle('markCommentsRead', () => ({ read: 1 }))
    const reply = deferred<Comment>()
    a.handle('answerRequest', (id) => {
      expect(id).toBe(second.id)
      return reply.promise
    })
    a.mount()
    const inbox = await screen.findByRole('region', { name: 'Inbox' })
    await user().click(await within(inbox).findByText('Keep the settings?'))
    const thread = await screen.findByRole('region', { name: 'Task thread' })
    await within(thread).findByRole('button', { name: '2 waiting on you ▾' })
    await jumpTo(thread, /^Jump to Permission/)
    expect(
      required(within(inbox).getByText('Build the preview?').closest('button')).getAttribute(
        'aria-current',
      ),
    ).toBe('true')
    await user().click(
      within(screen.getByRole('region', { name: 'Answer' })).getByRole('button', { name: 'Deny' }),
    )
    const refresh = deferred<InboxItem[]>()
    a.handle('listInbox', () => refresh.promise)
    const answered: Comment = { ...second, answer: { kind: 'denied', at: createdAt } }
    if (order === 'response-first') await act(async () => reply.resolve(answered))
    else await act(async () => a.emit({ type: 'comment-updated', comment: answered }))
    expect(screen.getByRole('region', { name: 'Task thread' })).toBe(thread)
    const remaining = await screen.findByRole('region', { name: 'Question' })
    expect(within(remaining).getByText('Keep the settings?')).toBeTruthy()
    expect(within(thread).queryByRole('region', { name: 'Permission' })).toBeNull()
    expect(within(thread).queryByText('You denied')).toBeNull()
    const dock = screen.getByRole('region', { name: 'Answer' })
    const draft = within(dock).getByRole('textbox', { name: 'Your answer' })
    await user().type(draft, 'Keep this unfinished answer')
    if (order === 'response-first')
      await act(async () => a.emit({ type: 'comment-updated', comment: answered }))
    else await act(async () => reply.resolve(answered))
    expect(screen.getByRole('region', { name: 'Task thread' })).toBe(thread)
    expect(draft).toBe(
      within(screen.getByRole('region', { name: 'Answer' })).getByRole('textbox', {
        name: 'Your answer',
      }),
    )
    expect(within(dock).getByDisplayValue('Keep this unfinished answer')).toBe(draft)
    expect(within(inbox).queryByRole('status')).toBeNull()
    await act(async () => refresh.resolve([{ task: task(), request: first }]))
    expect(screen.getByRole('region', { name: 'Task thread' })).toBe(thread)
    expect(within(dock).getByDisplayValue('Keep this unfinished answer')).toBe(draft)
  },
)

test('a delayed earlier response keeps the Inbox empty without an answer recap', async () => {
  const a = appState()
  const nextTask = task({ id: 'NB-2', displayId: 'NB-2', number: 2 })
  a.state.tasks = [task(), nextTask]
  const first = comment({ body: 'Keep the settings?', choices: ['Yes'] })
  const second = comment({
    id: 'c2',
    taskId: nextTask.id,
    kind: 'permission',
    body: 'Build the preview?',
    permission: { command: 'pnpm build' },
  })
  const comments = [first, second]
  a.state.inbox = comments.map((request) => ({
    task: request.taskId === nextTask.id ? nextTask : task(),
    request,
  }))
  a.handle('listComments', (id) => comments.filter((request) => request.taskId === id))
  a.handle('markCommentsRead', () => ({ read: 1 }))
  const reply = deferred<Comment>()
  const answered: Comment = { ...first, answer: { kind: 'answered', at: createdAt, choice: 'Yes' } }
  a.handle('answerRequest', (id) => {
    if (id === first.id) {
      a.emit({ type: 'comment-updated', comment: answered })
      return reply.promise
    }
    return { ...second, answer: { kind: 'approved', at: createdAt } }
  })
  a.mount()
  const inbox = await screen.findByRole('region', { name: 'Inbox' })
  await user().click(await within(inbox).findByText('Keep the settings?'))
  const refresh = deferred<never[]>()
  a.handle('listInbox', () => refresh.promise)
  await user().click(
    within(await screen.findByRole('region', { name: 'Answer' })).getByRole('radio', {
      name: 'Yes',
    }),
  )
  await user().click(
    within(screen.getByRole('region', { name: 'Answer' })).getByRole('button', { name: 'Send' }),
  )
  await screen.findByRole('region', { name: 'Permission' })
  await user().click(
    within(screen.getByRole('region', { name: 'Answer' })).getByRole('button', {
      name: /^Approve/,
    }),
  )
  await screen.findByText('Nothing waiting on you')
  expect(within(inbox).queryByRole('status')).toBeNull()
  await act(async () => reply.resolve(answered))
  expect(within(inbox).queryByRole('status')).toBeNull()
  await act(async () => refresh.resolve([]))
})

test.each(['response-first', 'event-first'] as const)(
  'answering a Task request stops before a Planning request, which opens on the Agents screen (%s)',
  async (order) => {
    const a = appState()
    a.state.tasks = [task()]
    const first = comment({ body: 'Keep the settings?', choices: ['Yes'] })
    a.state.inbox = [{ task: task(), request: first }]
    a.handle('listComments', () => [first])
    a.handle('markCommentsRead', () => ({ read: 1 }))
    const detail: PlanDetail = {
      plan: {
        id: 'p1',
        factoryId: 'f1',
        factoryKey: 'NB',
        title: 'Plan the settings update',
        message: 'Make settings clearer.',
        agent: 'claude',
        status: 'waiting',
        createdAt,
        lastAt: createdAt,
        createdTasks: 0,
        runId: 'planner',
      },
      requests: [
        {
          id: 'round1',
          planId: 'p1',
          runId: 'planner',
          kind: 'round',
          author: 'run',
          title: 'Next settings change',
          body: '',
          createdAt,
          round: {
            number: 1,
            questions: [{ question: 'What should change?', recommended: 'Keep it simple' }],
          },
        },
      ],
      tasks: [],
    }
    let plans: PlanInboxItem[] = [{ plan: detail.plan, request: required(detail.requests[0]) }]
    a.handle('planInbox', () => plans)
    a.handle('getPlan', () => detail)
    const chat: RunChat = {
      run: {
        id: 'planner',
        name: 'Planner',
        role: 'run',
        agent: 'claude',
        state: 'waiting',
        startedAt: createdAt,
        current: true,
      },
      items: [],
    }
    a.handle('getRunChat', () => chat)
    const reply = deferred<Comment>()
    a.handle('answerRequest', () => reply.promise)
    a.handle('answerPlanRequest', () => {
      plans = []
      return { ...required(detail.requests[0]), answer: { kind: 'answered', at: createdAt } }
    })
    a.mount()
    const inbox = await screen.findByRole('region', { name: 'Inbox' })
    await within(inbox).findByText('Next settings change')
    await user().click(await within(inbox).findByText('Keep the settings?'))
    const refresh = deferred<never[]>()
    a.handle('listInbox', () => refresh.promise)
    await user().click(
      within(await screen.findByRole('region', { name: 'Answer' })).getByRole('radio', {
        name: 'Yes',
      }),
    )
    await user().click(
      within(screen.getByRole('region', { name: 'Answer' })).getByRole('button', { name: 'Send' }),
    )
    const answered: Comment = {
      ...first,
      answer: { kind: 'answered', at: createdAt, choice: 'Yes' },
    }
    if (order === 'response-first') await act(async () => reply.resolve(answered))
    else await act(async () => a.emit({ type: 'comment-updated', comment: answered }))
    await screen.findByRole('region', { name: 'Nothing open' })
    expect(screen.queryByRole('region', { name: 'Planning chat' })).toBeNull()
    if (order === 'response-first')
      await act(async () => a.emit({ type: 'comment-updated', comment: answered }))
    else await act(async () => reply.resolve(answered))
    expect(within(inbox).queryByRole('status')).toBeNull()
    expect(within(inbox).getByText(/Planner · Plan the settings update/)).toBeTruthy()
    await user().click(within(inbox).getByText('Next settings change'))
    const planning = await screen.findByRole('region', { name: 'Planning chat' })
    await within(planning).findByRole('button', { name: 'Submit answers' })
    expect(screen.queryByRole('region', { name: 'Inbox' })).toBeNull()
    expect(within(planning).queryByRole('button', { name: '← Inbox' })).toBeNull()
    await act(async () => refresh.resolve([]))
  },
)

test('Task history formats agent and user Comments and still formats them after reopening', async () => {
  const a = appState()
  a.handle('markCommentsRead', () => ({ read: 2 }))
  a.handle('listComments', () => [
    comment({
      kind: 'note',
      body: '## Result\n\n**Agent note**\n\n```sh\necho "**literal**"\n```',
      author: { kind: 'run', runId: 'r1' },
    }),
    comment({
      id: 'c2',
      kind: 'note',
      body: '> User quote\n\n*User note*',
      author: { kind: 'human' },
    }),
  ])
  const thread = await openTask(a)
  expect(within(thread).getByRole('heading', { name: 'Result' })).toBeTruthy()
  expect(within(thread).getByText('Agent note').tagName).toBe('STRONG')
  expect(within(thread).getByText('User note').tagName).toBe('EM')
  expect(within(thread).getByText('User quote').closest('blockquote')).toBeTruthy()
  expect(within(thread).getByText('echo "**literal**"').tagName).toBe('CODE')
  await user().click(screen.getByRole('button', { name: '← All Tasks' }))
  await user().click(within(screen.getByRole('main')).getByText('Sync notes'))
  expect(await screen.findByRole('heading', { name: 'Result' })).toBeTruthy()
  expect(screen.getByText('Agent note').tagName).toBe('STRONG')
})

test('Inbox reveals its request after delayed history and after other panes cover the thread', async () => {
  const a = appState()
  const run: RunChat['run'] & { role: 'lead' } = {
    id: 'r1',
    name: 'Task Lead',
    role: 'lead',
    agent: 'claude',
    state: 'idle',
    startedAt: createdAt,
    current: true,
  }
  const current = task({ leadRunId: run.id, runs: [run] })
  a.state.tasks = [current]
  const request = comment({ body: 'Keep the retry?', choices: ['Yes'] })
  a.state.inbox = [{ task: current, request }]
  const checks = deferred<never[]>()
  a.handle('listCheckRuns', () => checks.promise)
  a.handle('listComments', () => [
    request,
    comment({ id: 'later', kind: 'note', body: 'Later output.' }),
  ])
  a.handle('markCommentsRead', () => ({ read: 1 }))
  a.handle('taskBrief', () => ({
    taskId: current.id,
    version: 1,
    stage: 'work',
    createdAt,
    text: '## Goal\n\nKeep drafts.',
  }))
  a.handle('getRunChat', () => ({
    run,
    items: [{ kind: 'agent', id: 'message', text: 'Working on it.' }],
  }))
  a.handle('getRun', () => ({ run, conversation: [] }))
  a.handle('listTaskRuns', () => [run])
  a.mount()
  const inbox = await screen.findByRole('region', { name: 'Inbox' })
  await user().click(await within(inbox).findByText(request.body))
  await screen.findByLabelText('Loading Task history…')
  const loadingCard = await screen.findByRole('region', { name: 'Question' })
  await act(async () => checks.resolve([]))
  const card = await screen.findByRole('region', { name: 'Question' })
  expect(card).toBe(loadingCard)
  expect(document.activeElement?.contains(card)).toBe(true)
  const answer = within(screen.getByRole('region', { name: 'Answer' })).getByRole('textbox', {
    name: 'Your answer',
  })
  await user().type(answer, 'Keep this draft')
  await user().click(await screen.findByRole('button', { name: 'Brief' }))
  await screen.findByRole('region', { name: 'Full brief' })
  await user().click(within(inbox).getByText(request.body))
  expect(screen.queryByRole('region', { name: 'Full brief' })).toBeNull()
  expect(document.activeElement?.contains(card)).toBe(true)
  expect(screen.getByDisplayValue('Keep this draft')).toBe(answer)
  await screen.findByText('Working on it.')
  await user().click(within(inbox).getByText(request.body))
  const revealed = await screen.findByRole('region', { name: 'Question' })
  expect(document.activeElement?.contains(revealed)).toBe(true)
  expect(
    within(screen.getByRole('region', { name: 'Run chat' })).getByText('Working on it.'),
  ).toBeTruthy()
  expect(revealed).toBe(card)
  expect(screen.getByDisplayValue('Keep this draft')).toBe(answer)
})

test('request shortcuts target the focused request and do not guess between open requests', async () => {
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.closest('[hidden]') ? null : document.body
  })
  const a = appState()
  const first = comment({
    kind: 'permission',
    body: 'First command',
    permission: { command: 'cat first.txt' },
  })
  const second = comment({
    id: 'second',
    kind: 'permission',
    body: 'Second command',
    permission: { command: 'cat second.txt' },
  })
  const review = comment({
    id: 'review',
    kind: 'review',
    body: 'Review the draft',
    gate: { approveLabel: 'Approve' },
  })
  a.handle('listComments', () => [first, second, review])
  a.handle('markCommentsRead', () => ({ read: 1 }))
  a.handle('answerRequest', () => ({ ...second, answer: { kind: 'approved', at: createdAt } }))
  const thread = await openTask(a)
  await within(thread).findByRole('region', { name: 'Design review' })
  const u = user()
  await u.click(within(thread).getByRole('heading', { name: 'Sync notes' }))
  await u.keyboard('a{Enter}')
  expect(a.request.mock.calls.some(([name]) => name === 'answerRequest')).toBe(false)
  const dock = within(thread).getByRole('region', { name: 'Answer' })
  const jump = () => jumpTo(thread, 'Jump to Permission: Second command')
  await jump()
  await u.keyboard('r')
  const answer = within(dock).getByRole('textbox', { name: 'Your answer' })
  expect(document.activeElement).toBe(answer)
  await u.type(answer, 'Allow this one')
  await jump()
  await u.keyboard('a{Enter}')
  expect(a.request).toHaveBeenCalledWith('answerRequest', second.id, {
    action: 'approve',
    text: 'Allow this one',
  })
  expect(a.request.mock.calls.filter(([name]) => name === 'answerRequest')).toHaveLength(1)
  await jumpTo(thread, 'Jump to Design review: Review the draft')
  await u.keyboard('{Shift>}r{/Shift}')
  expect(document.activeElement).toBe(within(dock).getByRole('textbox', { name: 'Your answer' }))
  await u.click(within(thread).getByRole('heading', { name: 'Sync notes' }))
  await u.keyboard('r')
  expect(document.activeElement).not.toBe(thread.querySelector('textarea[data-comment-box]'))
})

async function jumpTo(thread: HTMLElement, name: string | RegExp) {
  await user().click(within(thread).getByRole('button', { name: /waiting on you/ }))
  await user().click(screen.getByRole('menuitem', { name }))
}
