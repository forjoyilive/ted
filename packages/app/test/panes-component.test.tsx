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
  await u.click(screen.getByRole('button', { name: 'widgets' }))
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
  await user().click(await screen.findByRole('button', { name: 'Full brief' }))
  const full = screen.getByRole('region', { name: 'Full brief' })
  expect(
    within(full)
      .getAllByRole('heading', { level: 3 })
      .map((e) => e.textContent),
  ).toEqual(['Goal', 'Decisions so far', 'Current state', 'Open questions', 'Next step'])
  expect(within(full).getByText('• Guard in SearchPanel.')).toBeTruthy()
  expect(within(full).getByText(/Updated by the Task Lead in Design · just now/)).toBeTruthy()
  expect(screen.queryByRole('region', { name: 'Task thread' })).toBeNull()
  await user().click(within(full).getByRole('button', { name: '← Thread' }))
  expect(screen.getByRole('region', { name: 'Task thread' })).toBeTruthy()
})

test('Inbox answers close before its list refresh, keep confirmation, and clear it on leaving', async () => {
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
  await user().click(within(inbox).getByText('First question?'))
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
    within(screen.getByRole('region', { name: 'Question' })).getByRole('button', { name: 'Yes' }),
  )
  expect(
    within(screen.getByRole('region', { name: 'Permission' })).getByText('Second request'),
  ).toBeTruthy()
  expect(within(inbox).getByRole('status').textContent).toBe('')
  await act(async () =>
    reply.resolve({ ...first, answer: { kind: 'answered', at: createdAt, choice: 'Yes' } }),
  )
  expect(within(inbox).getByRole('status').textContent).toBe('Answered NB-1’s question')
  expect(screen.queryByRole('region', { name: 'Question, answered' })).toBeNull()
  await user().click(within(inbox).getByRole('button', { name: 'Marketing 0' }))
  expect(within(inbox).getByRole('status').textContent).toBe('Answered NB-1’s question')
  await user().click(within(inbox).getByRole('button', { name: 'All 1' }))
  await user().click(within(inbox).getByRole('switch', { name: 'Answered' }))
  expect(within(inbox).getByRole('status').textContent).toBe('Answered NB-1’s question')
  await user().click(within(inbox).getByRole('switch', { name: 'Answered' }))
  await user().click(within(inbox).getByText('Second request'))
  a.handle('answerRequest', () => {
    throw new Error('Answer could not be saved')
  })
  await user().click(
    within(screen.getByRole('region', { name: 'Permission' })).getByRole('button', {
      name: 'Deny',
    }),
  )
  await screen.findByText('Answer could not be saved')
  expect(
    within(screen.getByRole('region', { name: 'Permission' })).getByText('Second request'),
  ).toBeTruthy()
  expect(within(inbox).getByRole('status').textContent).toBe('Answered NB-1’s question')
  const answered = { ...second, answer: { kind: 'denied' as const, at: createdAt } }
  a.handle('answerRequest', () => answered)
  await user().click(
    within(screen.getByRole('region', { name: 'Permission' })).getByRole('button', {
      name: 'Deny',
    }),
  )
  await screen.findByText('Nothing waiting on you')
  expect(within(inbox).getByRole('status').textContent).toBe('Denied NB-2’s permission request')
  expect(screen.queryByRole('region', { name: 'Task thread' })).toBeNull()
  expect(screen.queryByRole('complementary', { name: 'Task details' })).toBeNull()
  await act(async () => refresh.resolve([]))
  await user().click(screen.getByRole('button', { name: 'All Tasks' }))
  await user().click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: /^Inbox/,
    }),
  )
  expect(
    within(screen.getByRole('region', { name: 'Inbox' })).getByRole('status').textContent,
  ).toBe('')
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
  expect(within(inbox).getByRole('status').textContent).toBe('')
  await act(async () => refresh.resolve([]))
})

test('multiple requests pin one card and chips switch the pinned request', async () => {
  const a = appState()
  a.state.tasks = [task()]
  const first = comment({ body: 'Where should sync status show?', choices: ['Header'] })
  const second = comment({ id: 'c2', body: 'Can the queue retry offline?', choices: ['Yes'] })
  a.state.inbox = [first, second].map((request) => ({ task: task(), request }))
  a.handle('listComments', () => [first, second])
  a.handle('markCommentsRead', () => ({ read: 1 }))
  a.mount()
  const inbox = await screen.findByRole('region', { name: 'Inbox' })
  await user().click(within(inbox).getByText('Can the queue retry offline?'))
  const thread = screen.getByRole('region', { name: 'Task thread' })
  const chips = within(
    within(thread).getByRole('group', { name: '2 waiting on you' }),
  ).getAllByRole('button')
  expect(chips).toHaveLength(2)
  expect(within(thread).getAllByRole('button', { name: /waiting ·/ })).toHaveLength(2)
  expect(within(thread).getByRole('button', { name: /waiting · shown below/ })).toBeTruthy()
  expect(chips[1]?.getAttribute('aria-pressed')).toBe('true')
  expect(within(thread).getAllByRole('region', { name: 'Question' })).toHaveLength(1)
  await user().click(required(chips[0]))
  expect(chips[0]?.getAttribute('aria-pressed')).toBe('true')
  expect(
    within(within(thread).getByRole('region', { name: 'Question' })).getByText(
      'Where should sync status show?',
    ),
  ).toBeTruthy()
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
  const menu = screen.getByRole('menu', { name: 'Task actions' })
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
  await u.click(screen.getByRole('button', { name: '← Back to sign-off' }))
  expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe(
    'Check the retry.',
  )
  await u.click(screen.getByRole('button', { name: 'View all changes' }))
  await screen.findByRole('region', { name: 'All changes' })
  expect(a.request).toHaveBeenCalledWith('fileDiffs', 'NB-1', 'widgets', undefined)
  expect(a.request).toHaveBeenCalledWith('fileDiffs', 'NB-1', 'api', undefined)
  await u.click(screen.getByRole('button', { name: '← Back to sign-off' }))
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
    const chips = await within(thread).findByRole('group', { name: '2 waiting on you' })
    await user().click(within(chips).getByRole('button', { name: /^Permission/ }))
    expect(
      required(within(inbox).getByText('Build the preview?').closest('button')).getAttribute(
        'aria-current',
      ),
    ).toBe('true')
    await user().click(
      within(screen.getByRole('region', { name: 'Permission' })).getByRole('button', {
        name: 'Deny',
      }),
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
    const draft = within(remaining).getByRole('textbox', { name: 'Your answer' })
    await user().type(draft, 'Keep this unfinished answer')
    if (order === 'response-first')
      await act(async () => a.emit({ type: 'comment-updated', comment: answered }))
    else await act(async () => reply.resolve(answered))
    expect(screen.getByRole('region', { name: 'Task thread' })).toBe(thread)
    expect(draft).toBe(
      within(screen.getByRole('region', { name: 'Question' })).getByRole('textbox', {
        name: 'Your answer',
      }),
    )
    expect(within(remaining).getByDisplayValue('Keep this unfinished answer')).toBe(draft)
    expect(within(inbox).getByRole('status').textContent).toBe('Denied NB-1’s permission request')
    await act(async () => refresh.resolve([{ task: task(), request: first }]))
    expect(screen.getByRole('region', { name: 'Task thread' })).toBe(thread)
    expect(within(remaining).getByDisplayValue('Keep this unfinished answer')).toBe(draft)
  },
)

test('a delayed earlier response does not replace the newest answer confirmation', async () => {
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
    within(await screen.findByRole('region', { name: 'Question' })).getByRole('button', {
      name: 'Yes',
    }),
  )
  const card = await screen.findByRole('region', { name: 'Permission' })
  await user().click(within(card).getByRole('button', { name: /^Approve/ }))
  await screen.findByText('Nothing waiting on you')
  const status = within(inbox).getByRole('status')
  expect(status.textContent).toBe('Approved NB-2’s permission requestThis request only')
  await act(async () => reply.resolve(answered))
  expect(status.textContent).toBe('Approved NB-2’s permission requestThis request only')
  await act(async () => refresh.resolve([]))
})

test.each(['response-first', 'event-first'] as const)(
  'automatically opening a Planning request keeps Inbox confirmation (%s)',
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
      within(await screen.findByRole('region', { name: 'Question' })).getByRole('button', {
        name: 'Yes',
      }),
    )
    const answered: Comment = {
      ...first,
      answer: { kind: 'answered', at: createdAt, choice: 'Yes' },
    }
    if (order === 'response-first') await act(async () => reply.resolve(answered))
    else await act(async () => a.emit({ type: 'comment-updated', comment: answered }))
    const planning = await screen.findByRole('region', { name: 'Planning chat' })
    await within(planning).findByRole('button', { name: 'Submit answers' })
    expect(screen.getByRole('region', { name: 'Inbox' })).toBe(inbox)
    expect(within(planning).getByRole('button', { name: '← Inbox' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Task thread' })).toBeNull()
    if (order === 'response-first')
      await act(async () => a.emit({ type: 'comment-updated', comment: answered }))
    else await act(async () => reply.resolve(answered))
    expect(within(inbox).getByRole('status').textContent).toBe('Answered NB-1’s question')
    await user().click(within(planning).getByRole('button', { name: 'Submit answers' }))
    await screen.findByText('Nothing waiting on you')
    expect(within(inbox).getByRole('status').textContent).toBe(
      'Answered Plan the settings update’s Clarify round',
    )
    expect(screen.queryByRole('region', { name: 'Planning chat' })).toBeNull()
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
