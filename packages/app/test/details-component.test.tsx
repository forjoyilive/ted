// @vitest-environment jsdom
import type { RunSummary } from '@ted/protocol'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { CodeSection } from '../src/renderer/CodeSection.tsx'
import { ChangesSection } from '../src/renderer/components/ChangesSection.tsx'
import { pickBlockerEvent, TaskActionsMenu } from '../src/renderer/components/TaskActions.tsx'
import { ReposField } from '../src/renderer/views/ReposField.tsx'
import { TaskDetails } from '../src/renderer/views/TaskThread.tsx'
import { appState } from './support/app.tsx'
import { bridge, deferred, user } from './support/component.ts'
import { factory, task } from './support/fixtures.ts'

function handlers() {
  return {
    listApps: () => [],
    simulators: () => ({ supported: false }),
    emulators: () => ({ supported: false }),
    listTaskRuns: () => [],
    taskDescriptions: () => [],
    taskGates: () => ({ rows: [], overrides: {}, revision: 'v1' }),
    listComments: () => [],
    taskBrief: () => null,
  }
}

test('Code moves from no worktree to branch and path', () => {
  const t = task()
  const view = render(<CodeSection task={t} onOpenShell={vi.fn()} />)
  expect(screen.getByText('No worktree yet')).toBeTruthy()
  view.rerender(
    <CodeSection
      task={task({
        branch: 'ted/nb-1-sync',
        repos: [
          {
            name: 'widgets',
            repo: 'acme/widgets',
            branch: 'ted/nb-1-sync',
            worktree: '/work/NB-1/widgets',
            copied: [],
            skipped: [],
          },
        ],
      })}
      onOpenShell={vi.fn()}
    />,
  )
  expect(screen.getByText('ted/nb-1-sync', { selector: 'code' })).toBeTruthy()
  expect(screen.getByText('/work/NB-1/widgets')).toBeTruthy()
})

test('Task details sends Priority and human Clarify depth changes', async () => {
  const api = bridge({ ...handlers(), setPriority: vi.fn(), setClarifyDepth: vi.fn() })
  const t = task()
  render(
    <TaskDetails
      task={t}
      tasks={[t]}
      factories={[factory()]}
      onOpenRun={vi.fn()}
      onOpenShell={vi.fn()}
    />,
  )
  const u = user()
  await u.selectOptions(screen.getByLabelText('Priority'), 'high')
  await u.selectOptions(screen.getByLabelText('Clarify depth'), 'few')
  expect(api.request).toHaveBeenCalledWith('setPriority', 'NB-1', 'high')
  expect(api.request).toHaveBeenCalledWith('setClarifyDepth', 'NB-1', { depth: 'few' })
  expect(screen.queryByRole('list', { name: 'Repos' })).toBeNull()
})

test('Repos selects by owner/repo and sends the full chosen set', async () => {
  const api = bridge({ setTaskRepos: () => ({ task: task() }) })
  const f = factory({
    repos: [
      { name: 'widgets', repo: 'acme/widgets' },
      { name: 'api', repo: 'acme/api' },
    ],
  })
  render(<ReposField task={task({ chosenRepos: ['acme/widgets'] })} factory={f} />)
  const list = within(screen.getByRole('list', { name: 'Repos' }))
  expect((list.getByLabelText('widgets') as HTMLInputElement).checked).toBe(true)
  expect((list.getByLabelText('api') as HTMLInputElement).checked).toBe(false)
  await user().click(list.getByLabelText('api'))
  expect(api.request).toHaveBeenCalledWith('setTaskRepos', 'NB-1', {
    set: ['acme/widgets', 'acme/api'],
    confirm: false,
  })
})

test('Blocked by sends add/remove requests and displays a rejected cycle', async () => {
  const api = bridge({
    ...handlers(),
    blockTask: () => {
      throw new Error('NB-2 can’t block NB-1: that makes a cycle, NB-1 → NB-2 → NB-1')
    },
    unblockTask: vi.fn(),
  })
  const t = task()
  const other = task({ id: 'NB-2', displayId: 'NB-2', title: 'Offline editing' })
  const view = render(
    <TaskDetails
      task={t}
      tasks={[t, other]}
      factories={[factory()]}
      onOpenRun={vi.fn()}
      onOpenShell={vi.fn()}
    />,
  )
  await user().click(screen.getByRole('button', { name: 'Add blocker…' }))
  await user().type(screen.getByLabelText('Find a Task'), 'offline')
  await user().click(screen.getByRole('option', { name: /NB-2/ }))
  expect(api.request).toHaveBeenCalledWith('blockTask', 'NB-1', 'NB-2')
  await screen.findByText('NB-2 can’t block NB-1: that makes a cycle, NB-1 → NB-2 → NB-1')
  view.rerender(
    <TaskDetails
      task={task({ blockedBy: ['NB-2'] })}
      tasks={[t, other]}
      factories={[factory()]}
      onOpenRun={vi.fn()}
      onOpenShell={vi.fn()}
    />,
  )
  await user().click(screen.getByRole('button', { name: 'Remove NB-2' }))
  expect(api.request).toHaveBeenCalledWith('unblockTask', 'NB-1', 'NB-2')
})

test('Blocked by dismisses on outside clicks while keeping search and selection usable', async () => {
  const api = bridge({ ...handlers(), blockTask: () => task(), unblockTask: vi.fn() })
  const t = task()
  const other = task({ id: 'NB-2', displayId: 'NB-2', title: 'Offline editing' })
  render(
    <>
      <TaskActionsMenu task={t} />
      <TaskDetails
        task={t}
        tasks={[t, other]}
        factories={[factory()]}
        onOpenRun={vi.fn()}
        onOpenShell={vi.fn()}
      />
    </>,
  )
  const u = user()
  await u.click(screen.getByRole('button', { name: 'Task actions' }))
  await u.click(screen.getByRole('menuitem', { name: /^Blocked by/ }))
  await u.click(screen.getByLabelText('Find a Task'))
  await u.type(screen.getByLabelText('Find a Task'), 'offline')
  expect(screen.getByRole('option', { name: /NB-2/ })).toBeTruthy()
  await u.click(screen.getByLabelText('Priority'))
  expect(screen.queryByRole('listbox', { name: 'Tasks' })).toBeNull()
  expect(screen.queryByLabelText('Find a Task')).toBeNull()
  expect(
    api.request.mock.calls.filter(([name]) => name === 'blockTask' || name === 'unblockTask'),
  ).toEqual([])

  await u.click(screen.getByRole('button', { name: 'Add blocker…' }))
  await u.keyboard('{Escape}')
  expect(screen.queryByRole('listbox', { name: 'Tasks' })).toBeNull()
  await u.click(screen.getByRole('button', { name: 'Task actions' }))
  await u.click(screen.getByRole('menuitem', { name: /^Blocked by/ }))
  await u.click(screen.getByRole('option', { name: /NB-2/ }))
  expect(api.request).toHaveBeenCalledWith('blockTask', 'NB-1', 'NB-2')
  expect(screen.queryByRole('listbox', { name: 'Tasks' })).toBeNull()
})

test('Task details keeps a saved additional repo selected after the Task update', async () => {
  const a = appState()
  a.state.factories = [
    factory({
      repos: [
        { name: 'widgets', repo: 'acme/widgets' },
        { name: 'api', repo: 'acme/api' },
      ],
    }),
  ]
  a.state.tasks = [task()]
  a.handle('setTaskRepos', async (id, input) => {
    expect(id).toBe('NB-1')
    expect(input).toEqual({ set: ['acme/widgets', 'acme/api'], confirm: false })
    const updated = task({ chosenRepos: ['acme/widgets', 'acme/api'] })
    a.state.tasks = [updated]
    a.emit({ type: 'task-updated', task: updated })
    return { task: updated }
  })
  a.mount()
  await user().click(await screen.findByRole('button', { name: 'All Tasks' }))
  await user().click(within(screen.getByRole('main')).getByText('Sync notes'))
  const details = await screen.findByRole('complementary', { name: 'Task details' })
  const repos = within(within(details).getByRole('list', { name: 'Repos' }))
  await user().click(repos.getByLabelText('api'))
  await vi.waitFor(() =>
    expect((repos.getByLabelText('api') as HTMLInputElement).checked).toBe(true),
  )
  expect((repos.getByLabelText('widgets') as HTMLInputElement).checked).toBe(true)
  expect(a.request).toHaveBeenCalledWith('setTaskRepos', 'NB-1', {
    set: ['acme/widgets', 'acme/api'],
    confirm: false,
  })
})

test('Task details displays saved Priority, menu depth attribution and a successful blocker', async () => {
  const a = appState()
  const other = task({ id: 'NB-2', displayId: 'NB-2', title: 'Offline editing' })
  let current = task()
  a.state.tasks = [current, other]
  a.handle('setPriority', async (_id, priority) => {
    expect(priority).toBe('high')
    current = { ...current, priority: 'high' }
    a.state.tasks = [current, other]
    a.emit({ type: 'task-updated', task: current })
    return current
  })
  a.handle('setClarifyDepth', async (_id, depth) => {
    expect(depth).toEqual({ depth: 'few' })
    current = { ...current, clarifyDepth: 'few', clarifyDepthBy: 'human' }
    a.state.tasks = [current, other]
    a.emit({ type: 'task-updated', task: current })
    return current
  })
  a.handle('blockTask', async (_id, blocker) => {
    expect(blocker).toBe('NB-2')
    current = {
      ...current,
      blockedBy: ['NB-2'],
      activity: 'Starts when NB-2 merges',
      markers: [{ kind: 'blocked-by', by: 'NB-2' }],
      status: { kind: 'blocked', by: 'NB-2' },
      statuses: ['blocked'],
    }
    a.state.tasks = [current, other]
    a.emit({ type: 'task-updated', task: current })
    return current
  })
  a.mount()
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'All Tasks' }))
  await u.click(within(screen.getByRole('main')).getByText('Sync notes'))
  const details = await screen.findByRole('complementary', { name: 'Task details' })
  await u.selectOptions(within(details).getByLabelText('Priority'), 'high')
  expect((within(details).getByLabelText('Priority') as HTMLSelectElement).value).toBe('high')
  await u.click(screen.getByRole('button', { name: 'Task actions' }))
  await u.click(screen.getByRole('menuitem', { name: 'Settings' }))
  await u.click(screen.getByRole('menuitemradio', { name: /Few/ }))
  await within(details).findByText('Few · set by you')
  await u.click(within(details).getByRole('button', { name: 'Add blocker…' }))
  await u.type(screen.getByLabelText('Find a Task'), 'offline')
  await u.click(screen.getByRole('option', { name: /NB-2/ }))
  expect(within(details).getByText('Offline editing')).toBeTruthy()
  expect(screen.getAllByText(/Starts when NB-2 merges/)[0]).toBeTruthy()
  expect(a.request).toHaveBeenCalledWith('setClarifyDepth', 'NB-1', { depth: 'few' })
  expect(a.request).toHaveBeenCalledWith('blockTask', 'NB-1', 'NB-2')
})

test('Task details shows six icon tabs, marks changes, working Runs and live Apps, and keeps the last tab for the next Task', async () => {
  const working: RunSummary = {
    id: 'r1',
    taskId: 'NB-1',
    name: 'Task Lead',
    agent: 'claude',
    role: 'lead',
    state: 'working',
    current: true,
    startedAt: new Date().toISOString(),
  }
  bridge({
    ...handlers(),
    listTaskRuns: (id: unknown) => (id === 'NB-1' ? [working] : []),
    listApps: (...args) =>
      args[0] === 'NB-1' ? [{ repo: 'widgets', name: 'Web', kind: 'web', state: 'running' }] : [],
  })
  const t = task({
    branch: 'ted/nb-1-sync',
    repos: [
      {
        name: 'widgets',
        repo: 'acme/widgets',
        branch: 'ted/nb-1-sync',
        worktree: '/work/NB-1/widgets',
        copied: [],
        skipped: [],
        pullRequest: {
          number: 27,
          url: 'https://github.com/acme/widgets/pull/27',
          base: 'main',
          state: 'ready',
        },
      },
    ],
  })
  const other = task({ id: 'NB-2', displayId: 'NB-2', title: 'Offline editing' })
  const changes = (
    <ChangesSection
      onOpen={vi.fn()}
      changes={{
        taskId: 'NB-1',
        files: 2,
        repos: [
          {
            name: 'widgets',
            baseBranch: 'main',
            added: 3,
            removed: 1,
            files: [
              { path: 'src/sync.ts', added: 2, removed: 1, uncommitted: false },
              { path: 'README.md', added: 1, removed: 0, uncommitted: true },
            ],
          },
        ],
      }}
    />
  )
  const props = {
    tasks: [t, other],
    factories: [factory()],
    onOpenRun: vi.fn(),
    onOpenShell: vi.fn(),
  }
  const view = render(<TaskDetails task={t} changes={changes} changeCount={2} {...props} />)
  const tab = (name: string) => screen.getByRole('tab', { name })
  expect(
    within(screen.getByRole('tablist', { name: 'Task details sections' }))
      .getAllByRole('tab')
      .map((el) => el.getAttribute('aria-label')),
  ).toEqual(['Details', 'Code', 'Changes', 'Files', 'Runs', 'Apps'])
  expect(tab('Details').getAttribute('aria-selected')).toBe('true')
  expect(tab('Runs').textContent).toBe('Runs⌥5')
  const details = screen.getByRole('tabpanel', { name: 'Details' })
  expect(within(details).getByRole('heading', { level: 2 }).textContent).toBe('Details')
  expect(within(details).getByLabelText('Priority')).toBeTruthy()
  expect(tab('Changes').getAttribute('aria-description')).toBe('2 files changed')
  await vi.waitFor(() =>
    expect(tab('Runs').getAttribute('aria-description')).toBe('A Run is working'),
  )
  await vi.waitFor(() =>
    expect(tab('Apps').getAttribute('aria-description')).toBe('An App is running'),
  )

  const u = user()
  await u.click(tab('Code'))
  const code = screen.getByRole('tabpanel', { name: 'Code' })
  expect(within(code).getByText('PR #27 · open')).toBeTruthy()
  expect(within(code).getByRole('button', { name: 'Shell' })).toBeTruthy()
  expect(screen.queryByRole('tabpanel', { name: 'Details' })).toBeNull()

  await u.keyboard('{ArrowRight}')
  expect(document.activeElement).toBe(tab('Changes'))
  expect(
    within(screen.getByRole('tabpanel', { name: 'Changes' })).getByText('2 files'),
  ).toBeTruthy()
  await u.keyboard('{End}')
  expect(tab('Apps').getAttribute('aria-selected')).toBe('true')
  await u.keyboard('{Home}')
  await u.keyboard('{ArrowLeft}')
  expect(document.activeElement).toBe(tab('Apps'))
  await u.click(tab('Runs'))
  expect(
    within(screen.getByRole('tabpanel', { name: 'Runs' })).getByText(/^Task Lead working/),
  ).toBeTruthy()

  view.rerender(<TaskDetails task={other} {...props} />)
  const runs = await screen.findByRole('tabpanel', { name: 'Runs' })
  expect(within(runs).getByText('No Runs yet')).toBeTruthy()
  await vi.waitFor(() => expect(tab('Runs').getAttribute('aria-description')).toBeNull())
  await vi.waitFor(() => expect(tab('Apps').getAttribute('aria-description')).toBeNull())
  expect(tab('Changes').getAttribute('aria-description')).toBeNull()

  act(() => {
    window.dispatchEvent(new CustomEvent(pickBlockerEvent, { detail: 'NB-2' }))
  })
  expect(tab('Details').getAttribute('aria-selected')).toBe('true')
  expect(await screen.findByLabelText('Find a Task')).toBeTruthy()
})

test('blocker changes keep pending feedback and reject repeats until completion', async () => {
  const adding = deferred<ReturnType<typeof task>>()
  const removing = deferred<ReturnType<typeof task>>()
  const block = vi.fn(() => adding.promise)
  const unblock = vi.fn(() => removing.promise)
  bridge({ ...handlers(), blockTask: block, unblockTask: unblock })
  const t = task()
  const other = task({ id: 'NB-2', displayId: 'NB-2', title: 'Offline editing' })
  const view = render(
    <TaskDetails
      task={t}
      tasks={[t, other]}
      factories={[factory()]}
      onOpenRun={vi.fn()}
      onOpenShell={vi.fn()}
    />,
  )
  await user().click(screen.getByRole('button', { name: 'Add blocker…' }))
  await user().type(screen.getByLabelText('Find a Task'), 'offline')
  const option = screen.getByRole('option', { name: /NB-2/ })
  await user().click(option)
  expect(option.getAttribute('aria-busy')).toBe('true')
  expect(screen.getByRole('listbox', { name: 'Tasks' })).toBeTruthy()
  fireEvent.click(option)
  fireEvent.keyDown(screen.getByLabelText('Find a Task'), { key: 'Enter' })
  expect(block).toHaveBeenCalledOnce()
  await act(async () => adding.reject(new Error('A blocker cycle was rejected')))
  expect(screen.getByRole('alert').textContent).toBe('A blocker cycle was rejected')
  expect(screen.queryByRole('listbox', { name: 'Tasks' })).toBeNull()
  view.rerender(
    <TaskDetails
      task={task({ blockedBy: ['NB-2'] })}
      tasks={[t, other]}
      factories={[factory()]}
      onOpenRun={vi.fn()}
      onOpenShell={vi.fn()}
    />,
  )
  const remove = screen.getByRole('button', { name: 'Remove NB-2' })
  await user().click(remove)
  expect(remove.getAttribute('aria-busy')).toBe('true')
  fireEvent.click(remove)
  expect(unblock).toHaveBeenCalledOnce()
  await act(async () => removing.resolve(t))
  expect(remove.getAttribute('aria-busy')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})
