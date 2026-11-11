// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { CodeSection } from '../src/renderer/CodeSection.tsx'
import { ReposField } from '../src/renderer/views/ReposField.tsx'
import { TaskDetails } from '../src/renderer/views/TaskThread.tsx'
import { appState } from './support/app.tsx'
import { bridge, user } from './support/component.ts'
import { factory, task } from './support/fixtures.ts'

function handlers() {
  return {
    listApps: () => [],
    simulators: () => ({ supported: false }),
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
  expect(screen.getByText('ted/nb-1-sync')).toBeTruthy()
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
  expect(api.request).toHaveBeenCalledWith('setClarifyDepth', 'NB-1', 'few')
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
  await user().click(screen.getByRole('button', { name: 'Add blocker' }))
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
    expect(depth).toBe('few')
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
  await u.hover(screen.getByRole('menuitem', { name: /^Clarify depth/ }))
  await u.click(screen.getByRole('menuitemradio', { name: /Few/ }))
  await within(details).findByText('Few · set by you')
  await u.click(within(details).getByRole('button', { name: 'Add blocker' }))
  await u.type(screen.getByLabelText('Find a Task'), 'offline')
  await u.click(screen.getByRole('option', { name: /NB-2/ }))
  expect(within(details).getByText('Offline editing')).toBeTruthy()
  expect(screen.getAllByText(/Starts when NB-2 merges/)[0]).toBeTruthy()
  expect(a.request).toHaveBeenCalledWith('setClarifyDepth', 'NB-1', 'few')
  expect(a.request).toHaveBeenCalledWith('blockTask', 'NB-1', 'NB-2')
})
