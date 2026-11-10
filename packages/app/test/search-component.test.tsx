// @vitest-environment jsdom
import type { SearchResults } from '@ted/protocol'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { SearchPalette } from '../src/renderer/components/SearchPalette.tsx'
import { bridge, user } from './support/component.ts'
import { createdAt, factory, task } from './support/fixtures.ts'

function open(found: Partial<SearchResults> = {}, current = false) {
  const context = {
    task: current ? task() : undefined,
    factories: [factory()],
    factoryId: 'f1',
    dispatch: vi.fn(),
    newTask: vi.fn(),
    newAutomation: vi.fn(),
    addFactory: vi.fn(),
  }
  const openTask = vi.fn()
  const close = vi.fn()
  const api = bridge({
    search: (query) => ({
      query,
      tasks: [],
      comments: [],
      plans: [],
      automations: [],
      factories: [],
      ...found,
    }),
    setPriority: vi.fn(),
  })
  render(
    <SearchPalette
      context={context}
      factoryId="f1"
      onOpenTask={openTask}
      onOpenFactory={vi.fn()}
      onClose={close}
    />,
  )
  return { context, openTask, close, ...api }
}

const hit = {
  taskId: 'NB-2',
  factoryId: 'f1',
  displayId: 'NB-2',
  title: 'Sync notes',
  stage: 'backlog' as const,
  state: 'open' as const,
  field: 'id' as const,
}

test('search preserves result order, selects the first Task and Enter opens it', async () => {
  const a = open({
    tasks: [hit, { ...hit, taskId: 'NB-1', displayId: 'NB-1', title: 'Mentions NB-2' }],
  })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'nb-2' } })
  const group = await screen.findByRole('group', { name: 'Tasks' })
  const options = within(group).getAllByRole('option')
  expect(options[0]?.textContent).toContain('Sync notes')
  expect(options[0]?.getAttribute('aria-selected')).toBe('true')
  await user().keyboard('{Enter}')
  expect(a.openTask).toHaveBeenCalledWith('NB-2', 'f1')
  expect(a.close).toHaveBeenCalledOnce()
})

test('history, archived and Comment search hits keep their source labels and links', async () => {
  const a = open({
    tasks: [
      { ...hit, field: 'original-request' },
      { ...hit, taskId: 'old', title: 'Old accents work', state: 'archived' },
    ],
    comments: [
      {
        commentId: 'c1',
        taskId: 'other',
        factoryId: 'f1',
        displayId: 'NB-3',
        taskTitle: 'Toast',
        snippet: 'Watch the accents in toasts',
        author: { kind: 'human' },
        leadAuthor: false,
        createdAt,
        state: 'open',
      },
    ],
  })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'accents' } })
  const group = await screen.findByRole('group', { name: 'Tasks' })
  expect(within(group).getAllByRole('option')[0]?.textContent).toContain('in Original request')
  expect(within(group).getAllByRole('option')[1]?.textContent).toContain('Archived')
  const comments = screen.getByRole('group', { name: 'Comments' })
  expect(within(comments).getByText('“Watch the accents in toasts”')).toBeTruthy()
  expect(within(comments).getByText(/You · Toast/)).toBeTruthy()
  await user().click(within(comments).getByRole('option'))
  expect(a.openTask).toHaveBeenCalledWith('other', 'f1')
})

test('a planning search hit dispatches its plan and Factory', async () => {
  const a = open({
    plans: [{ planId: 'p1', factoryId: 'f1', title: 'Offline editing', ended: false }],
  })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'offline' } })
  await user().click(await screen.findByRole('option', { name: 'Offline editing' }))
  expect(a.context.dispatch).toHaveBeenCalledWith({
    type: 'open-plan',
    factoryId: 'f1',
    planId: 'p1',
  })
  expect(a.close).toHaveBeenCalledOnce()
})

test('commands show shortcuts, change screens, choose Priority and open Delete', async () => {
  const a = open({}, true)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'open widgets' } })
  expect(screen.getByRole('option', { name: 'Open widgets' }).textContent).toContain('⌘1')
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'go to all' } })
  await user().click(screen.getByRole('option', { name: /Go to All Tasks/ }))
  expect(a.context.dispatch).toHaveBeenCalledWith({ type: 'open', screen: { kind: 'all-tasks' } })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'priority' } })
  await user().keyboard('{Enter}')
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'high' } })
  await user().click(screen.getByRole('option', { name: /High/ }))
  expect(a.request).toHaveBeenCalledWith('setPriority', 'NB-1', 'high')
})

test('no results offers Create Task with the typed text', async () => {
  const a = open()
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'kanban export' } })
  await screen.findByText('No results for ‘kanban export’')
  await user().keyboard('{Enter}')
  expect(a.context.newTask).toHaveBeenCalledWith('kanban export')
  expect(a.close).toHaveBeenCalledOnce()
})
