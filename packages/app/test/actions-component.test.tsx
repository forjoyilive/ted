// @vitest-environment jsdom

import type { Task, TaskMovePlan } from '@ted/protocol'
import { movePlanKey } from '@ted/protocol/task-move'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  ArchiveDialog,
  DeleteDialog,
  openMovedTaskEvent,
} from '../src/renderer/components/ArchiveDialogs.tsx'
import { TaskActionsMenu } from '../src/renderer/components/TaskActions.tsx'
import { OvernightContext } from '../src/renderer/overnight.tsx'
import { DataScreen } from '../src/renderer/views/DataScreen.tsx'
import { EditTaskDialog } from '../src/renderer/views/EditTaskDialog.tsx'
import { appState } from './support/app.tsx'
import { bridge, expandFactory, user } from './support/component.ts'
import { createdAt, factory, task } from './support/fixtures.ts'

const blocked = task({
  id: 'NB-2',
  displayId: 'NB-2',
  title: 'Highlight search matches',
  blockedBy: ['NB-1'],
})

test('Archive lists the Tasks it unblocks without asking about them', async () => {
  const api = bridge({ listTasks: () => [task(), blocked], archiveTask: vi.fn() })
  const close = vi.fn()
  render(<ArchiveDialog task={task()} onClose={close} />)
  const list = await screen.findByRole('region', { name: 'Unblocks 1 Task' })
  expect(within(list).getByText('Highlight search matches')).toBeTruthy()
  expect(
    within(list).getByText('Ted removes NB-1 from its Blocked by. It doesn’t start on its own.'),
  ).toBeTruthy()
  expect(screen.queryByRole('radio')).toBeNull()
  await user().click(screen.getByRole('button', { name: 'Archive' }))
  expect(api.request).toHaveBeenCalledWith('archiveTask', 'NB-1', { closePullRequests: false })
  expect(close).toHaveBeenCalledOnce()
})

test('Delete offers Archive instead and lists the Tasks it unblocks', async () => {
  const archive = vi.fn()
  const close = vi.fn()
  const api = bridge({
    listTasks: () => [task(), blocked],
    listTaskRuns: () => [],
    deleteTask: vi.fn(),
  })
  render(<DeleteDialog task={task()} onClose={close} onArchiveInstead={archive} />)
  await screen.findByRole('region', { name: 'Unblocks 1 Task' })
  expect(screen.queryByRole('radio')).toBeNull()
  expect(screen.getByText(/This can’t be undone/)).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Archive instead' }))
  expect(archive).toHaveBeenCalledOnce()
  await user().click(screen.getByRole('button', { name: 'Delete NB-1' }))
  expect(api.request).toHaveBeenCalledWith('deleteTask', 'NB-1', {})
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
  expect(screen.getByRole('heading', { name: 'Ted couldn’t update its data' })).toBeTruthy()
  expect(screen.getByText('Rebuild stopped at event 42 of 100')).toBeTruthy()
  expect(screen.getByText('Error: Bad event')).toBeTruthy()
  expect(screen.getByText(/Loses changes since.*when Ted 0.0.1 last ran/)).toBeTruthy()
  expect(screen.getByText(/Runs keep going in the background/)).toBeTruthy()
  expect(
    screen.getByRole('button', { name: 'Restore the backup from before the update' }),
  ).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Copy report' }))
  expect(api.request).toHaveBeenCalledWith('copyText', expect.stringContaining('Bad event'))
  await user().click(screen.getByRole('button', { name: 'Quit Ted' }))
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
  expect(screen.getByText('Setup isn’t finished. This Task will use Ted’s defaults.')).toBeTruthy()
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
  await expandFactory()
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
  await u.click(await screen.findByRole('button', { name: 'Start NB-1' }))
  const notice = await screen.findByRole('dialog', { name: 'Start NB-1?' })
  expect(a.request.mock.calls.filter(([name]) => name === 'startTask')).toEqual([])
  await u.click(within(notice).getByRole('button', { name: 'Open setup Task' }))
  expect((await screen.findByRole('region', { name: 'Task thread' })).textContent).toContain(
    'Set up widgets',
  )
  expect(a.request.mock.calls.filter(([name]) => name === 'startTask')).toEqual([])
  expect(a.state.tasks.find((t) => t.id === 'NB-1')?.stage).toBe('backlog')
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
    expect(choices).toEqual({})
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
  expect(a.request).toHaveBeenCalledWith('deleteTask', 'NB-1', {})
})

test('Task actions opens and chooses actions without opening the enclosing Task', async () => {
  const open = vi.fn()
  const api = bridge({ setPriority: vi.fn(), setTaskAutopilot: vi.fn() })
  await act(async () => {
    render(
      <table>
        <tbody>
          <tr onClick={open} onKeyDown={() => undefined} tabIndex={0}>
            <td>
              <TaskActionsMenu task={task({ autopilot: { choice: 'off', enabled: false } })} />
            </td>
          </tr>
        </tbody>
      </table>,
    )
  })
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'Task actions' }))
  expect(screen.getByRole('menu', { name: /Task actions/ })).toBeTruthy()
  expect(screen.queryByRole('menuitem', { name: /^Reset…/ })).toBeNull()
  expect(open).not.toHaveBeenCalled()
  for (const gone of ['Full brief', 'Copy Task ID', 'Priority', 'Task Lead', 'Set parent…'])
    expect(screen.queryByRole('menuitem', { name: gone })).toBeNull()
  await u.click(screen.getByRole('menuitem', { name: 'Parent and children' }))
  const family = screen.getByRole('menu', { name: 'Parent and children' })
  expect(within(family).getByRole('menuitem', { name: 'Create child…' })).toBeTruthy()
  expect(within(family).getByRole('menuitem', { name: 'Set parent…' })).toBeTruthy()
  await u.click(screen.getByRole('menuitem', { name: 'Settings' }))
  const settings = screen.getByRole('menu', { name: 'Settings' })
  expect(within(settings).getByText('Task Lead')).toBeTruthy()
  expect(within(settings).getByRole('menuitemradio', { name: 'Few' })).toBeTruthy()
  expect(within(settings).queryByRole('menuitemradio', { name: 'Autopilot off' })).toBeNull()
  await u.click(within(settings).getByRole('menuitemradio', { name: 'Urgent' }))
  expect(api.request).toHaveBeenCalledWith('setPriority', 'NB-1', 'urgent')
  await vi.waitFor(() => expect(screen.queryByRole('menu', { name: /Task actions/ })).toBeNull())
  await u.click(screen.getByRole('button', { name: 'Task actions' }))
  const autopilotItem = screen.getByRole('menuitem', { name: 'Autopilot' })
  expect(autopilotItem.textContent).toContain('Off')
  await u.click(autopilotItem)
  const autopilot = screen.getByRole('menu', { name: 'Autopilot' })
  expect(within(autopilot).getByRole('menuitemradio', { name: 'Autopilot off' }).ariaChecked).toBe(
    'true',
  )
  expect(
    within(autopilot).getByRole('menuitemradio', { name: 'Use global setting (Off)' }),
  ).toBeTruthy()
  await u.click(within(autopilot).getByRole('menuitemradio', { name: 'Autopilot on' }))
  expect(api.request).toHaveBeenCalledWith('setTaskAutopilot', 'NB-1', { choice: 'on' })
  expect(open).not.toHaveBeenCalled()
})

test.each([
  [true, 'On'],
  [false, 'Off'],
])('a Task that follows global Autopilot (%s) shows Global (%s)', async (on, label) => {
  bridge({})
  await act(async () => {
    render(
      <OvernightContext value={{ on, openGeneral: () => undefined }}>
        <TaskActionsMenu task={task()} />
      </OvernightContext>,
    )
  })
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'Task actions' }))
  const autopilotItem = screen.getByRole('menuitem', { name: 'Autopilot' })
  expect(autopilotItem.textContent).toContain(`Global (${label})`)
  await u.click(autopilotItem)
  const autopilot = screen.getByRole('menu', { name: 'Autopilot' })
  expect(
    within(autopilot).getByRole('menuitemradio', { name: `Use global setting (${label})` })
      .ariaChecked,
  ).toBe('true')
})

test.each([
  ['Done', task({ stage: 'done' })],
  ['archived', task({ archived: { at: createdAt, ended: { kind: 'never-started' } } })],
])('a %s Task has no Autopilot entry', async (_kind, ended) => {
  bridge({})
  await act(async () => {
    render(<TaskActionsMenu task={ended} />)
  })
  await user().click(await screen.findByRole('button', { name: 'Task actions' }))
  expect(screen.getByRole('menu', { name: /Task actions/ })).toBeTruthy()
  expect(screen.queryByRole('menuitem', { name: 'Autopilot' })).toBeNull()
  expect(screen.queryByText('Autopilot')).toBeNull()
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

test.each([false, true])(
  'a context-only Task menu reports a refused action (archived: %s)',
  async (archived) => {
    const refused = () => Promise.reject(new Error('Refused'))
    bridge({ setPriority: refused, unarchiveTask: refused })
    const u = user()
    const trigger = document.createElement('button')
    render(
      <TaskActionsMenu
        task={task(
          archived ? { archived: { at: createdAt, ended: { kind: 'never-started' } } } : {},
        )}
        contextOnly
        contextAt={{ x: 20, y: 20, trigger }}
      />,
    )
    if (archived) {
      expect(screen.queryByRole('menuitem', { name: 'Copy Task ID' })).toBeNull()
      await u.click(await screen.findByRole('menuitem', { name: 'Unarchive' }))
    } else {
      await u.click(await screen.findByRole('menuitem', { name: 'Settings' }))
      await u.click(screen.getByRole('menuitemradio', { name: 'Urgent' }))
    }
    expect((await screen.findByRole('alert')).textContent).toBe('Refused')
    expect(screen.queryByRole('menu')).toBeNull()
  },
)

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

test('Reset lists what is lost and kept for a started Task, and sends the reset', async () => {
  const started = task({
    stage: 'validate',
    attachments: [{ hash: 'h', name: 'spec.png', size: 1, mediaType: 'image/png' }],
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
      } as Task['repos'][number],
    ],
  })
  const api = bridge({
    listTasks: () => [started],
    listTaskRuns: () => [],
    resetTask: vi.fn(),
  })
  await act(async () => {
    render(<TaskActionsMenu task={started} />)
  })
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'Task actions' }))
  await u.click(screen.getByRole('menuitem', { name: /^Reset…/ }))
  const dialog = await screen.findByRole('dialog', { name: 'Reset NB-1?' })
  const lost = within(dialog)
    .getAllByRole('listitem')
    .map((item) => item.textContent)
  expect(lost).toEqual([
    'The worktree and any uncommitted work in it',
    'The branch ted/nb-1-sync-notes and its commits, here and on GitHub',
    'Pull request widgets #212, which Ted closes on GitHub',
    'The thread: comments, questions and answers, the Task brief and findings',
    'Edits to the description, and files attached in comments',
  ])
  expect(
    within(dialog).getByText(/^Kept: .*the original description and its attachment\.$/),
  ).toBeTruthy()
  await u.click(within(dialog).getByRole('button', { name: 'Reset Task' }))
  expect(api.request).toHaveBeenCalledWith('resetTask', 'NB-1')
})

test('a Task at Merge with a merged pull request shows Reset greyed out and offers Mark as Done', async () => {
  const api = bridge({
    markDone: () => {
      throw new Error('acme/widgets#7 is still open on GitHub')
    },
  })
  api.handle('listFactories', () => [
    factory(),
    factory({ id: 'web', key: 'WEB', name: 'Website' }),
  ])
  const merged = task({ stage: 'merge', statuses: ['partly-merged'] })
  await act(async () => {
    render(<TaskActionsMenu task={merged} />)
  })
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'Task actions' }))
  const move = await screen.findByRole('menuitem', { name: /^Move to Factory…/ })
  expect(move.getAttribute('aria-disabled')).toBe('true')
  expect(move.textContent).toContain('A pull request has merged')
  const item = screen.getByRole('menuitem', { name: /^Reset…/ })
  expect(item.getAttribute('aria-disabled')).toBe('true')
  expect(item.textContent).toContain('A pull request has merged')
  await u.click(screen.getByRole('menuitem', { name: 'Mark as Done' }))
  expect(api.request).toHaveBeenCalledWith('markDone', merged.id)
  expect((await screen.findByRole('alert')).textContent).toBe(
    'acme/widgets#7 is still open on GitHub',
  )
})

test('Move to Factory shows the plan for the picked Factory, moves the Task and opens it under its new ID', async () => {
  const website = factory({ id: 'web', key: 'WEB', name: 'Website', position: 1 })
  const backlog = task({ title: 'Tag notes from the share sheet' })
  const plan: TaskMovePlan = {
    factoryId: 'web',
    factoryName: 'Website',
    repos: ['website'],
    tasks: [
      {
        id: 'NB-1',
        displayId: 'NB-1',
        title: backlog.title,
        newDisplayId: 'WEB-41',
        stage: 'backlog',
        lands: 'backlog',
        startsLead: false,
        worktrees: 0,
        branches: [],
        pullRequests: [],
        openRequests: 0,
        unlinked: [],
      },
    ],
  }
  const api = bridge({
    listTasks: () => [backlog],
    listFactories: () => [factory(), website],
    taskMovePlan: () => plan,
    moveTaskToFactory: () => ({
      task: { ...backlog, displayId: 'WEB-41', factoryId: 'web' },
      moved: [{ id: 'NB-1', from: 'NB-1', to: 'WEB-41' }],
    }),
  })
  const opened: Task[] = []
  const open = (event: Event) => {
    if (event instanceof CustomEvent) opened.push(event.detail)
  }
  window.addEventListener(openMovedTaskEvent, open)
  await act(async () => {
    render(<TaskActionsMenu task={backlog} />)
  })
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'Task actions' }))
  await u.click(await screen.findByRole('menuitem', { name: 'Move to Factory…' }))
  const dialog = await screen.findByRole('dialog', { name: 'Move NB-1 to another Factory?' })
  expect(within(dialog).getByRole('button', { name: 'Move' }).hasAttribute('disabled')).toBe(true)
  await u.click(within(dialog).getByRole('combobox', { name: 'Factory' }))
  expect(within(dialog).getAllByRole('option')).toHaveLength(1)
  await u.click(within(dialog).getByRole('option', { name: 'Website' }))
  expect((await within(dialog).findByText(/^NB-1 becomes/)).textContent).toBe(
    'NB-1 becomes WEB-41 in Backlog. Nothing starts until you start it.',
  )
  expect(within(dialog).getByRole('region', { name: 'What changes' }).textContent).toContain(
    'Repos becomes Website’s: website',
  )
  await u.click(within(dialog).getByRole('button', { name: 'Move to Website' }))
  expect(api.request).toHaveBeenCalledWith('moveTaskToFactory', 'NB-1', {
    factoryId: 'web',
    planKey: movePlanKey(plan),
  })
  await expect.poll(() => opened.map((t) => t.displayId)).toEqual(['WEB-41'])
  expect(screen.queryByRole('dialog')).toBeNull()
  window.removeEventListener(openMovedTaskEvent, open)
})
