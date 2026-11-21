// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { appState } from './support/app.tsx'
import { expandFactory, required, user } from './support/component.ts'
import { createdAt, factory, task } from './support/fixtures.ts'

afterEach(() => vi.useRealTimers())

async function list() {
  const a = appState()
  a.state.factories.push(factory({ id: 'f2', key: 'MS', name: 'site', position: 1 }))
  a.state.tasks = [
    task({ title: 'Export notes', priority: 'low', lead: { agent: 'claude' } }),
    task({
      id: 'NB-2',
      displayId: 'NB-2',
      title: 'Sync notes',
      priority: 'high',
      rank: 2,
      lead: { agent: 'codex' },
    }),
    task({ id: 'MS-1', displayId: 'MS-1', factoryId: 'f2', title: 'Pricing page' }),
  ]
  const mounted = a.mount()
  await user().click(await screen.findByRole('button', { name: 'All Tasks' }))
  return { ...a, unmount: mounted.unmount }
}
const ids = () =>
  [...document.querySelectorAll('tbody tr[data-task]')].map((e) => e.getAttribute('data-task'))

test('Started is the last column in both Lists and updates elapsed time', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const now = Date.parse('2026-11-11T12:00:00.000Z')
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const a = await list()
  await a.emitTask(
    task({ title: 'Export notes', startedAt: new Date(now - 120_000).toISOString() }),
  )
  const headers = () => [...document.querySelectorAll('thead th')].map((cell) => cell.textContent)
  const started = (id: string) =>
    required(document.querySelector(`[data-task="${id}"]`)).lastElementChild?.textContent
  expect(headers().slice(-2)).toEqual(['Updated', 'Started'])
  expect(started('NB-1')).toBe('2m')
  expect(started('NB-2')).toBe('—')
  try {
    vi.mocked(Date.now).mockReturnValue(now + 60_000)
    await act(async () => vi.advanceTimersByTime(30_000))
    expect(started('NB-1')).toBe('3m')
  } finally {
    vi.mocked(Date.now).mockRestore()
  }
  await expandFactory()
  await user().click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: 'Task views',
    }),
  )
  await user().click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: 'List',
    }),
  )
  expect(headers().slice(-2)).toEqual(['Updated', 'Started'])
  expect(started('NB-2')).toBe('—')
  a.unmount()
  vi.useRealTimers()
})

test('List display, grouping and filters update persisted settings per scope', async () => {
  const a = await list()
  const u = user()
  const main = within(screen.getByRole('main'))
  expect(await main.findByRole('button', { name: /^Backlog\s*\d/ })).toBeTruthy()
  expect(ids()).toEqual(['NB-2', 'NB-1', 'MS-1'])
  expect(main.queryByRole('columnheader', { name: 'Provider' })).toBeNull()
  await u.click(main.getByRole('button', { name: 'Display' }))
  await u.hover(main.getByRole('menuitem', { name: /^Manual/ }))
  await u.click(main.getByRole('menuitemradio', { name: 'Title' }))
  await u.hover(main.getByRole('menuitem', { name: 'Stage' }))
  await u.click(main.getByRole('menuitemradio', { name: 'None' }))
  await u.click(main.getByRole('menuitemcheckbox', { name: 'Created by' }))
  await u.click(main.getByRole('menuitemcheckbox', { name: 'Provider' }))
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(main.getByRole('columnheader', { name: 'Created by' })).toBeTruthy()
  expect(main.getByRole('columnheader', { name: 'Provider' })).toBeTruthy()
  const providers = [
    ['NB-1', 'Claude'],
    ['NB-2', 'Codex'],
    ['MS-1', 'Default'],
  ] as const
  for (const [id, provider] of providers) {
    const row = within(required(document.querySelector(`[data-task="${id}"]`)))
    expect(row.getByRole('cell', { name: provider })).toBeTruthy()
  }
  expect(ids()).toEqual(['NB-1', 'MS-1', 'NB-2'])
  await u.click(main.getByRole('button', { name: 'Filter' }))
  await u.hover(main.getByRole('menuitem', { name: 'Priority' }))
  await u.click(main.getByRole('menuitemcheckbox', { name: /High/ }))
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(ids()).toEqual(['NB-2'])
  expect(a.state.settings.listViews.all).toMatchObject({
    sort: 'title',
    group: 'none',
    filters: { priorities: ['high'] },
  })
  await expandFactory()
  await u.click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: 'Task views',
    }),
  )
  await u.click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: 'List',
    }),
  )
  expect(ids()).toEqual(['NB-2', 'NB-1'])
  expect(main.queryByRole('columnheader', { name: 'Provider' })).toBeNull()
  await u.type(main.getByRole('searchbox'), 'export')
  expect(ids()).toEqual(['NB-1'])
  expect(a.state.settings.listViews.all?.columns).toContain('created-by')
  a.unmount()
  a.mount()
  await u.click(await screen.findByRole('button', { name: 'All Tasks' }))
  await screen.findByText('Priority is High')
  expect(ids()).toEqual(['NB-2'])
  const reopened = within(screen.getByRole('main'))
  expect(reopened.getByRole('columnheader', { name: 'Provider' })).toBeTruthy()
  await u.click(reopened.getByRole('button', { name: 'Display' }))
  await u.click(reopened.getByRole('menuitemcheckbox', { name: 'Provider' }))
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(reopened.queryByRole('columnheader', { name: 'Provider' })).toBeNull()
  expect(a.state.settings.listViews.all?.columns).not.toContain('provider')
})

test('existing saved Lists gain Started and remember hiding it after remounting', async () => {
  const a = appState()
  a.state.tasks = [task()]
  a.state.settings.listViews = {
    all: { sort: 'title', group: 'none', columns: ['title', 'updated'], filters: {} },
  }
  const mounted = a.mount()
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'All Tasks' }))
  expect(screen.getByRole('columnheader', { name: 'Started' })).toBeTruthy()
  await u.click(screen.getByRole('button', { name: 'Display' }))
  await u.click(screen.getByRole('menuitemcheckbox', { name: 'Started' }))
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('columnheader', { name: 'Started' })).toBeNull()
  mounted.unmount()
  a.mount()
  await u.click(await screen.findByRole('button', { name: 'All Tasks' }))
  expect(screen.queryByRole('columnheader', { name: 'Started' })).toBeNull()
  expect(a.state.settings.listViews.all?.sort).toBe('title')
  await u.click(screen.getByRole('button', { name: 'Display' }))
  await u.click(screen.getByRole('menuitemcheckbox', { name: 'Started' }))
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.getByRole('columnheader', { name: 'Started' })).toBeTruthy()
})

test('bulk selection sends Priority, Start and Archive to each selected Task', async () => {
  const a = await list()
  const u = user()
  a.handle('setPriority', vi.fn())
  a.handle('startTask', vi.fn())
  a.handle('archiveTask', vi.fn())
  a.handle('deleteTask', vi.fn())
  for (const id of ['NB-1', 'MS-1'])
    fireEvent.click(required(document.querySelector(`[data-task="${id}"]`)), { metaKey: true })
  const bar = within(screen.getByRole('toolbar', { name: 'Selected Tasks' }))
  const more = async (name: string) => {
    await u.click(bar.getByRole('button', { name: 'More actions' }))
    await u.click(
      within(screen.getByRole('menu', { name: 'More actions' })).getByRole('menuitem', { name }),
    )
  }
  expect(bar.getByText('2 selected')).toBeTruthy()
  expect(bar.queryByRole('button', { name: 'Priority' })).toBeNull()
  expect(bar.queryByRole('button', { name: 'Snooze' })).toBeNull()
  const waitLine = () => document.querySelector('[data-wait-line]')?.textContent
  expect(waitLine()).toBeUndefined()
  await act(async () => a.emit({ type: 'slots-changed', slots: { ...a.state.slots, working: 2 } }))
  expect(waitLine()).toBe('1 starts now, 1 waits for a Run slot')
  fireEvent.pointerMove(required(document.querySelector('[data-task="NB-2"] td:last-child')))
  fireEvent.keyDown(window, { key: 'x' })
  expect(bar.getByText('3 selected')).toBeTruthy()
  expect(waitLine()).toBe('1 starts now, 2 wait for a Run slot')
  fireEvent.keyDown(window, { key: 'x' })
  expect(bar.getByText('2 selected')).toBeTruthy()
  await more('Snooze…')
  const snooze = await screen.findByRole('dialog', { name: 'Snooze 2 Tasks' })
  await u.click(within(snooze).getByRole('button', { name: 'Cancel' }))
  await more('Delete…')
  const confirm = await screen.findByRole('dialog', { name: 'Delete 2 Tasks?' })
  expect(a.request.mock.calls.some(([name]) => name === 'deleteTask')).toBe(false)
  await u.click(within(confirm).getByRole('button', { name: 'Delete 2 Tasks' }))
  for (const id of ['NB-1', 'MS-1'])
    await vi.waitFor(() => expect(a.request).toHaveBeenCalledWith('deleteTask', id, {}))
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await more('Priority')
  await u.click(
    within(screen.getByRole('menu', { name: 'Priority' })).getByRole('menuitem', {
      name: 'Urgent',
    }),
  )
  for (const id of ['NB-1', 'MS-1'])
    await vi.waitFor(() => expect(a.request).toHaveBeenCalledWith('setPriority', id, 'urgent'))
  await u.click(bar.getByRole('button', { name: 'Start' }))
  for (const id of ['NB-1', 'MS-1']) expect(a.request).toHaveBeenCalledWith('startTask', id)
  await u.click(bar.getByRole('button', { name: 'Archive…' }))
  await u.click(bar.getByRole('button', { name: 'Cancel' }))
  expect(bar.queryByRole('button', { name: 'Archive 2 Tasks' })).toBeNull()
  await u.click(bar.getByRole('button', { name: 'Archive…' }))
  await u.click(bar.getByRole('button', { name: 'Archive 2 Tasks' }))
  for (const id of ['NB-1', 'MS-1'])
    expect(a.request).toHaveBeenCalledWith('archiveTask', id, { closePullRequests: false })
  await a.emitTask(task({ archived: { at: createdAt, ended: { kind: 'never-started' } } }))
  await a.emitTask(
    task({
      id: 'MS-1',
      displayId: 'MS-1',
      factoryId: 'f2',
      title: 'Pricing page',
      archived: { at: createdAt, ended: { kind: 'never-started' } },
    }),
  )
  expect(ids()).toEqual(['NB-2'])
  await u.click(within(screen.getByRole('main')).getByRole('button', { name: 'Filter' }))
  await u.click(screen.getByRole('menuitemradio', { name: 'Only' }))
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.getByRole('columnheader', { name: 'Archived' })).toBeTruthy()
  expect(ids().sort()).toEqual(['MS-1', 'NB-1'])
  fireEvent.click(required(document.querySelector('[data-task="NB-1"]')), { metaKey: true })
  const archivedBar = within(screen.getByRole('toolbar', { name: 'Selected Tasks' }))
  expect(archivedBar.queryByRole('combobox', { name: 'Autopilot for selected Tasks' })).toBeNull()
  expect(archivedBar.queryByRole('button', { name: 'Archive…' })).toBeNull()
  await u.click(archivedBar.getByRole('button', { name: 'More actions' }))
  const archivedMore = within(screen.getByRole('menu', { name: 'More actions' }))
  expect(archivedMore.queryByRole('menuitem', { name: 'Priority' })).toBeNull()
  expect(archivedMore.getByRole('menuitem', { name: 'Delete…' })).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('menu', { name: 'More actions' }), { key: 'Escape' })
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('toolbar', { name: 'Selected Tasks' })).toBeNull()
})

test('Shift-click on a checkbox selects the range from the last chosen Task', async () => {
  await list()
  const order = ids()
  expect(order).toHaveLength(3)
  const [first, middle, last] = order
  const box = (id: string | null | undefined) =>
    screen.getByRole('checkbox', { name: `Select ${id}` })
  const checked = () => order.map((id) => box(id).matches(':checked'))
  fireEvent.click(box(last))
  fireEvent.click(box(first), { shiftKey: true })
  expect(checked()).toEqual([true, true, true])
  expect(
    within(screen.getByRole('toolbar', { name: 'Selected Tasks' })).getByText('3 selected'),
  ).toBeTruthy()
  fireEvent.click(box(middle))
  expect(checked()).toEqual([true, false, true])
  fireEvent.click(box(last), { shiftKey: true })
  expect(checked()).toEqual([false, true, true])
})

test('Show empty groups is saved per List and includes groups emptied by search', async () => {
  const a = await list()
  const u = user()
  let main = within(screen.getByRole('main'))
  const display = () => main.getByRole('button', { name: 'Display' })
  const toggle = () => main.getByRole('menuitemcheckbox', { name: 'Show empty groups' })
  expect(main.queryByRole('button', { name: /^Intake/ })).toBeNull()
  await u.click(display())
  expect(toggle().getAttribute('aria-checked')).toBe('false')
  await u.click(toggle())
  expect(a.state.settings.listViews.all?.showEmptyGroups).toBe(true)
  expect(main.getByRole('button', { name: /^Intake/ })).toBeTruthy()
  fireEvent.keyDown(window, { key: 'Escape' })
  await u.click(main.getByRole('button', { name: /^Filter/ }))
  await u.hover(main.getByRole('menuitem', { name: 'Priority' }))
  await u.click(main.getByRole('menuitemcheckbox', { name: /High/ }))
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(ids()).toEqual(['NB-2'])
  expect(main.getByRole('button', { name: /^Intake/ })).toBeTruthy()
  await u.click(main.getByRole('button', { name: /^Filter/ }))
  await u.hover(main.getByRole('menuitem', { name: 'Priority' }))
  await u.click(main.getByRole('menuitemcheckbox', { name: /High/ }))
  fireEvent.keyDown(window, { key: 'Escape' })
  await u.type(main.getByRole('searchbox'), 'no matching task')
  expect(ids()).toEqual([])
  expect(main.getByRole('button', { name: /^Backlog\s*\d/ })).toBeTruthy()
  expect(main.getByRole('button', { name: /^Intake/ })).toBeTruthy()
  await u.click(display())
  await u.click(toggle())
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(main.queryByRole('button', { name: /^Backlog\s*\d/ })).toBeNull()
  await u.click(display())
  await u.click(toggle())
  fireEvent.keyDown(window, { key: 'Escape' })
  a.unmount()
  a.mount()
  await u.click(await screen.findByRole('button', { name: 'All Tasks' }))
  main = within(screen.getByRole('main'))
  expect(main.getByRole('button', { name: /^Intake/ })).toBeTruthy()
  await expandFactory()
  await u.click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: 'Task views',
    }),
  )
  await u.click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: 'List',
    }),
  )
  expect(main.queryByRole('button', { name: /^Intake/ })).toBeNull()
  await u.click(display())
  await u.click(toggle())
  await u.hover(main.getByRole('menuitem', { name: 'Stage' }))
  await u.click(main.getByRole('menuitemradio', { name: 'Factory' }))
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(main.getByRole('rowgroup', { name: 'widgets' })).toBeTruthy()
  expect(main.queryByRole('rowgroup', { name: 'site' })).toBeNull()
  await u.click(display())
  await u.hover(main.getByRole('menuitem', { name: 'Factory' }))
  await u.click(main.getByRole('menuitemradio', { name: 'None' }))
  expect(toggle().hasAttribute('disabled')).toBe(true)
  expect(toggle().getAttribute('aria-checked')).toBe('true')
})

test('List groups remember closed and open choices through Inbox and remounting', async () => {
  const a = await list()
  await a.emitTask(task({ id: 'NB-3', displayId: 'NB-3', title: 'Finished work', stage: 'done' }))
  const u = user()
  const main = within(screen.getByRole('main'))
  const backlog = () => main.getByRole('button', { name: /^Backlog\s*\d/ })
  const done = () => main.getByRole('button', { name: /^Done/ })
  expect(done().getAttribute('aria-expanded')).toBe('false')
  await u.click(backlog())
  await u.click(done())
  expect(ids()).toEqual(['NB-3'])
  await u.click(screen.getByRole('button', { name: /^Inbox/ }))
  await u.click(screen.getByRole('button', { name: 'All Tasks' }))
  expect(backlog().getAttribute('aria-expanded')).toBe('false')
  expect(done().getAttribute('aria-expanded')).toBe('true')
  expect(ids()).toEqual(['NB-3'])
  await u.type(main.getByRole('searchbox'), 'no matching tasks')
  await u.clear(main.getByRole('searchbox'))
  expect(ids()).toEqual(['NB-3'])
  a.unmount()
  a.mount()
  await u.click(await screen.findByRole('button', { name: 'All Tasks' }))
  expect(backlog().getAttribute('aria-expanded')).toBe('false')
  expect(done().getAttribute('aria-expanded')).toBe('true')
})

test('right-click uses all selected Tasks; an unselected row and the Priority icon act on one Task', async () => {
  const a = await list()
  a.handle('setPriority', vi.fn())
  a.handle('setTaskLead', vi.fn())
  a.handle('setTaskAutopilot', vi.fn())
  await a.emitTask(
    task({ title: 'Export notes', priority: 'low', lead: { agent: 'codex', model: 'custom' } }),
  )
  const u = user()
  for (const id of ['NB-1', 'MS-1'])
    fireEvent.click(required(document.querySelector(`[data-task="${id}"]`)), { metaKey: true })
  fireEvent.contextMenu(required(document.querySelector('[data-task="NB-1"]')), {
    clientX: 50,
    clientY: 80,
  })
  let menu = await screen.findByRole('menu', { name: '2 selected Tasks' })
  await u.click(within(menu).getByRole('menuitem', { name: 'Priority' }))
  await u.click(
    within(screen.getByRole('menu', { name: 'Priority' })).getByRole('menuitem', {
      name: 'Urgent',
    }),
  )
  await vi.waitFor(() => {
    expect(a.request).toHaveBeenCalledWith('setPriority', 'NB-1', 'urgent')
    expect(a.request).toHaveBeenCalledWith('setPriority', 'MS-1', 'urgent')
  })
  expect(a.request).not.toHaveBeenCalledWith('setPriority', 'NB-2', 'urgent')
  expect(screen.getByRole('toolbar', { name: 'Selected Tasks' }).textContent).toContain(
    '2 selected',
  )
  expect(screen.queryByRole('region', { name: 'Task thread' })).toBeNull()
  fireEvent.contextMenu(required(document.querySelector('[data-task="NB-1"]')))
  menu = await screen.findByRole('menu', { name: '2 selected Tasks' })
  await u.click(within(menu).getByRole('menuitem', { name: 'Task Lead' }))
  await u.click(
    within(screen.getByRole('menu', { name: 'Task Lead' })).getByRole('menuitem', {
      name: 'Codex',
    }),
  )
  await vi.waitFor(() =>
    expect(a.request).toHaveBeenCalledWith('setTaskLead', 'MS-1', { agent: 'codex' }),
  )
  expect(a.request).not.toHaveBeenCalledWith('setTaskLead', 'NB-1', expect.anything())
  fireEvent.contextMenu(required(document.querySelector('[data-task="NB-1"]')))
  menu = await screen.findByRole('menu', { name: '2 selected Tasks' })
  await u.click(within(menu).getByRole('menuitem', { name: 'Autopilot' }))
  await u.click(
    within(screen.getByRole('menu', { name: 'Autopilot' })).getByRole('menuitem', {
      name: 'Autopilot off',
    }),
  )
  await vi.waitFor(() => {
    expect(a.request).toHaveBeenCalledWith('setTaskAutopilot', 'NB-1', { choice: 'off' })
    expect(a.request).toHaveBeenCalledWith('setTaskAutopilot', 'MS-1', { choice: 'off' })
  })
  fireEvent.contextMenu(required(document.querySelector('[data-task="NB-2"]')))
  menu = await screen.findByRole('menu', { name: 'Task actions · NB-2' })
  expect(within(menu).getByRole('menuitem', { name: /^Edit title/ })).toBeTruthy()
  expect(screen.queryByRole('menu', { name: '2 selected Tasks' })).toBeNull()
  fireEvent.keyDown(menu, { key: 'Escape' })
  expect(screen.queryByRole('menu', { name: 'Task actions · NB-2' })).toBeNull()
  await u.click(screen.getByRole('button', { name: 'Priority: High. Change priority of NB-2' }))
  menu = await screen.findByRole('menu', { name: 'Priority' })
  const options = within(menu).getAllByRole('menuitemradio')
  expect(options.map((option) => option.textContent)).toEqual([
    'No priority0',
    'Urgent1',
    'High2',
    'Medium3',
    'Low4',
  ])
  expect(options.map((option) => option.getAttribute('aria-checked'))).toEqual([
    'false',
    'false',
    'true',
    'false',
    'false',
  ])
  fireEvent.keyDown(menu, { key: '1' })
  await vi.waitFor(() => expect(a.request).toHaveBeenCalledWith('setPriority', 'NB-2', 'urgent'))
  await vi.waitFor(() => expect(screen.queryByRole('menu', { name: 'Priority' })).toBeNull())
  expect(screen.queryByRole('region', { name: 'Task thread' })).toBeNull()
  await u.click(screen.getByRole('button', { name: 'Priority: Low. Change priority of NB-1' }))
  await u.click(
    within(await screen.findByRole('menu', { name: 'Priority' })).getByRole('menuitemradio', {
      name: /Medium/,
    }),
  )
  await vi.waitFor(() => expect(a.request).toHaveBeenCalledWith('setPriority', 'NB-1', 'medium'))
  expect(a.request).not.toHaveBeenCalledWith('setPriority', 'MS-1', 'medium')
})

test('bulk context-menu Archive confirms the group and lists the Tasks it unblocks', async () => {
  const a = await list()
  a.handle('archiveTask', vi.fn())
  await a.emitTask(
    task({ id: 'NB-2', displayId: 'NB-2', title: 'Sync notes', blockedBy: ['NB-1'] }),
  )
  for (const id of ['NB-1', 'MS-1'])
    fireEvent.click(required(document.querySelector(`[data-task="${id}"]`)), { metaKey: true })
  const row = required(document.querySelector<HTMLElement>('[data-task="NB-1"]'))
  row.focus()
  fireEvent.keyDown(row, { key: 'F10', shiftKey: true })
  const menu = await screen.findByRole('menu', { name: '2 selected Tasks' })
  await user().click(within(menu).getByRole('menuitem', { name: 'Archive…' }))
  const dialog = await screen.findByRole('dialog', { name: 'Archive 2 Tasks?' })
  expect(a.request.mock.calls.some(([name]) => name === 'archiveTask')).toBe(false)
  const unblocks = within(dialog).getByRole('region', { name: 'Unblocks 1 Task' })
  expect(within(unblocks).getByText('Sync notes')).toBeTruthy()
  expect(within(dialog).queryByRole('radio')).toBeNull()
  await user().click(within(dialog).getByRole('button', { name: 'Archive 2 Tasks' }))
  for (const id of ['NB-1', 'MS-1'])
    await vi.waitFor(() =>
      expect(a.request).toHaveBeenCalledWith('archiveTask', id, { closePullRequests: false }),
    )
})

test('group checkboxes prepare Tasks with a one-time notice and keep bulk Resume and Archive', async () => {
  const a = await list()
  const u = user()
  const start = vi.fn()
  a.handle('startTask', start)
  a.handle('resumeTask', vi.fn())
  const main = within(screen.getByRole('main'))
  const around = (name: string) => required(main.getByRole('checkbox', { name }).closest('label'))
  await u.click(around('Select all Backlog Tasks'))
  const bar = () => within(screen.getByRole('toolbar', { name: 'Selected Tasks' }))
  expect(bar().getByText('3 selected')).toBeTruthy()
  await u.click(main.getByRole('button', { name: /^Backlog\s*\d/ }))
  await u.click(main.getByRole('checkbox', { name: 'Select all Backlog Tasks' }))
  expect(screen.queryByRole('toolbar', { name: 'Selected Tasks' })).toBeNull()
  await u.click(main.getByRole('checkbox', { name: 'Select all Backlog Tasks' }))
  expect(bar().getByText('3 selected')).toBeTruthy()
  await u.click(main.getByRole('button', { name: /^Backlog\s*\d/ }))

  expect(bar().queryByRole('button', { name: 'Clear selection' })).toBeNull()
  await u.click(bar().getByRole('button', { name: 'Prepare' }))
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByText(/Autopilot/)).toBeTruthy()
  await u.click(dialog.getByRole('button', { name: 'Prepare 3 Tasks' }))
  for (const id of ['NB-1', 'NB-2', 'MS-1'])
    expect(a.request).toHaveBeenCalledWith('startTask', id, { prepare: true })
  expect(a.state.settings.preparationNoticeSeen).toBe(true)
  await u.click(bar().getByRole('button', { name: 'Prepare' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(start).toHaveBeenCalledTimes(6)
  await u.click(around('Select NB-1'))
  expect(
    main.getByRole('checkbox', { name: 'Select all Backlog Tasks' }).getAttribute('aria-checked'),
  ).toBe('mixed')
  await u.keyboard('{Escape}')
  expect(screen.queryByRole('toolbar', { name: 'Selected Tasks' })).toBeNull()
  await a.emitTask(
    task({ status: { kind: 'stopped', prepared: true }, statuses: ['stopped'], stage: 'work' }),
  )
  await u.click(main.getByRole('checkbox', { name: 'Select all Work Tasks' }))
  expect(bar().queryByRole('button', { name: 'Prepare' })).toBeNull()
  await u.click(bar().getByRole('button', { name: 'Resume' }))
  expect(a.request).toHaveBeenCalledWith('resumeTask', 'NB-1')
  expect(bar().getByRole('button', { name: 'Archive…' })).toBeTruthy()
  await u.click(main.getByRole('checkbox', { name: 'Select all Backlog Tasks' }))
  expect(bar().getByText('3 selected')).toBeTruthy()
  await u.click(bar().getByRole('button', { name: 'Start 2 · Resume 1' }))
  for (const id of ['NB-2', 'MS-1']) expect(a.request).toHaveBeenCalledWith('startTask', id)
  expect(a.request.mock.calls.filter(([name]) => name === 'resumeTask')).toHaveLength(2)
})

test('the preparation explanation is shown only once, even when canceled', async () => {
  const a = await list()
  const u = user()
  a.handle('startTask', vi.fn())
  const group = screen.getByRole('checkbox', { name: 'Select all Backlog Tasks' })
  await u.click(group)
  const prepare = () => screen.getByRole('button', { name: 'Prepare' })
  await u.click(prepare())
  await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
  expect(a.state.settings.preparationNoticeSeen).toBe(true)
  expect(a.request.mock.calls.filter(([name]) => name === 'startTask')).toHaveLength(0)
  await u.click(prepare())
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(a.request.mock.calls.filter(([name]) => name === 'startTask')).toHaveLength(3)
  await u.click(group)
  await u.type(within(screen.getByRole('main')).getByRole('searchbox'), 'export')
  await u.click(group)
  expect(screen.getByRole('toolbar', { name: 'Selected Tasks' }).textContent).toContain(
    '1 selected',
  )
  await u.click(prepare())
  expect(a.request.mock.calls.filter(([name]) => name === 'startTask')).toHaveLength(4)
  expect(a.request).toHaveBeenLastCalledWith('startTask', 'NB-1', { prepare: true })
})

test('selected Ready for Work Tasks offer both Resume and Stop in their context menu', async () => {
  const a = await list()
  a.handle('stopTask', vi.fn())
  for (const id of ['NB-1', 'NB-2']) {
    await a.emitTask(
      task({
        id,
        displayId: id,
        stage: 'work',
        preparation: 'ready',
        statuses: ['stopped'],
        status: { kind: 'stopped', at: '2026-11-11T00:00:00Z', prepared: true },
      }),
    )
    fireEvent.click(required(document.querySelector(`[data-task="${id}"]`)), { metaKey: true })
  }
  fireEvent.contextMenu(required(document.querySelector('[data-task="NB-1"]')))
  const menu = await screen.findByRole('menu', { name: '2 selected Tasks' })
  expect(within(menu).getByRole('menuitem', { name: 'Resume' })).toBeTruthy()
  await user().click(within(menu).getByRole('menuitem', { name: 'Stop Task' }))
  await vi.waitFor(() => {
    expect(a.request).toHaveBeenCalledWith('stopTask', 'NB-1')
    expect(a.request).toHaveBeenCalledWith('stopTask', 'NB-2')
  })
})

test.each(['Archive', 'Delete'])(
  'bulk %s keeps a later Task failure visible inside its confirmation',
  async (label) => {
    const a = await list()
    const method = label === 'Archive' ? 'archiveTask' : 'deleteTask'
    a.handle(
      method,
      vi.fn(async (id: unknown) => {
        if (id === 'MS-1') throw new Error('Request refused')
      }),
    )
    for (const id of ['NB-1', 'MS-1'])
      fireEvent.click(required(document.querySelector(`[data-task="${id}"]`)), { metaKey: true })
    fireEvent.contextMenu(required(document.querySelector('[data-task="NB-1"]')))
    await user().click(
      within(await screen.findByRole('menu', { name: '2 selected Tasks' })).getByRole('menuitem', {
        name: `${label}…`,
      }),
    )
    const dialog = await screen.findByRole('dialog', { name: `${label} 2 Tasks?` })
    await user().click(within(dialog).getByRole('button', { name: `${label} 2 Tasks` }))
    const error = await within(dialog).findByRole('alert')
    expect(error.textContent).toContain('MS-1: Request refused')
    expect(error.textContent).toContain('Some selected Tasks may already have changed.')
    expect(a.request).toHaveBeenCalledWith(method, 'NB-1', expect.anything())
    expect(a.request).toHaveBeenCalledWith(method, 'MS-1', expect.anything())
  },
)

test('bulk Stop Task identifies a later Task failure and stops before the next Task', async () => {
  const a = await list()
  a.handle(
    'stopTask',
    vi.fn(async (id: unknown) => {
      if (id === 'NB-2') throw new Error('Stop refused')
    }),
  )
  for (const current of [...a.state.tasks]) {
    await a.emitTask({
      ...current,
      stage: 'work',
      preparation: 'ready',
      statuses: ['stopped'],
      status: { kind: 'stopped', at: '2026-11-11T00:00:00Z', prepared: true },
    })
    fireEvent.click(required(document.querySelector(`[data-task="${current.id}"]`)), {
      metaKey: true,
    })
  }
  fireEvent.contextMenu(required(document.querySelector('[data-task="NB-1"]')))
  const menu = await screen.findByRole('menu', { name: '3 selected Tasks' })
  expect(within(menu).queryByRole('menuitem', { name: 'Restart' })).toBeNull()
  await user().click(within(menu).getByRole('menuitem', { name: 'Stop Task' }))
  const error = await screen.findByRole('alert')
  expect(error.textContent).toContain('NB-2: Stop refused')
  expect(error.textContent).toContain('Some selected Tasks may already have changed.')
  expect(a.request).toHaveBeenCalledWith('stopTask', 'NB-1')
  expect(a.request).toHaveBeenCalledWith('stopTask', 'NB-2')
  expect(a.request).not.toHaveBeenCalledWith('stopTask', 'MS-1')
})

test('bulk Autopilot keeps successful changes and selects only failed Tasks for retry', async () => {
  const a = await list()
  const u = user()
  const set = vi.fn(async (id: unknown) => {
    if (id === 'NB-2') throw new Error('Could not save this Task')
  })
  a.handle('setTaskAutopilot', set)
  for (const id of ['NB-1', 'NB-2', 'MS-1'])
    fireEvent.click(required(document.querySelector(`[data-task="${id}"]`)), { metaKey: true })
  await u.selectOptions(screen.getByLabelText('Autopilot for selected Tasks'), 'on')
  await screen.findByText(/NB-2: Could not save this Task/)
  for (const id of ['NB-1', 'MS-1']) {
    const saved = required(a.state.tasks.find((t) => t.id === id))
    await a.emitTask({ ...saved, autopilot: { choice: 'on', enabled: true } })
  }
  expect(set.mock.calls.map(([id]) => id).sort()).toEqual(['MS-1', 'NB-1', 'NB-2'])
  for (const id of ['NB-1', 'NB-2', 'MS-1'])
    expect(a.request).toHaveBeenCalledWith('setTaskAutopilot', id, { choice: 'on' })
  expect(screen.getByText('1 selected')).toBeTruthy()
  expect(
    within(required(document.querySelector('[data-task="NB-1"]'))).getByText('Autopilot on'),
  ).toBeTruthy()
  expect(
    within(required(document.querySelector('[data-task="MS-1"]'))).getByText('Autopilot on'),
  ).toBeTruthy()
  expect(screen.getByRole('checkbox', { name: 'Select NB-2' })).toHaveProperty('checked', true)
  expect(screen.getByRole('checkbox', { name: 'Select NB-1' })).toHaveProperty('checked', false)
  set.mockClear()
  a.handle('setTaskAutopilot', set.mockResolvedValue(undefined))
  await u.selectOptions(screen.getByLabelText('Autopilot for selected Tasks'), 'on')
  await screen.findByText(/Updated 1 Tasks/)
  expect(set.mock.calls.map(([id]) => id)).toEqual(['NB-2'])
})

test('with Nest child Tasks on, a child reorders among its siblings and a top-level row among top-level rows', async () => {
  const a = appState()
  const at = (id: string, rank: number, fields: Parameters<typeof task>[0] = {}) =>
    task({ id, displayId: id, title: `Task ${id}`, rank, ...fields })
  a.state.tasks = [
    at('NB-1', 1, { childIds: ['NB-2', 'NB-3'] }),
    at('NB-2', 2, { parentId: 'NB-1' }),
    at('NB-3', 3, { parentId: 'NB-1' }),
    at('NB-4', 4),
  ]
  a.handle('moveTask', vi.fn())
  a.mount()
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'All Tasks' }))
  const main = within(screen.getByRole('main'))
  await u.click(main.getByRole('button', { name: 'Display' }))
  await u.click(main.getByRole('menuitemcheckbox', { name: 'Nest child Tasks' }))
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(ids()).toEqual(['NB-1', 'NB-2', 'NB-3', 'NB-4'])

  const row = (id: string) => required(document.querySelector<HTMLElement>(`[data-task="${id}"]`))
  expect(row('NB-3').getAttribute('draggable')).toBe('true')
  expect(row('NB-3').title).toBe('')
  const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
  // jsdom has no DragEvent, and its rows measure zero high, so clientY 0 is the top half.
  const drag = (element: HTMLElement, type: string) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY: 0 })
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    fireEvent(element, event)
  }
  const dragOnto = (moving: string, target: string) => {
    drag(row(moving), 'dragstart')
    drag(row(target), 'dragover')
    drag(row(target), 'drop')
  }

  dragOnto('NB-3', 'NB-2')
  await vi.waitFor(() =>
    expect(a.request).toHaveBeenCalledWith('moveTask', 'NB-3', { before: 'NB-2' }),
  )
  dragOnto('NB-2', 'NB-4')
  await vi.waitFor(() =>
    expect(a.request).toHaveBeenCalledWith('moveTask', 'NB-2', { after: 'NB-3' }),
  )
  dragOnto('NB-4', 'NB-1')
  await vi.waitFor(() =>
    expect(a.request).toHaveBeenCalledWith('moveTask', 'NB-4', { before: 'NB-1' }),
  )
})

test('the Blocked by link in a row opens the blocker, not the row’s Task', async () => {
  const a = appState()
  a.state.tasks = [
    task({
      title: 'Export notes',
      blockedBy: ['NB-2'],
      status: { kind: 'blocked', by: 'NB-2' },
    }),
    task({ id: 'NB-2', displayId: 'NB-2', title: 'Sync notes', rank: 2 }),
  ]
  a.mount()
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'All Tasks' }))
  const row = required(document.querySelector<HTMLElement>('[data-task="NB-1"]'))
  await u.click(within(row).getByRole('button', { name: 'NB-2' }))
  expect(await screen.findByRole('heading', { level: 1, name: 'Sync notes' })).toBeTruthy()
  expect(screen.queryByRole('heading', { level: 1, name: 'Export notes' })).toBeNull()
})
