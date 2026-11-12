// @vitest-environment jsdom
import type { ListFilters, TaskMarker } from '@ted/protocol'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import {
  type TaskFacts,
  taskActivity,
  taskMarkers,
  taskStatus,
} from '../../daemon/src/tasks/status.ts'
import { Help } from '../src/renderer/components/Help.tsx'
import { Board } from '../src/renderer/views/Board.tsx'
import { TaskList } from '../src/renderer/views/TaskList.tsx'
import { appState } from './support/app.tsx'
import { bridge, user } from './support/component.ts'
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
  expect(within(screen.getByRole('region', { name: 'Review' })).getByText('Sign-off')).toBeTruthy()
  expect(within(screen.getByRole('region', { name: 'Work' })).queryByText('Sign-off')).toBeNull()
  const u = user()
  const empty = screen.getByRole('region', { name: 'No Tasks yet' })
  if (!empty) throw new Error('Missing empty Board')
  await u.click(within(empty).getByRole('button', { name: 'New Task' }))
  await u.click(within(empty).getByRole('button', { name: 'Plan' }))
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
          activity: 'Starts when NB-1 merges',
        }),
      ]}
    />,
  )
  expect(screen.queryByRole('button', { name: 'Start NB-2' })).toBeNull()
  expect(screen.getByText('Starts when NB-1 merges')).toBeTruthy()
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

test('Done cards show merged metadata, request the Done List and confirm Archive all count', async () => {
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
  const view = render(<Board {...p} tasks={done} />)
  await screen.findByText('NB-2 · Merged just now')
  await user().click(screen.getByRole('button', { name: 'Show all 2 →' }))
  expect(p.onShowAllDone).toHaveBeenCalledOnce()
  await user().click(screen.getByRole('button', { name: 'Done column actions' }))
  await user().click(screen.getByRole('menuitem', { name: 'Archive all in Done' }))
  const dialog = screen.getByRole('dialog', { name: 'Archive 2 Done Tasks?' })
  await user().click(within(dialog).getByRole('button', { name: 'Archive 2' }))
  expect(a.request).toHaveBeenCalledWith('archiveDone', 'f1')
  view.rerender(<Board {...p} tasks={[]} />)
  expect(screen.queryByRole('button', { name: 'Show all 2 →' })).toBeNull()
  expect(document.querySelectorAll('[data-stage="done"] [data-task]')).toHaveLength(0)
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

test('Board Show all opens its Factory’s Done-filtered List and saves that view', async () => {
  const a = appState()
  a.state.factories.push(factory({ id: 'f2', key: 'MS', name: 'site' }))
  const merged = { at: new Date().toISOString(), pullRequests: [] }
  a.state.tasks = [
    task({ title: 'Open work' }),
    task({ id: 'NB-2', displayId: 'NB-2', title: 'Shipped sync', stage: 'done', merged }),
    task({
      id: 'MS-1',
      displayId: 'MS-1',
      factoryId: 'f2',
      title: 'Other Factory’s Done Task',
      stage: 'done',
      merged,
    }),
  ]
  const allView = {
    sort: 'title',
    group: 'factory',
    columns: ['title', 'factory'],
    filters: {},
  } as const
  a.state.settings = {
    ...a.state.settings,
    listViews: {
      all: { ...allView, columns: [...allView.columns] },
      f1: {
        sort: 'title',
        group: 'stage',
        columns: ['id', 'title', 'stage'],
        filters: { priorities: ['high'] },
      },
    },
  }
  a.handle('factoryBoard', () => ({
    stages: [
      { id: 'backlog', enabled: true, gate: false },
      { id: 'done', enabled: true, gate: false },
    ],
  }))
  a.mount()
  const u = user()
  await u.click(await screen.findByRole('button', { name: 'widgets' }))
  await user().click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: 'Board',
    }),
  )
  await u.click(await screen.findByRole('button', { name: 'Show all 1 →' }))
  await screen.findByRole('heading', { name: /widgets.*List/ })
  await screen.findByText('Stage is Done')
  expect(
    [...document.querySelectorAll('tbody tr[data-task]')].map((e) => e.getAttribute('data-task')),
  ).toEqual(['NB-2'])
  expect(a.request).toHaveBeenCalledWith('updateSettings', {
    listViews: {
      all: allView,
      f1: {
        sort: 'updated',
        group: 'none',
        columns: ['id', 'title', 'stage', 'started'],
        filters: { stages: ['done'] },
        columnsVersion: 2,
      },
    },
  })
  expect(a.state.settings.listViews.f1?.filters).toEqual({ stages: ['done'] })
})

test('Clear filters empties the typed Board search and restores its cards', async () => {
  api()
  render(<Board {...props()} tasks={[task()]} />)
  await screen.findByRole('region', { name: 'Backlog' })
  const filter = screen.getByRole('searchbox', { name: 'Filter by ID or title' })
  await user().type(filter, 'No matching Task')
  expect(document.querySelector('[data-task="NB-1"]')).toBeNull()
  await user().click(screen.getByRole('button', { name: 'Clear filters' }))
  expect((filter as HTMLInputElement).value).toBe('')
  expect(document.querySelector('[data-task="NB-1"]')).toBeTruthy()
  expect(screen.queryByText('No Tasks match these filters')).toBeNull()
})

test.each([
  { grabY: 12, x: 500, y: 400 },
  { grabY: 90, x: 1018, y: 20 },
  { grabY: 50, x: 500, y: 760 },
])(
  'refused drop feedback clears the preview and viewport edges at $x,$y (grab $grabY)',
  async ({ grabY, x, y }) => {
    const a = api()
    render(<Board {...props()} tasks={[task()]} />)
    const backlog = await screen.findByRole('region', { name: 'Backlog' })
    const card = within(backlog).getByRole('article')
    const bounds = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return DOMRect.fromRect(
          this === card ? { x: 100, y: 200, width: 224, height: 110 } : { width: 140, height: 26 },
        )
      })
    try {
      const dataTransfer = {
        setData: vi.fn(),
        setDragImage: vi.fn(),
        effectAllowed: '',
        dropEffect: '',
      }
      // jsdom has no DragEvent; MouseEvent supplies the pointer coordinates React reads.
      const drag = (element: HTMLElement, type: string, clientX: number, clientY: number) => {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY })
        Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
        fireEvent(element, event)
      }
      drag(card, 'dragstart', 180, 200 + grabY)
      const work = screen.getByRole('region', { name: 'Work' })
      drag(work, 'dragover', x, y)
      const hint = screen.getByText('Can’t drop here')
      const left = Number.parseFloat(hint.style.left)
      const top = Number.parseFloat(hint.style.top)
      const previewTop = y - grabY
      const previewBottom = previewTop + 110
      expect(top + 26 <= previewTop - 12 || top >= previewBottom + 12).toBe(true)
      expect(left).toBeGreaterThanOrEqual(8)
      expect(left + 140).toBeLessThanOrEqual(window.innerWidth - 8)
      expect(top).toBeGreaterThanOrEqual(8)
      expect(top + 26).toBeLessThanOrEqual(window.innerHeight - 8)
      expect(dataTransfer.dropEffect).toBe('none')
      drag(work, 'drop', x, y)
      expect(a.request).not.toHaveBeenCalledWith('moveTask', expect.anything(), expect.anything())
      expect(screen.queryByText('Can’t drop here')).toBeNull()
      drag(card, 'dragstart', 180, 200 + grabY)
      drag(work, 'dragover', x, y)
      expect(screen.getByText('Can’t drop here')).toBeTruthy()
      drag(screen.getByRole('region', { name: 'Intake' }), 'dragover', x, y)
      expect(screen.queryByText('Can’t drop here')).toBeNull()
      drag(work, 'dragover', x, y)
      drag(card, 'dragend', x, y)
      expect(screen.queryByText('Can’t drop here')).toBeNull()
    } finally {
      bounds.mockRestore()
    }
  },
)

test('List and Board keep the user request beside purple running and neutral waiting indicators', async () => {
  api()
  const facts: TaskFacts = {
    stage: 'work',
    runs: ['working'],
    openRequests: 1,
    checking: { name: 'Typecheck', index: 1, total: 2 },
    testActivity: { running: 2, waiting: 1, checksWaiting: false },
  }
  const status = taskStatus(facts)
  const activity = taskActivity(facts)
  if (!status || !activity) throw new Error('Expected active Task facts')
  const current = task({
    stage: 'work',
    status,
    markers: taskMarkers(facts, taskStatus(facts)),
    activity,
  })
  const p = props()
  const board = render(<Board {...p} tasks={[current]} />)
  await screen.findByRole('region', { name: 'Work' })
  const verify = () => {
    expect(screen.getByText('Waiting on you')).toBeTruthy()
    for (const label of ['Running checks', 'Running tests']) {
      const chip = screen.getByText(label)
      expect(chip.className).toContain('testing')
      expect(chip.querySelector('svg')?.className.baseVal).toContain('spinning')
    }
    expect(screen.getByText('Waiting for tests').className).toContain('neutral')
    expect(screen.getByText('Running checks').title).toBe('Typecheck · 1 of 2 Checks')
    expect(screen.getByText('Running tests').title).toBe('2 supported test commands running')
    expect(
      screen.getByText('Waiting for tests').querySelector('svg')?.className.baseVal,
    ).not.toContain('spinning')
  }
  verify()
  expect(
    screen.getByText('Waiting on you').compareDocumentPosition(screen.getByText('Running tests')) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
  board.unmount()
  for (const scope of ['all', 'f1']) {
    const list = render(
      <TaskList
        scope={scope}
        title="Tasks"
        tasks={[current]}
        factories={[factory()]}
        settings={undefined}
        onOpen={p.onOpen}
        onOpenTask={p.onOpenTask}
        onNewTask={p.onNewTask}
      />,
    )
    verify()
    list.rerender(
      <TaskList
        scope={scope}
        title="Tasks"
        tasks={[{ ...current, markers: [] }]}
        factories={[factory()]}
        settings={undefined}
        onOpen={p.onOpen}
        onOpenTask={p.onOpenTask}
        onNewTask={p.onNewTask}
      />,
    )
    expect(screen.queryByText('Running tests')).toBeNull()
    expect(screen.queryByText('Waiting for tests')).toBeNull()
    expect(screen.getByText('Waiting on you')).toBeTruthy()
    list.unmount()
  }
  const labels = (markers: TaskMarker[]) =>
    markers.filter((m) => m.kind === 'test-activity').map((m) => m.label)
  expect(labels(taskMarkers({ ...facts, checksWaiting: { place: 2 } }, current.status))).toEqual([
    'Waiting for checks',
    'Running tests',
    'Waiting for tests',
  ])
  expect(
    labels(
      taskMarkers(
        { ...facts, testActivity: { running: 0, waiting: 0, checksWaiting: true } },
        current.status,
      ),
    ),
  ).toEqual(['Waiting for checks'])
  expect(
    taskActivity({ ...facts, testActivity: { running: 0, waiting: 0, checksWaiting: true } }),
  ).toContain('shared test slot')
  expect(
    labels(taskMarkers({ ...facts, stopped: { at: '', runs: 1, why: 'human' } }, current.status)),
  ).toEqual([])
  expect(labels(taskMarkers({ ...facts, stage: 'done' }, undefined))).toEqual([])
  expect(taskMarkers({ ...facts, archived: true }, undefined)).toEqual([])
})
