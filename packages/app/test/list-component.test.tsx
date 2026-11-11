// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { appState } from './support/app.tsx'
import { required, user } from './support/component.ts'
import { createdAt, factory, task } from './support/fixtures.ts'

afterEach(() => vi.useRealTimers())

async function list() {
  const a = appState()
  a.state.factories.push(factory({ id: 'f2', key: 'MS', name: 'site', position: 1 }))
  a.state.tasks = [
    task({ title: 'Export notes', priority: 'low' }),
    task({ id: 'NB-2', displayId: 'NB-2', title: 'Sync notes', priority: 'high', rank: 2 }),
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
  await user().click(screen.getByRole('button', { name: 'widgets' }))
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
  expect(await main.findByRole('button', { name: /^Backlog/ })).toBeTruthy()
  expect(ids()).toEqual(['NB-2', 'NB-1', 'MS-1'])
  await u.click(main.getByRole('button', { name: 'Display' }))
  await u.hover(main.getByRole('menuitem', { name: /^Manual/ }))
  await u.click(main.getByRole('menuitemradio', { name: 'Title' }))
  await u.hover(main.getByRole('menuitem', { name: 'Stage' }))
  await u.click(main.getByRole('menuitemradio', { name: 'None' }))
  await u.click(main.getByRole('menuitemcheckbox', { name: 'Created by' }))
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(main.getByRole('columnheader', { name: 'Created by' })).toBeTruthy()
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
  await u.click(screen.getByRole('button', { name: 'widgets' }))
  await u.click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: 'List',
    }),
  )
  expect(ids()).toEqual(['NB-2', 'NB-1'])
  await u.type(main.getByRole('searchbox'), 'export')
  expect(ids()).toEqual(['NB-1'])
  expect(a.state.settings.listViews.all?.columns).toContain('created-by')
  a.unmount()
  a.mount()
  await u.click(await screen.findByRole('button', { name: 'All Tasks' }))
  await screen.findByText('Priority is High')
  expect(ids()).toEqual(['NB-2'])
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
  for (const id of ['NB-1', 'MS-1'])
    fireEvent.click(required(document.querySelector(`[data-task="${id}"]`)), { metaKey: true })
  const bar = within(screen.getByRole('toolbar', { name: 'Selected Tasks' }))
  expect(bar.getByText('2 selected')).toBeTruthy()
  await u.click(bar.getByRole('button', { name: 'Priority' }))
  await u.click(bar.getByRole('menuitem', { name: /^Urgent/ }))
  for (const id of ['NB-1', 'MS-1'])
    expect(a.request).toHaveBeenCalledWith('setPriority', id, 'urgent')
  await u.click(bar.getByRole('button', { name: 'Start' }))
  for (const id of ['NB-1', 'MS-1']) expect(a.request).toHaveBeenCalledWith('startTask', id)
  await u.click(bar.getByRole('button', { name: 'Archive' }))
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
  expect(main.getByRole('button', { name: /^Backlog/ })).toBeTruthy()
  expect(main.getByRole('button', { name: /^Intake/ })).toBeTruthy()
  await u.click(display())
  await u.click(toggle())
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(main.queryByRole('button', { name: /^Backlog/ })).toBeNull()
  await u.click(display())
  await u.click(toggle())
  fireEvent.keyDown(window, { key: 'Escape' })
  a.unmount()
  a.mount()
  await u.click(await screen.findByRole('button', { name: 'All Tasks' }))
  main = within(screen.getByRole('main'))
  expect(main.getByRole('button', { name: /^Intake/ })).toBeTruthy()
  await u.click(screen.getByRole('button', { name: 'widgets' }))
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
  const backlog = () => main.getByRole('button', { name: /^Backlog/ })
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

test('group checkboxes prepare Tasks with a one-time notice and keep bulk Resume and Archive', async () => {
  const a = await list()
  const u = user()
  const start = vi.fn()
  a.handle('startTask', start)
  a.handle('resumeTask', vi.fn())
  const main = within(screen.getByRole('main'))
  await u.click(main.getByRole('checkbox', { name: 'Select all Backlog Tasks' }))
  const bar = () => within(screen.getByRole('toolbar', { name: 'Selected Tasks' }))
  expect(bar().getByText('3 selected')).toBeTruthy()
  await u.click(main.getByRole('button', { name: /^Backlog/ }))
  await u.click(main.getByRole('checkbox', { name: 'Select all Backlog Tasks' }))
  expect(screen.queryByRole('toolbar', { name: 'Selected Tasks' })).toBeNull()
  await u.click(main.getByRole('checkbox', { name: 'Select all Backlog Tasks' }))
  expect(bar().getByText('3 selected')).toBeTruthy()
  await u.click(main.getByRole('button', { name: /^Backlog/ }))

  expect(bar().queryByRole('button', { name: 'Clear selection' })).toBeNull()
  await u.click(bar().getByRole('button', { name: 'Prepare through Design' }))
  const dialog = within(screen.getByRole('dialog'))
  expect(dialog.getByText(/Overnight mode/)).toBeTruthy()
  await u.click(dialog.getByRole('button', { name: 'Prepare 3 Tasks' }))
  for (const id of ['NB-1', 'NB-2', 'MS-1'])
    expect(a.request).toHaveBeenCalledWith('startTask', id, { prepare: true })
  expect(a.state.settings.preparationNoticeSeen).toBe(true)
  await u.click(bar().getByRole('button', { name: 'Prepare through Design' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(start).toHaveBeenCalledTimes(6)
  await u.click(main.getByRole('checkbox', { name: 'Select NB-1' }))
  expect(
    main.getByRole('checkbox', { name: 'Select all Backlog Tasks' }).getAttribute('aria-checked'),
  ).toBe('mixed')
  await u.keyboard('{Escape}')
  expect(screen.queryByRole('toolbar', { name: 'Selected Tasks' })).toBeNull()
  await a.emitTask(
    task({ status: { kind: 'stopped', prepared: true }, statuses: ['stopped'], stage: 'work' }),
  )
  await u.click(main.getByRole('checkbox', { name: 'Select all Work Tasks' }))
  await u.click(bar().getByRole('button', { name: 'Resume' }))
  expect(a.request).toHaveBeenCalledWith('resumeTask', 'NB-1')
  expect(bar().getByRole('button', { name: 'Archive' })).toBeTruthy()
})

test('the preparation explanation is shown only once, even when canceled', async () => {
  const a = await list()
  const u = user()
  a.handle('startTask', vi.fn())
  const group = screen.getByRole('checkbox', { name: 'Select all Backlog Tasks' })
  await u.click(group)
  const prepare = () => screen.getByRole('button', { name: 'Prepare through Design' })
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
