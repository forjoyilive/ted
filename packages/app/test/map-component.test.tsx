// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { blockerMap, linkRefusal } from '../src/renderer/blocker-map.ts'
import { appState } from './support/app.tsx'
import { expandFactory, user } from './support/component.ts'
import { factory, task } from './support/fixtures.ts'

const nb = (number: number, fields: Parameters<typeof task>[0] = {}) =>
  task({
    id: `NB-${number}`,
    displayId: `NB-${number}`,
    number,
    rank: number,
    title: `Task ${number}`,
    ...fields,
  })

function tasks() {
  return [
    nb(1, { stage: 'done' }),
    nb(2, { blockedBy: ['NB-1', 'NB-5'] }),
    nb(3, { blockedBy: ['NB-2', 'MS-1'] }),
    nb(4),
    nb(5, { archived: { at: '2026-11-10T12:00:00.000Z', ended: 'archived' as never } }),
    nb(6, { stage: 'done', blockedBy: ['NB-4'] }),
    task({
      id: 'MS-1',
      displayId: 'MS-1',
      factoryId: 'f2',
      title: 'Pricing page',
      blockedBy: ['MS-2'],
    }),
    task({ id: 'MS-2', displayId: 'MS-2', factoryId: 'f2', title: 'Plans table' }),
  ]
}

test('blockerMap lays chains out left to right and leaves out what holds nothing up', () => {
  const map = blockerMap(tasks(), 'f1')
  const at = Object.fromEntries(map.cards.map((c) => [c.task.id, c]))
  expect(Object.keys(at).sort()).toEqual(['MS-1', 'NB-1', 'NB-2', 'NB-3'])
  expect([at['NB-1']?.column, at['NB-2']?.column, at['NB-3']?.column]).toEqual([0, 1, 2])
  expect(at['MS-1']).toMatchObject({ column: 1, other: true })
  expect(at['NB-1']).toMatchObject({ done: true, other: false })
  expect(at['MS-1']?.row).not.toBe(at['NB-2']?.row)
  expect(map.links).toEqual([
    { blocker: 'NB-1', blocked: 'NB-2', muted: true },
    { blocker: 'NB-2', blocked: 'NB-3', muted: false },
    { blocker: 'MS-1', blocked: 'NB-3', muted: false },
  ])
  expect(map.unlinked.map((t) => t.id)).toEqual(['NB-4'])
  expect(map.columns).toBe(3)

  const two = blockerMap(
    [nb(1), nb(2, { blockedBy: ['NB-1'] }), nb(3), nb(4, { blockedBy: ['NB-3'] })],
    'f1',
  )
  const rows = Object.fromEntries(two.cards.map((c) => [c.task.id, c.row]))
  expect(rows['NB-1']).toBe(rows['NB-2'])
  expect(rows['NB-3']).toBe(rows['NB-4'])
  expect(rows['NB-3']).toBeGreaterThan(rows['NB-1'] ?? 0)

  const done = blockerMap(
    [nb(1, { stage: 'done' }), nb(2, { stage: 'done', blockedBy: ['NB-1'] })],
    'f1',
  )
  expect(done).toMatchObject({ cards: [], links: [], unlinked: [] })

  const cycle = blockerMap([nb(1, { blockedBy: ['NB-2'] }), nb(2, { blockedBy: ['NB-1'] })], 'f1')
  expect(cycle.cards.map((c) => c.task.id).sort()).toEqual(['NB-1', 'NB-2'])
  expect(cycle.links.length).toBe(2)
})

test('linkRefusal says why a link can’t be added', () => {
  const all = tasks()
  expect(linkRefusal(all, 'NB-4', 'NB-3')).toBeUndefined()
  expect(linkRefusal(all, 'NB-3', 'NB-3')).toBe('NB-3 can’t block itself')
  expect(linkRefusal(all, 'NB-4', 'NB-1')).toBe('NB-1 is done')
  expect(linkRefusal(all, 'NB-2', 'NB-3')).toBe('NB-3 already waits for NB-2')
  expect(
    linkRefusal(
      [nb(1), nb(2, { blockedBy: ['NB-1'] }), nb(3, { blockedBy: ['NB-2'] })],
      'NB-3',
      'NB-1',
    ),
  ).toBe('NB-3 can’t block NB-1: NB-3 waits for NB-2, which waits for NB-1')
})

test('Map sits under Tasks, removes a blocker from its line and adds one by dragging', async () => {
  const a = appState()
  a.state.factories.push(factory({ id: 'f2', key: 'MS', name: 'site', position: 1 }))
  a.state.tasks = tasks()
  a.handle('unblockTask', () => nb(3, { blockedBy: ['MS-1'] }))
  a.handle('blockTask', () => nb(3))
  const mounted = a.mount()
  const calls = (name: string) =>
    a.request.mock.calls.filter((call) => call[0] === name).map((call) => call.slice(1))
  const u = user()
  await expandFactory()
  const nav = within(screen.getByRole('navigation', { name: 'Sidebar' }))
  await u.click(nav.getByRole('button', { name: 'Task views' }))
  await u.click(nav.getByRole('button', { name: 'List' }))
  await u.click(nav.getByRole('button', { name: 'Dashboard' }))
  await u.click(nav.getByRole('button', { name: 'Tasks' }))
  await screen.findByRole('heading', { name: /widgets.*List/ })
  await u.click(nav.getByRole('button', { name: 'Map' }))
  await screen.findByRole('heading', { name: /widgets.*Map/ })
  expect(nav.getByRole('button', { name: 'Map' }).getAttribute('aria-current')).toBe('page')

  const main = within(screen.getByRole('main'))
  const shown = () =>
    [...document.querySelectorAll('[data-blocker-map] [data-task]')].map((e) =>
      e.getAttribute('data-task'),
    )
  expect(shown().sort()).toEqual(['MS-1', 'NB-1', 'NB-2', 'NB-3'])
  expect(document.querySelectorAll('[data-link]').length).toBe(3)
  expect(main.getByRole('article', { name: 'MS-1 Pricing page' }).textContent).toContain('site')

  await u.click(main.getByRole('button', { name: 'Remove blocker: NB-3 stops waiting for NB-2' }))
  expect(a.request).toHaveBeenCalledWith('unblockTask', 'NB-3', 'NB-2')
  expect(await main.findByText('NB-3 no longer waits for NB-2')).toBeTruthy()
  await u.click(main.getByRole('button', { name: 'Undo' }))
  expect(a.request).toHaveBeenCalledWith('blockTask', 'NB-3', 'NB-2')

  expect(main.queryByRole('article', { name: 'NB-4 Task 4' })).toBeNull()
  await u.click(main.getByRole('button', { name: 'Tasks with no blockers' }))
  const side = within(main.getByRole('complementary', { name: 'Tasks with no blockers' }))
  expect(side.getByRole('article', { name: 'NB-4 Task 4' })).toBeTruthy()

  const handle = side.getByRole('button', {
    name: 'Drag to the Task that should wait for NB-4',
  })
  fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: 10 })
  fireEvent.pointerMove(main.getByRole('article', { name: 'NB-1 Task 1' }))
  expect(main.getByText('NB-1 is done')).toBeTruthy()
  fireEvent.pointerUp(window)
  expect(main.queryByText('NB-1 is done')).toBeNull()

  fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: 10 })
  expect(main.getByText('Drop on the Task that should wait for NB-4')).toBeTruthy()
  fireEvent.pointerMove(side.getByRole('article', { name: 'NB-4 Task 4' }))
  expect(main.getByText('NB-4 can’t block itself')).toBeTruthy()
  fireEvent.pointerUp(window)
  expect(calls('blockTask')).toEqual([['NB-3', 'NB-2']])

  fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: 10 })
  fireEvent.pointerMove(main.getByRole('article', { name: 'NB-3 Task 3' }))
  expect(main.getByText('NB-3 will wait for NB-4')).toBeTruthy()
  fireEvent.pointerUp(window)
  expect(calls('blockTask')).toEqual([
    ['NB-3', 'NB-2'],
    ['NB-3', 'NB-4'],
  ])
  expect(calls('unblockTask')).toEqual([['NB-3', 'NB-2']])
  expect(await main.findByText('NB-3 now waits for NB-4')).toBeTruthy()

  await a.emitTask(nb(3, { blockedBy: ['NB-2', 'MS-1', 'NB-4'] }))
  expect(shown()).toContain('NB-4')
  expect(document.querySelectorAll('[data-link]').length).toBe(4)

  fireEvent.pointerDown(
    main.getByRole('button', { name: 'Drag to the Task that should wait for NB-4' }),
    { button: 0, clientX: 10, clientY: 10 },
  )
  fireEvent.pointerMove(main.getByRole('article', { name: 'NB-2 Task 2' }))
  expect(main.getByText('NB-2 will wait for NB-4')).toBeTruthy()
  mounted.unmount()
  fireEvent.pointerUp(window)
  expect(calls('blockTask').length).toBe(2)
})
