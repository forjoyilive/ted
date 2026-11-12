// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ArchiveDialog, DeleteDialog } from '../src/renderer/components/ArchiveDialogs.tsx'
import { TaskActionsMenu } from '../src/renderer/components/TaskActions.tsx'
import { DataScreen } from '../src/renderer/views/DataScreen.tsx'
import { EditTaskDialog } from '../src/renderer/views/EditTaskDialog.tsx'
import { appState } from './support/app.tsx'
import { bridge, user } from './support/component.ts'
import { task } from './support/fixtures.ts'

const blocked = task({
  id: 'NB-2',
  displayId: 'NB-2',
  title: 'Highlight search matches',
  blockedBy: ['NB-1'],
})

test('Archive defaults to unblock, allows Keep blocked, and sends the choice', async () => {
  const api = bridge({ listTasks: () => [task(), blocked], archiveTask: vi.fn() })
  const close = vi.fn()
  render(<ArchiveDialog task={task()} onClose={close} />)
  await screen.findByText('1 Task is blocked by NB-1')
  expect(screen.getByText('Highlight search matches')).toBeTruthy()
  expect((screen.getByRole('radio', { name: /^Unblock it/ }) as HTMLInputElement).checked).toBe(
    true,
  )
  await user().click(screen.getByRole('radio', { name: /^Keep it blocked/ }))
  await user().click(screen.getByRole('button', { name: 'Archive' }))
  expect(api.request).toHaveBeenCalledWith('archiveTask', 'NB-1', {
    closePullRequests: false,
    blocked: 'keep',
  })
  expect(close).toHaveBeenCalledOnce()
})

test('Delete offers Archive instead and sends its unblock choice', async () => {
  const archive = vi.fn()
  const close = vi.fn()
  const api = bridge({
    listTasks: () => [task(), blocked],
    listTaskRuns: () => [],
    deleteTask: vi.fn(),
  })
  render(<DeleteDialog task={task()} onClose={close} onArchiveInstead={archive} />)
  await screen.findByText('1 Task is blocked by NB-1')
  expect(screen.getByText(/This can’t be undone/)).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Archive instead' }))
  expect(archive).toHaveBeenCalledOnce()
  await user().click(screen.getByRole('button', { name: 'Delete NB-1' }))
  expect(api.request).toHaveBeenCalledWith('deleteTask', 'NB-1', { blocked: 'unblock' })
  expect(close).toHaveBeenCalledOnce()
})

test('Edit Task focuses description, sends only changed fields and supports command Enter', async () => {
  const close = vi.fn()
  const api = bridge({ editTask: vi.fn() })
  render(<EditTaskDialog task={task()} onClose={close} />)
  expect(document.activeElement).toBe(screen.getByLabelText('Description'))
  expect((screen.getByRole('button', { name: /Save/ }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Description'), {
    target: { value: 'In titles and bodies.' },
  })
  fireEvent.keyDown(screen.getByLabelText('Description'), { key: 'Enter', metaKey: true })
  await vi.waitFor(() =>
    expect(api.request).toHaveBeenCalledWith('editTask', 'NB-1', {
      description: 'In titles and bodies.',
    }),
  )
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
})

test('failed data rebuild shows its stopping event and error with Copy report and Quit', async () => {
  const api = bridge({ copyText: vi.fn(), quit: vi.fn() })
  render(
    <DataScreen
      status={{
        state: 'failed',
        version: '9.0.0',
        done: 41,
        total: 100,
        error: 'Bad event',
        restore: {
          name: 'before-update',
          kind: 'pre-update',
          takenAt: '2026-11-09T12:00:00.000Z',
          takenBy: '0.0.1',
          dataFrom: '0.0.1',
        },
      }}
    />,
  )
  expect(screen.getByRole('heading', { name: 'TED couldn’t update its data' })).toBeTruthy()
  expect(screen.getByText('Rebuild stopped at event 42 of 100')).toBeTruthy()
  expect(screen.getByText('Error: Bad event')).toBeTruthy()
  expect(screen.getByText(/Loses changes since.*when TED 0.0.1 last ran/)).toBeTruthy()
  expect(screen.getByText(/Runs keep going in the background/)).toBeTruthy()
  expect(
    screen.getByRole('button', { name: 'Restore the backup from before the update' }),
  ).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Copy report' }))
  expect(api.request).toHaveBeenCalledWith('copyText', expect.stringContaining('Bad event'))
  await user().click(screen.getByRole('button', { name: 'Quit TED' }))
  expect(api.request).toHaveBeenCalledWith('quit')
})

test('unfinished setup offers Open setup Task or Start anyway without starting on inspection', async () => {
  const { SetupNoticeDialog } = await import('../src/renderer/components/SetupNoticeDialog.tsx')
  const start = vi.fn()
  const cancel = vi.fn()
  const open = vi.fn()
  const setup = task({ id: 'NB-0', displayId: 'NB-0', setup: true, title: 'Set up widgets' })
  render(
    <SetupNoticeDialog
      task={task()}
      notice={{ kind: 'open', task: setup }}
      onStart={start}
      onCancel={cancel}
      onOpenTask={open}
    />,
  )
  expect(screen.getByText('Setup isn’t finished. This Task will use TED’s defaults.')).toBeTruthy()
  expect(start).not.toHaveBeenCalled()
  await user().click(screen.getByRole('button', { name: 'Open setup Task' }))
  expect(open).toHaveBeenCalledWith(setup)
  expect(cancel).toHaveBeenCalledOnce()
  await user().click(screen.getByRole('button', { name: 'Start anyway' }))
  expect(start).toHaveBeenCalledOnce()
})

test('App opens unfinished setup without starting, then starts the ordinary Task only on Start anyway', async () => {
  const a = appState()
  const setup = task({
    id: 'NB-0',
    displayId: 'NB-0',
    setup: true,
    title: 'Set up widgets',
    stage: 'work',
  })
  a.state.tasks = [task(), setup]
  a.handle('factoryBoard', () => ({
    stages: [
      { id: 'backlog', enabled: true, gate: false },
      { id: 'work', enabled: true, gate: false },
    ],
  }))
  a.handle('startTask', async (id) => {
    expect(id).toBe('NB-1')
    const started = task({ stage: 'intake', title: 'Sync notes started' })
    await a.emitTask(started)
    return started
  })
  a.mount()
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'widgets' }))
  await user().click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: 'Board',
    }),
  )
  await u.click(await screen.findByRole('button', { name: 'Start NB-1' }))
  const notice = await screen.findByRole('dialog', { name: 'Start NB-1?' })
  expect(a.request.mock.calls.filter(([name]) => name === 'startTask')).toEqual([])
  await u.click(within(notice).getByRole('button', { name: 'Open setup Task' }))
  expect((await screen.findByRole('region', { name: 'Task thread' })).textContent).toContain(
    'Set up widgets',
  )
  expect(a.request.mock.calls.filter(([name]) => name === 'startTask')).toEqual([])
  expect(a.state.tasks.find((t) => t.id === 'NB-1')?.stage).toBe('backlog')
  await u.click(screen.getByRole('button', { name: 'widgets' }))
  await user().click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: 'Board',
    }),
  )
  await u.click(await screen.findByRole('button', { name: 'Start NB-1' }))
  await u.click(
    within(screen.getByRole('dialog', { name: 'Start NB-1?' })).getByRole('button', {
      name: 'Start anyway',
    }),
  )
  await screen.findByText('Sync notes started')
  expect(a.request).toHaveBeenCalledWith('startTask', 'NB-1')
  expect(a.request.mock.calls.filter(([name]) => name === 'startTask')).toHaveLength(1)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Start NB-1' })).toBeNull()
})

test('App switches Delete to Archive, cancels it, then removes the deleted Task from the List', async () => {
  const a = appState()
  a.state.tasks = [task(), blocked]
  a.handle('search', (query) => ({
    query,
    tasks: [],
    comments: [],
    plans: [],
    automations: [],
    factories: [],
  }))
  a.handle('deleteTask', (id, choices) => {
    expect(id).toBe('NB-1')
    expect(choices).toEqual({ blocked: 'unblock' })
    a.state.tasks = [task({ ...blocked, blockedBy: [] })]
    a.emit({ type: 'task-deleted', taskId: 'NB-1' })
    a.emit({ type: 'task-updated', task: task({ ...blocked, blockedBy: [] }) })
  })
  a.mount()
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'All Tasks' }))
  await u.click(within(screen.getByRole('main')).getByText('Sync notes'))
  await screen.findByRole('region', { name: 'Task thread' })
  async function openDelete() {
    await u.click(screen.getByRole('button', { name: 'Task actions' }))
    await u.click(screen.getByRole('menuitem', { name: /^Delete…/ }))
    return screen.findByRole('dialog', { name: 'Delete NB-1?' })
  }

  await u.click(within(await openDelete()).getByRole('button', { name: 'Archive instead' }))
  const archive = await screen.findByRole('dialog', { name: 'Archive NB-1?' })
  expect(screen.queryByRole('dialog', { name: 'Delete NB-1?' })).toBeNull()
  await u.click(within(archive).getByRole('button', { name: 'Cancel' }))
  expect(
    a.request.mock.calls.some(([name]) => name === 'archiveTask' || name === 'deleteTask'),
  ).toBe(false)
  await u.click(within(await openDelete()).getByRole('button', { name: 'Delete NB-1' }))
  await u.click(screen.getByRole('button', { name: 'All Tasks' }))
  await vi.waitFor(() => expect(document.querySelector('tr[data-task="NB-1"]')).toBeNull())
  expect(document.querySelector('tr[data-task="NB-2"]')?.textContent).toContain(
    'Highlight search matches',
  )
  expect(document.querySelector('tr[data-task="NB-2"]')?.textContent).not.toContain('Blocked')
  expect(a.request).toHaveBeenCalledWith('deleteTask', 'NB-1', { blocked: 'unblock' })
})

test('Task actions opens and chooses actions without opening the enclosing Task', async () => {
  const open = vi.fn()
  const api = bridge({ setPriority: vi.fn() })
  await act(async () => {
    render(
      <table>
        <tbody>
          <tr onClick={open} onKeyDown={() => undefined} tabIndex={0}>
            <td>
              <TaskActionsMenu task={task()} />
            </td>
          </tr>
        </tbody>
      </table>,
    )
  })
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'Task actions' }))
  expect(screen.getByRole('menu', { name: /Task actions/ })).toBeTruthy()
  expect(open).not.toHaveBeenCalled()
  await u.click(screen.getByRole('menuitem', { name: /^Priority/ }))
  await u.click(screen.getByRole('menuitemradio', { name: 'Urgent' }))
  expect(api.request).toHaveBeenCalledWith('setPriority', 'NB-1', 'urgent')
  expect(open).not.toHaveBeenCalled()
})

test('Task menu keyboard navigation reaches choices, dismisses and restores focus', async () => {
  bridge({ setPriority: vi.fn() })
  await act(async () => {
    render(<TaskActionsMenu task={task()} />)
  })
  const trigger = await screen.findByRole('button', { name: 'Task actions' })
  await user().click(trigger)
  const menu = screen.getByRole('menu', { name: /Task actions/ })
  expect(document.activeElement?.textContent).toContain('Start')
  fireEvent.keyDown(document.activeElement ?? menu, { key: 'End' })
  expect(document.activeElement?.textContent).toContain('Delete')
  fireEvent.keyDown(document.activeElement ?? menu, { key: 'Home' })
  expect(document.activeElement?.textContent).toContain('Start')
  fireEvent.keyDown(document.activeElement ?? menu, { key: 'Escape' })
  expect(screen.queryByRole('menu', { name: /Task actions/ })).toBeNull()
  expect(document.activeElement).toBe(trigger)
})

test('Ready for Work keeps Resume and offers a manual Stop to exclude Overnight pickup', async () => {
  const ready = task({
    stage: 'work',
    preparation: 'ready',
    statuses: ['stopped'],
    status: { kind: 'stopped', at: '2026-11-11T00:00:00Z', prepared: true },
  })
  const api = bridge({ stopTask: vi.fn() })
  const view = await act(async () => render(<TaskActionsMenu task={ready} />))
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'Task actions' }))
  expect(screen.getByRole('menuitem', { name: /^Resume/ })).toBeTruthy()
  await u.click(screen.getByRole('menuitem', { name: 'Stop Task' }))
  expect(api.request).toHaveBeenCalledWith('stopTask', ready.id)
  await act(async () => {
    view.rerender(
      <TaskActionsMenu
        task={task({
          stage: 'work',
          statuses: ['stopped'],
          status: { kind: 'stopped', at: '2026-11-11T00:00:01Z' },
        })}
      />,
    )
  })
  await u.click(await screen.findByRole('button', { name: 'Task actions' }))
  expect(screen.getByRole('menuitem', { name: /^Resume/ })).toBeTruthy()
  expect(screen.queryByRole('menuitem', { name: 'Stop Task' })).toBeNull()
})
