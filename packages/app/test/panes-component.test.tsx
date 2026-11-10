// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { appState } from './support/app.tsx'
import { required, user } from './support/component.ts'
import { comment, createdAt, task } from './support/fixtures.ts'

async function openTask(a: ReturnType<typeof appState>) {
  a.state.tasks = [task()]
  a.mount()
  await user().click(await screen.findByRole('button', { name: 'All Tasks' }))
  await user().click(within(screen.getByRole('main')).getByText('Sync notes'))
  return screen.findByRole('region', { name: 'Task thread' })
}

test('Task back links restore Board, List and All Tasks', async () => {
  const a = appState()
  await openTask(a)
  await user().click(screen.getByRole('button', { name: '← All Tasks' }))
  expect(screen.queryByRole('region', { name: 'Task thread' })).toBeNull()
  const u = user()
  await u.click(screen.getByRole('button', { name: 'widgets' }))
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

test('Inbox resolution selects the next request and clears Task panes after the last', async () => {
  const a = appState()
  a.state.tasks = [task()]
  const first = comment({ body: 'First question?', choices: ['Yes'] })
  const second = comment({ id: 'c2', body: 'Second question?', choices: ['Yes'] })
  let comments = [first, second]
  a.state.inbox = comments.map((request) => ({ task: task(), request }))
  a.handle('listComments', () => comments)
  a.handle('markCommentsRead', () => ({ read: 1 }))
  a.handle('answerRequest', () => {
    comments = []
    a.state.inbox = []
    a.emit({
      type: 'comment-updated',
      comment: { ...second, answer: { kind: 'answered', at: createdAt, choice: 'Yes' } },
    })
    return { ...second, answer: { kind: 'answered', at: createdAt, choice: 'Yes' } }
  })
  a.mount()
  const inbox = await screen.findByRole('region', { name: 'Inbox' })
  await user().click(within(inbox).getByText('First question?'))
  await screen.findByRole('region', { name: 'Question' })
  a.state.inbox = [{ task: task(), request: second }]
  comments = [second]
  await act(async () =>
    a.emit({
      type: 'comment-updated',
      comment: { ...first, answer: { kind: 'answered', at: createdAt, choice: 'Yes' } },
    }),
  )
  const card = screen.getByRole('region', { name: 'Question' })
  expect(within(card).getByText('Second question?')).toBeTruthy()
  await user().click(within(card).getByRole('button', { name: 'Yes' }))
  await screen.findByText('Nothing waiting on you')
  expect(screen.queryByRole('region', { name: 'Task thread' })).toBeNull()
  expect(screen.queryByRole('complementary', { name: 'Task details' })).toBeNull()
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
