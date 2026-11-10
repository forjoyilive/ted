// @vitest-environment jsdom
import type { ListFilters } from '@ted/protocol'
import { render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { Help } from '../src/renderer/components/Help.tsx'
import { Board } from '../src/renderer/views/Board.tsx'
import { bridge, required, user } from './support/component.ts'
import { factory, task } from './support/fixtures.ts'

function props() {
  return {
    title: 'widgets',
    factoryId: 'f1',
    factory: factory(),
    tasks: [],
    factories: [factory()],
    queue: [],
    filters: {} as ListFilters,
    onFilters: vi.fn(),
    onOpen: vi.fn(),
    onOpenTask: vi.fn(),
    onNewTask: vi.fn(),
    onPlan: vi.fn(),
    onShowAllDone: vi.fn(),
  }
}
function api() {
  return bridge({
    factoryBoard: () => ({
      stages: [
        { id: 'backlog', enabled: true, gate: false },
        { id: 'intake', enabled: true, gate: false },
        { id: 'work', enabled: true, gate: false },
        { id: 'review', enabled: true, gate: true },
        { id: 'done', enabled: true, gate: false },
      ],
    }),
    startTask: () => task({ stage: 'intake' }),
  })
}

test('empty Board keeps Workflow columns and New Task and Plan actions', async () => {
  api()
  const p = props()
  render(<Board {...p} />)
  await screen.findByRole('region', { name: 'Review' })
  expect(
    [...document.querySelectorAll('[data-stage]')].map((e) => e.getAttribute('aria-label')),
  ).toEqual(['Backlog', 'Intake', 'Work', 'Review', 'Done'])
  expect(within(screen.getByRole('region', { name: 'Review' })).getByText('Gate')).toBeTruthy()
  expect(within(screen.getByRole('region', { name: 'Work' })).queryByText('Gate')).toBeNull()
  const u = user()
  await u.click(required(screen.getAllByRole('button', { name: 'New Task' })[0]))
  await u.click(required(screen.getAllByRole('button', { name: 'Plan' })[0]))
  expect(p.onNewTask).toHaveBeenCalledOnce()
  expect(p.onPlan).toHaveBeenCalledOnce()
})

test('Backlog cards show blocked explanations and only start available Tasks', async () => {
  const a = api()
  render(
    <Board
      {...props()}
      tasks={[
        task(),
        task({
          id: 'NB-2',
          displayId: 'NB-2',
          title: 'Export notes',
          blockedBy: ['NB-1'],
          markers: [{ kind: 'blocked-by', by: 'NB-1' }],
        }),
      ]}
    />,
  )
  expect(screen.queryByRole('button', { name: 'Start NB-2' })).toBeNull()
  await user().click(screen.getByRole('button', { name: 'Start NB-1' }))
  expect(a.request).toHaveBeenCalledWith('startTask', 'NB-1')
  expect(document.querySelector('[data-task="NB-1"]')?.hasAttribute('data-nav-item')).toBe(true)
})

test('Board filters matching nothing offer Clear filters', async () => {
  api()
  const p = props()
  render(<Board {...p} tasks={[task()]} filters={{ priorities: ['urgent'] }} />)
  await user().click(screen.getByRole('button', { name: 'Clear filters' }))
  expect(p.onFilters).toHaveBeenCalledWith({})
})

test('Help shows its tooltip on hover and hides it when the pointer leaves', async () => {
  render(<Help>Queued Tasks wait for a Run slot.</Help>)
  expect(screen.queryByRole('tooltip')).toBeNull()
  const u = user()
  const help = screen.getByRole('button', { name: 'Help' })
  await u.hover(help)
  expect(screen.getByRole('tooltip').textContent).toBe('Queued Tasks wait for a Run slot.')
  expect(help.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id)
  await u.unhover(help)
  expect(screen.queryByRole('tooltip')).toBeNull()
})

test('Done cards show merged metadata, open the Done List and confirm Archive all count', async () => {
  const a = bridge({
    factoryBoard: () => ({
      stages: [
        { id: 'backlog', enabled: true, gate: false },
        { id: 'done', enabled: true, gate: false },
      ],
    }),
    archiveDone: () => ({ archived: 2 }),
  })
  const p = props()
  const now = new Date().toISOString()
  const done = [
    task({ stage: 'done', merged: { at: now, pullRequests: [] } }),
    task({ id: 'NB-2', displayId: 'NB-2', stage: 'done', merged: { at: now, pullRequests: [] } }),
  ]
  render(<Board {...p} tasks={done} />)
  await screen.findByText('NB-2 · Merged just now')
  await user().click(screen.getByRole('button', { name: 'Show all 2 →' }))
  expect(p.onShowAllDone).toHaveBeenCalledOnce()
  await user().click(screen.getByRole('button', { name: 'Done column actions' }))
  await user().click(screen.getByRole('menuitem', { name: 'Archive all in Done' }))
  const dialog = screen.getByRole('dialog', { name: 'Archive 2 Done Tasks?' })
  await user().click(within(dialog).getByRole('button', { name: 'Archive 2' }))
  expect(a.request).toHaveBeenCalledWith('archiveDone', 'f1')
})

test('Board Priority filter narrows cards and does not offer Stage or archived filters', async () => {
  api()
  const p = props()
  const tasks = [
    task({ priority: 'high' }),
    task({ id: 'NB-2', displayId: 'NB-2', title: 'Export notes' }),
  ]
  const view = render(<Board {...p} tasks={tasks} />)
  const u = user()
  await u.click(screen.getByRole('button', { name: 'Filter' }))
  expect(screen.queryByRole('menuitem', { name: 'Stage' })).toBeNull()
  expect(screen.queryByRole('menuitemradio', { name: 'Only' })).toBeNull()
  await u.hover(screen.getByRole('menuitem', { name: 'Priority' }))
  await u.click(screen.getByRole('menuitemcheckbox', { name: /High/ }))
  expect(p.onFilters).toHaveBeenCalledWith({ priorities: ['high'] })
  view.rerender(<Board {...p} tasks={tasks} filters={{ priorities: ['high'] }} />)
  expect(document.querySelector('[data-task="NB-2"]')).toBeNull()
  expect(document.querySelector('[data-task="NB-1"]')).toBeTruthy()
})
