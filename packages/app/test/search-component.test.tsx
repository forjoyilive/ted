// @vitest-environment jsdom
import type { RunChat, SearchResults } from '@ted/protocol'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { SearchPalette } from '../src/renderer/components/SearchPalette.tsx'
import { appState } from './support/app.tsx'
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

test('commands show shortcuts, change screens and choose Priority', async () => {
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

test('the open Task’s palette Delete command opens its dialog and Cancel keeps the Task', async () => {
  const a = appState()
  a.state.tasks = [task(), task({ id: 'NB-2', displayId: 'NB-2', title: 'Other Task' })]
  a.handle('search', (query) => ({
    query,
    tasks: [],
    comments: [],
    plans: [],
    automations: [],
    factories: [],
  }))
  a.mount()
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'All Tasks' }))
  await u.click(within(screen.getByRole('main')).getByText('Sync notes'))
  await screen.findByRole('region', { name: 'Task thread' })
  fireEvent.keyDown(window, { key: 'k', metaKey: true })
  const palette = await screen.findByRole('dialog', { name: 'Search and commands' })
  await u.type(within(palette).getByRole('combobox'), 'Delete')
  await u.click(within(palette).getByRole('option', { name: 'Delete…' }))
  const dialog = await screen.findByRole('dialog', { name: 'Delete NB-1?' })
  expect(within(dialog).getByText(/Sync notes\. TED removes/)).toBeTruthy()
  expect(screen.queryByRole('dialog', { name: 'Search and commands' })).toBeNull()
  await u.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('region', { name: 'Task thread' }).textContent).toContain('Sync notes')
  expect(a.state.tasks.map((t) => t.id)).toEqual(['NB-1', 'NB-2'])
  expect(a.request.mock.calls.some(([name]) => name === 'deleteTask')).toBe(false)
})

test('App’s no-results action opens New Task with the search query in Description', async () => {
  const a = appState()
  a.handle('search', (query) => ({
    query,
    tasks: [],
    comments: [],
    plans: [],
    automations: [],
    factories: [],
  }))
  a.mount()
  await screen.findByRole('button', { name: 'widgets' })
  fireEvent.keyDown(window, { key: 'k', metaKey: true })
  const palette = await screen.findByRole('dialog', { name: 'Search and commands' })
  await user().type(within(palette).getByRole('combobox'), 'kanban export')
  await screen.findByText('No results for ‘kanban export’')
  await user().keyboard('{Enter}')
  const dialog = await screen.findByRole('dialog', { name: 'New Task' })
  await vi.waitFor(() =>
    expect((within(dialog).getByLabelText('Description') as HTMLTextAreaElement).value).toBe(
      'kanban export',
    ),
  )
  expect(screen.queryByRole('dialog', { name: 'Search and commands' })).toBeNull()
  await user().click(within(dialog).getByRole('button', { name: 'Close' }))
})

test('App opens the planning chat selected in search with that plan’s content', async () => {
  const a = appState()
  const plan = {
    id: 'p1',
    factoryId: 'f1',
    factoryKey: 'NB',
    title: 'Offline editing',
    message: 'Plan the local note cache.',
    agent: 'claude' as const,
    status: 'queued' as const,
    createdAt,
    createdTasks: 0,
  }
  a.handle('listPlans', () => [plan])
  a.handle('getPlan', (id) => {
    expect(id).toBe('p1')
    return { plan, requests: [], tasks: [] }
  })
  a.handle('search', (query) => ({
    query,
    tasks: [],
    comments: [],
    plans: [{ planId: 'p1', factoryId: 'f1', title: plan.title, ended: false }],
    automations: [],
    factories: [],
  }))
  a.mount()
  await screen.findByRole('button', { name: 'widgets' })
  fireEvent.keyDown(window, { key: 'k', metaKey: true })
  const palette = await screen.findByRole('dialog', { name: 'Search and commands' })
  await user().type(within(palette).getByRole('combobox'), 'offline')
  await user().click(await within(palette).findByRole('option', { name: 'Offline editing' }))
  const chat = await screen.findByRole('region', { name: 'Planning chat' })
  await within(chat).findByText('Plan the local note cache.')
  expect(within(chat).getByRole('heading', { name: 'Offline editing' })).toBeTruthy()
  expect(a.request).toHaveBeenCalledWith('getPlan', 'p1')
  expect(screen.queryByRole('dialog', { name: 'Search and commands' })).toBeNull()
})

const conversationHit = {
  runId: 'r1',
  itemId: 'tool1',
  factoryId: 'f1',
  source: 'task' as const,
  ref: 'NB-1',
  title: 'Sync notes',
  runName: 'Previous Task Lead',
  kind: 'tool' as const,
  at: createdAt,
  snippet: 'unique output',
}

test('Conversation search reveals a tool, stays read-only and returns to the original results', async () => {
  const a = open({ conversations: [conversationHit] })
  let chat: RunChat = {
    run: {
      id: 'r1',
      name: 'Previous Task Lead',
      role: 'lead',
      agent: 'claude',
      state: 'working',
      current: false,
      startedAt: createdAt,
    },
    items: [
      {
        kind: 'tool',
        id: 'tool1',
        tool: 'Bash',
        title: 'Run tests',
        status: 'done',
        output: 'unique output',
      },
      {
        kind: 'human',
        id: 'queued',
        text: 'queued message',
        at: createdAt,
        sent: false,
        queued: true,
      },
      {
        kind: 'permission',
        id: 'permission',
        at: createdAt,
        request: {
          id: 'permission',
          taskId: 'NB-1',
          kind: 'permission',
          body: 'Please approve',
          author: { kind: 'run', runId: 'r1' },
          createdAt,
        },
      },
    ],
  }
  a.handle('getRunChat', () => chat)
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'unique' } })
  await screen.findByRole('option', { name: 'NB-1 unique output' })
  await user().keyboard('{Enter}')
  await screen.findByText('unique output', { selector: 'pre' })
  expect(screen.getByRole('button', { name: /Bash/ }).getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement?.getAttribute('data-chat-item')).toBe('tool1')
  expect(screen.queryByRole('textbox')).toBeNull()
  for (const label of [
    'Restart',
    'Stop Task',
    'Stop Run',
    'Send now',
    'Delete',
    'Approve',
    'Deny',
  ]) {
    expect(screen.queryByRole('button', { name: label })).toBeNull()
  }
  const jumps = vi.mocked(Element.prototype.scrollIntoView).mock.calls.length
  await act(async () => {
    chat = {
      ...chat,
      items: [...chat.items, { kind: 'agent', id: 'later', text: 'Later message' }],
    }
    a.emit({ type: 'run-output', runId: 'r1' })
  })
  expect(screen.getByText('Later message')).toBeTruthy()
  expect(vi.mocked(Element.prototype.scrollIntoView).mock.calls.length).toBe(jumps)
  await user().click(screen.getByRole('button', { name: '← Results' }))
  expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('unique')
  expect(screen.getByRole('option', { name: 'NB-1 unique output' })).toBeTruthy()
  expect(a.close).not.toHaveBeenCalled()
})

test('a vanished Conversation match explains what is missing; a deleted Run shows its error', async () => {
  const a = open({ conversations: [conversationHit] })
  a.handle('getRunChat', () => ({
    run: {
      id: 'r1',
      name: 'Old Run',
      role: 'lead',
      agent: 'claude',
      state: 'finished',
      current: false,
      startedAt: createdAt,
    },
    items: [],
  }))
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'unique' } })
  await user().click(await screen.findByRole('option', { name: 'NB-1 unique output' }))
  await screen.findByText(/The matching item is no longer available/)
  await user().click(screen.getByRole('button', { name: '← Results' }))
  a.handle('getRunChat', () => {
    throw new Error('no such Run')
  })
  await user().click(screen.getByRole('option', { name: 'NB-1 unique output' }))
  expect((await screen.findByRole('alert')).textContent).toContain('no such Run')
})
