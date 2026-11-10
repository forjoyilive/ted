// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { appState } from './support/app.tsx'
import { required, user } from './support/component.ts'
import { createdAt, factory, task } from './support/fixtures.ts'

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
