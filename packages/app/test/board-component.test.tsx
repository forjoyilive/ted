// @vitest-environment jsdom
import type { ListFilters, TaskMarker } from '@ted/protocol'
import { render as draw, fireEvent, screen, within } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { expect, test, vi } from 'vitest'
import {
  type TaskFacts,
  taskActivity,
  taskMarkers,
  taskStatus,
} from '../../daemon/src/tasks/status.ts'
import { Help } from '../src/renderer/components/Help.tsx'
import { affects, StagesProvider } from '../src/renderer/stages.tsx'
import { Board } from '../src/renderer/views/Board.tsx'
import { idColumnWidth, listGrid, TaskList } from '../src/renderer/views/TaskList.tsx'
import { appState } from './support/app.tsx'
import { bridge, expandFactory, required, user } from './support/component.ts'
import { factory, task } from './support/fixtures.ts'

const Stages = ({ children }: { children: ReactNode }) => (
  <StagesProvider factoryIds={['f1', 'f2']}>{children}</StagesProvider>
)
const render = (ui: ReactElement) => draw(ui, { wrapper: Stages })

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
  expect(within(screen.getByRole('region', { name: 'Review' })).getByText('Sign-Off')).toBeTruthy()
  expect(within(screen.getByRole('region', { name: 'Work' })).queryByText('Sign-Off')).toBeNull()
  const u = user()
  const empty = screen.getByRole('region', { name: 'No Tasks yet' })
  if (!empty) throw new Error('Missing empty Board')
  await u.click(within(empty).getByRole('button', { name: 'New Task…' }))
  await u.click(within(empty).getByRole('button', { name: 'Plan…' }))
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

test('Display sets card size, card fields and columns, and saves them for the Factory', async () => {
  const a = api()
  a.handle('updateSettings', () => ({}))
  render(
    <Board
      {...props()}
      tasks={[
        task({
          markers: [{ kind: 'blocked-by', by: 'NB-9' }],
          activity: 'Starts when NB-9 merges',
          childIds: ['NB-2'],
        }),
        task({
          id: 'NB-2',
          displayId: 'NB-2',
          parentId: 'NB-1',
          title: 'Export notes',
          stage: 'work',
          statuses: ['waiting-on-you'],
          status: { kind: 'waiting-on-you' },
          activity: 'Asked a question',
        }),
      ]}
    />,
  )
  await screen.findByRole('region', { name: 'Review' })
  expect(screen.queryByRole('button', { name: 'Plan…' })).toBeNull()
  const stagesShown = () =>
    [...document.querySelectorAll('[data-stage]')].map((e) => e.getAttribute('aria-label'))
  const card = (id: string) => {
    const found = document.querySelector<HTMLElement>(`[data-task="${id}"]`)
    if (!found) throw new Error(`Missing card ${id}`)
    return within(found)
  }
  const u = user()
  await u.click(screen.getByRole('button', { name: 'Display' }))
  const item = (name: string) => screen.getByRole('menuitemcheckbox', { name: new RegExp(name) })

  expect(card('NB-2').getByText('↑ NB-1')).toBeTruthy()
  expect(card('NB-1').getByRole('img', { name: '0 of 1 child merged' }).textContent).toBe('0/1')
  await u.click(item('Parent and children'))
  expect(card('NB-2').queryByText('↑ NB-1')).toBeNull()
  expect(card('NB-1').queryByRole('img', { name: '0 of 1 child merged' })).toBeNull()

  await u.click(item('Activity line'))
  expect(screen.queryByText('Asked a question')).toBeNull()
  expect(card('NB-1').getByText('Blocked by')).toBeTruthy()
  await u.click(item('Blockers'))
  expect(card('NB-1').queryByText('Blocked by')).toBeNull()

  await u.click(screen.getByRole('menuitemradio', { name: 'Compact' }))
  expect(card('NB-1').getByText('Blocked by')).toBeTruthy()
  expect(screen.queryByText('Starts when NB-9 merges')).toBeNull()
  expect(item('Activity line')).toHaveProperty('disabled', true)

  await u.click(item('Work'))
  expect(stagesShown()).toEqual(['Backlog', 'Intake', 'Review', 'Done'])
  const hidden = within(screen.getByRole('complementary', { name: 'Hidden columns' }))
  expect(hidden.getByTitle('Show Work').textContent).toBe('Work11 needs you')
  expect(hidden.getByTitle('Show Work').hasAttribute('data-nav-item')).toBe(true)
  await u.click(item('Hide empty columns'))
  expect(stagesShown()).toEqual(['Backlog'])

  await u.click(hidden.getByTitle('Show Work'))
  expect(stagesShown()).toEqual(['Backlog', 'Work'])
  expect(screen.queryByRole('complementary', { name: 'Hidden columns' })).toBeNull()
  expect(a.request).toHaveBeenLastCalledWith('updateSettings', {
    boardViews: {
      f1: {
        cardSize: 'compact',
        fields: ['priority', 'sub-agents'],
        hiddenStages: [],
        hideEmpty: true,
      },
    },
  })
})

test('Board filters matching nothing offer Clear filters', async () => {
  api()
  const p = props()
  render(<Board {...p} tasks={[task()]} filters={{ priorities: ['urgent'] }} />)
  await user().click(screen.getByRole('button', { name: 'Clear filters' }))
  expect(p.onFilters).toHaveBeenCalledWith({})
})

test('Help shows its tooltip on hover and hides it when the pointer leaves', async () => {
  draw(<Help>Queued Tasks wait for a Run slot.</Help>)
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
  await user().click(screen.getByRole('menuitem', { name: 'Archive all in Done…' }))
  const dialog = screen.getByRole('dialog', { name: 'Archive 2 Done Tasks?' })
  await user().click(within(dialog).getByRole('button', { name: 'Archive 2' }))
  expect(a.request).toHaveBeenCalledWith('archiveDone', 'f1')
  view.rerender(<Board {...p} tasks={[]} />)
  expect(screen.queryByRole('button', { name: 'Show all 2 →' })).toBeNull()
  expect(document.querySelectorAll('[data-stage="done"] [data-task]')).toHaveLength(0)
})

test('Board Priority filter narrows cards and the card’s Priority icon changes Priority', async () => {
  const bridgeApi = api()
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
  bridgeApi.handle('setPriority', () => undefined)
  await u.click(screen.getByRole('button', { name: 'Priority: High. Change Priority of NB-1' }))
  const menu = await screen.findByRole('menu', { name: 'Priority' })
  await u.click(within(menu).getByRole('menuitemradio', { name: /Low/ }))
  await vi.waitFor(() =>
    expect(bridgeApi.request).toHaveBeenCalledWith('setPriority', 'NB-1', 'low'),
  )
  await vi.waitFor(() => expect(screen.queryByRole('menu', { name: 'Priority' })).toBeNull())
  expect(p.onOpen).not.toHaveBeenCalled()
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
        columns: ['id', 'title', 'stage', 'started', 'children', 'parent'],
        filters: { stages: ['done'] },
        columnsVersion: 3,
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
    markers.flatMap((m) => (m.kind === 'test-activity' ? [m.label] : []))
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

test('Board cards select with ⌘-click, ⇧-click and X, and share the List’s bar and menu', async () => {
  const a = appState()
  a.state.slots = { ...a.state.slots, working: 2 }
  a.state.tasks = [
    task({ title: 'One' }),
    task({ id: 'NB-2', displayId: 'NB-2', number: 2, title: 'Two', rank: 2 }),
    task({ id: 'NB-3', displayId: 'NB-3', number: 3, title: 'Three', rank: 3 }),
    task({ id: 'NB-4', displayId: 'NB-4', number: 4, title: 'Four', stage: 'work', rank: 4 }),
  ]
  a.handle('factoryBoard', () => ({
    stages: [
      { id: 'backlog', enabled: true, gate: false },
      { id: 'intake', enabled: true, gate: false },
      { id: 'work', enabled: true, gate: false },
      { id: 'done', enabled: true, gate: false },
    ],
  }))
  a.handle('startTask', vi.fn())
  a.mount()
  const u = user()
  await expandFactory()
  await u.click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: 'Task views',
    }),
  )
  await u.click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: 'Board',
    }),
  )
  await screen.findByRole('region', { name: 'Work' })
  const card = (id: string) => {
    const found = document.querySelector<HTMLElement>(`article[data-task="${id}"]`)
    if (!found) throw new Error(`Missing card ${id}`)
    return found
  }
  const title = (id: string) => {
    const found = card(id).querySelector<HTMLElement>('[data-card-title]')
    if (!found) throw new Error(`Missing title of ${id}`)
    return found
  }
  const picked = () =>
    [...document.querySelectorAll('article[data-selected]')].map((e) => e.getAttribute('data-task'))

  fireEvent.click(title('NB-1'), { metaKey: true })
  fireEvent.click(screen.getByRole('button', { name: 'Start NB-2' }), { metaKey: true })
  expect(picked()).toEqual(['NB-1', 'NB-2'])
  expect(a.request.mock.calls.some(([name]) => name === 'startTask')).toBe(false)
  const search = screen.getByRole('searchbox', { name: 'Filter by ID or title' })
  fireEvent.change(search, { target: { value: 'Two' } })
  expect(picked()).toEqual(['NB-2'])
  fireEvent.change(search, { target: { value: '' } })
  expect(picked()).toEqual(['NB-2'])
  fireEvent.click(title('NB-2'), { metaKey: true })
  expect(picked()).toEqual([])

  fireEvent.click(title('NB-1'), { metaKey: true })
  fireEvent.click(title('NB-3'), { shiftKey: true })
  expect(picked()).toEqual(['NB-1', 'NB-2', 'NB-3'])
  fireEvent.click(title('NB-4'), { shiftKey: true })
  expect(picked()).toEqual(['NB-1', 'NB-2', 'NB-3', 'NB-4'])
  const bar = within(screen.getByRole('toolbar', { name: 'Selected Tasks' }))
  expect(bar.getByText('4 selected')).toBeTruthy()
  expect(bar.getByRole('button', { name: 'Start 3' })).toBeTruthy()
  expect(document.querySelector('[data-wait-line]')?.textContent).toBe(
    '1 starts now, 2 wait for a Run slot',
  )

  fireEvent.pointerMove(card('NB-4'))
  fireEvent.keyDown(window, { key: 'x' })
  expect(picked()).toEqual(['NB-1', 'NB-2', 'NB-3'])

  fireEvent.contextMenu(card('NB-2'), { clientX: 50, clientY: 80 })
  const menu = await screen.findByRole('menu', { name: '3 selected Tasks' })
  fireEvent.keyDown(menu, { key: 'Escape' })
  expect(screen.queryByRole('menu', { name: '3 selected Tasks' })).toBeNull()
  expect(picked()).toHaveLength(3)

  await u.click(bar.getByRole('button', { name: 'Start' }))
  for (const id of ['NB-1', 'NB-2', 'NB-3']) expect(a.request).toHaveBeenCalledWith('startTask', id)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(picked()).toEqual([])
  expect(screen.queryByRole('toolbar', { name: 'Selected Tasks' })).toBeNull()

  await u.click(title('NB-4'))
  expect(await screen.findByRole('region', { name: 'Task thread' })).toBeTruthy()
})

test('List ID column fits the longest ID, and Status gives way before Title is under 40 characters', () => {
  expect(idColumnWidth([{ displayId: 'TED-1000' }])).not.toMatch(/\d(ch|em|ex)\b/)
  expect(idColumnWidth([])).toBe('max(56px, calc(2 * 0.65 * var(--text-14)))')
  expect(idColumnWidth([{ displayId: 'TED-9' }, { displayId: 'TED-1000' }])).toBe(
    'max(56px, calc(10 * 0.65 * var(--text-14)))',
  )
  expect(listGrid(['id', 'title', 'status', 'updated'], [{ displayId: 'TED-1' }])).toBe(
    '4px 24px max(56px, calc(7 * 0.65 * var(--text-14))) minmax(120px, 1fr) ' +
      'minmax(176px, min(300px, calc(100% - 4px - 24px - max(56px, calc(7 * 0.65 * var(--text-14))) - 40ch - 56px - 4px - 6 * 16px))) 56px 4px',
  )
  expect(listGrid(['id', 'status'], [])).toContain('minmax(176px, 300px)')
  expect(listGrid(['children', 'parent'], [{ displayId: 'TED-1000' }])).toBe(
    '4px 24px 104px max(80px, max(56px, calc(10 * 0.65 * var(--text-14)))) 4px',
  )
})

test('folding a parent in one Stage group keeps its children in other groups and is remembered', async () => {
  api()
  const p = props()
  const tasks = [
    task({ id: 'NB-1', displayId: 'NB-1', title: 'Parent', childIds: ['NB-2', 'NB-3'] }),
    task({ id: 'NB-2', displayId: 'NB-2', title: 'Waiting child', parentId: 'NB-1', rank: 2 }),
    task({
      id: 'NB-3',
      displayId: 'NB-3',
      title: 'Working child',
      parentId: 'NB-1',
      stage: 'work',
    }),
  ]
  const mount = () =>
    render(
      <TaskList
        scope="f1"
        title="Tasks"
        tasks={tasks}
        factories={[factory()]}
        settings={undefined}
        onOpen={p.onOpen}
        onOpenTask={p.onOpenTask}
        onNewTask={p.onNewTask}
      />,
    )
  const rows = () =>
    [...document.querySelectorAll('tbody tr[data-task], tbody tr[data-context-task]')].map(
      (row) => row.getAttribute('data-task') ?? `(${row.getAttribute('data-context-task')})`,
    )
  const first = mount()
  expect(rows()).toEqual(['NB-1', 'NB-2', '(NB-1)', 'NB-3'])
  const heads = [...document.querySelectorAll('thead th')].map((th) => th.textContent)
  expect(heads.slice(heads.indexOf('Title'), heads.indexOf('Title') + 3)).toEqual([
    'Title',
    'Children',
    'Parent',
  ])
  const cells = (id: string) =>
    [...(document.querySelector(`tbody tr[data-task="${id}"]`)?.children ?? [])].map(
      (cell) => cell.textContent,
    )
  const at = heads.indexOf('Title')
  expect(cells('NB-1').slice(at, at + 3)).toEqual(['Parent', '0 of 2 merged', '—'])
  expect(cells('NB-2').slice(at, at + 3)).toEqual(['Waiting child', '—', '↑ NB-1'])
  const [backlogCaret] = screen.getAllByRole('button', { name: 'Collapse children of NB-1' })
  await user().click(required(backlogCaret))
  expect(rows()).toEqual(['NB-1', '(NB-1)', 'NB-3'])
  expect(
    screen.getAllByRole('button', { name: /children of NB-1$/ }).map((b) => b.ariaExpanded),
  ).toEqual(['false', 'true'])
  first.unmount()
  mount()
  expect(rows()).toEqual(['NB-1', '(NB-1)', 'NB-3'])
})

test('the Stage lists reload for a requested Factory, even before its first list has loaded', () => {
  const stagesChanged = { type: 'factory-stages-changed', factoryId: 'f1' } as const
  expect(affects(stagesChanged, ['f1'], {})).toBe(true)
  expect(affects(stagesChanged, ['f2'], {})).toBe(false)
  const moved = { type: 'task-updated', task: task({ stage: 'work' }) } as const
  expect(affects(moved, ['f1'], {})).toBe(true)
  const listed = { f1: [{ id: 'work', enabled: true, gate: false }] }
  expect(affects(moved, ['f1'], listed)).toBe(false)
})

test('a Task waiting after its Checks says so, with its place in the hover title', async () => {
  api()
  const facts: TaskFacts = {
    stage: 'work',
    runs: ['idle'],
    queue: { place: 2, after: 'checks-passed' },
    busy: { loadRatio: 2 },
  }
  const status = taskStatus(facts)
  if (!status) throw new Error('Expected a queued status')
  render(<Board {...props()} tasks={[task({ stage: 'work', status, markers: [] })]} />)
  const chip = await screen.findByText('Queued · Checks passed, waiting for a slot')
  expect(chip.title).toBe('2nd in the queue')
})

test('Stopped is red, Snoozed is amber and Ready for Work stays green', async () => {
  api()
  const p = props()
  render(
    <Board
      {...p}
      tasks={[
        task({ status: { kind: 'stopped' }, statuses: ['stopped'], stage: 'work' }),
        task({
          id: 'NB-2',
          displayId: 'NB-2',
          status: { kind: 'stopped', prepared: true },
          statuses: ['stopped'],
          stage: 'work',
        }),
        task({
          id: 'NB-3',
          displayId: 'NB-3',
          status: { kind: 'waiting-on-you', snoozedUntil: '2026-11-11T09:00:00Z' },
          statuses: ['waiting-on-you'],
          stage: 'work',
        }),
      ]}
    />,
  )
  await screen.findByRole('region', { name: 'Work' })
  expect(screen.getByText('Stopped').className).toContain('stopped')
  expect(screen.getByText('Ready for Work').className).toContain('success')
  expect(screen.getByText('Snoozed').className).toContain('snoozed')
})
