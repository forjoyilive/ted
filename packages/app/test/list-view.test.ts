import type { Factory, FactoryLayout, ListGroup, RunSlots, Task } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import {
  activeFilterCount,
  columnSelection,
  defaultView,
  doneView,
  dropAction,
  dropTargets,
  filterChips,
  filterTasks,
  groupTasks,
  isQueueMode,
  neighbours,
  nestedRows,
  queueView,
  rankMove,
  selectionRange,
  shownColumns,
  sortTasks,
  summaryLine,
  viewFor,
} from '../src/renderer/list-view.ts'
import { startSplit, startWaitLine } from '../src/renderer/slots.ts'

let made = 0

function task(fields: Partial<Task> & { displayId: string }): Task {
  made++
  return {
    id: fields.displayId,
    factoryId: 'nb',
    number: made,
    title: `Task ${fields.displayId}`,
    description: '',
    priority: 'none',
    clarifyDepth: 'auto',
    blockedBy: [],
    attachments: [],
    stage: 'backlog',
    rank: made,
    statuses: [],
    markers: [],
    track: [],
    runs: [],
    tabs: [],
    repos: [],
    chosenRepos: [],
    createdBy: 'human',
    commentBox: 'no-run',
    createdAt: `2026-11-0${(made % 8) + 1}T10:00:00Z`,
    updatedAt: `2026-11-0${(made % 8) + 1}T10:00:00Z`,
    ...fields,
  }
}

const factories: Factory[] = [
  {
    id: 'nb',
    key: 'NB',
    name: 'Notebook',
    repo: 'kriya/notebook',
    defaultBranch: 'main',
    createdAt: '2026-11-01T00:00:00Z',
  },
  {
    id: 'ms',
    key: 'MS',
    name: 'Marketing site',
    repo: 'kriya/site',
    defaultBranch: 'main',
    createdAt: '2026-11-02T00:00:00Z',
  },
] as Factory[]

const ids = (tasks: readonly Task[]) => tasks.map((t) => t.displayId)

describe('defaults', () => {
  test('Lists group by Stage; All Tasks also shows the Factory column', () => {
    expect(defaultView('nb')).toMatchObject({ sort: 'manual', group: 'stage' })
    expect(shownColumns(defaultView('nb'))).toEqual([
      'priority',
      'id',
      'title',
      'stage',
      'status',
      'updated',
      'started',
    ])
    expect(defaultView('all')).toMatchObject({ sort: 'manual', group: 'stage' })
    expect(shownColumns(defaultView('all'))).toContain('factory')
  })

  test('All Tasks defaults to Stage grouping unless a saved view exists', () => {
    expect(viewFor(undefined, 'all').group).toBe('stage')
    expect(viewFor({}, 'all').group).toBe('stage')
    const saved = { ...defaultView('all'), group: 'factory' as const }
    expect(viewFor({ all: saved }, 'all')).toBe(saved)
  })

  test('Title always shows', () => {
    expect(shownColumns({ ...defaultView('nb'), columns: ['id'] })).toEqual(['id', 'title'])
  })
})

describe('filters', () => {
  const blocked = task({ displayId: 'NB-1', markers: [{ kind: 'blocked-by', by: 'NB-2' }] })
  const working = task({
    displayId: 'NB-2',
    stage: 'work',
    status: { kind: 'waiting-on-you' },
    statuses: ['waiting-on-you', 'working'],
  })
  const quiet = task({ displayId: 'NB-3', title: 'Dark mode', priority: 'high' })
  const archived = task({
    displayId: 'NB-4',
    archived: { at: '2026-11-08T10:00:00Z', ended: { kind: 'never-started' } },
  })
  const other = task({ displayId: 'MS-1', factoryId: 'ms', stage: 'intake' })
  const planning = task({ displayId: 'NB-5', markers: [{ kind: 'needs-planning' }] })
  const all = [blocked, working, quiet, archived, other, planning]

  test('Status matches every status a Task has now, not only the one it shows', () => {
    expect(ids(filterTasks(all, { statuses: ['working'] }))).toEqual(['NB-2'])
  })

  test('Blocked matches the marker as well as the status', () => {
    expect(ids(filterTasks(all, { statuses: ['blocked'] }))).toEqual(['NB-1'])
  })

  test('No status matches Tasks that show none', () => {
    expect(ids(filterTasks(all, { statuses: ['none'] }))).toEqual(['NB-1', 'NB-3', 'MS-1', 'NB-5'])
  })

  test('archived Tasks are hidden by default, included, or the only ones', () => {
    expect(ids(filterTasks(all, {}))).not.toContain('NB-4')
    expect(ids(filterTasks(all, { archived: 'included' }))).toContain('NB-4')
    expect(ids(filterTasks(all, { archived: 'only' }))).toEqual(['NB-4'])
  })

  test('Factory, Stage, Priority, Needs planning and Created by narrow the list', () => {
    expect(ids(filterTasks(all, { factories: ['ms'] }))).toEqual(['MS-1'])
    expect(ids(filterTasks(all, { stages: ['work', 'intake'] }))).toEqual(['NB-2', 'MS-1'])
    expect(ids(filterTasks(all, { priorities: ['high'] }))).toEqual(['NB-3'])
    expect(ids(filterTasks(all, { needsPlanning: true }))).toEqual(['NB-5'])
    expect(ids(filterTasks(all, { createdBy: ['automation'] }))).toEqual([])
  })

  test('the text box matches ID and title', () => {
    expect(ids(filterTasks(all, {}, 'dark'))).toEqual(['NB-3'])
    expect(ids(filterTasks(all, {}, 'ms-1'))).toEqual(['MS-1'])
  })

  test('active filters show as chips that each clear their own filter', () => {
    const chips = filterChips(
      { statuses: ['queued'], factories: ['ms'], archived: 'only' },
      factories,
    )
    expect(chips.map((c) => c.label)).toEqual([
      'Factory is Marketing site',
      'Status is Queued',
      'Archived: Only',
    ])
    expect(chips[1]?.clear({ statuses: ['queued'], archived: 'only' })).toEqual({
      archived: 'only',
    })
  })

  test('a Factory group filter shows every Factory now in the group, and a gone group filters nothing', () => {
    const grouped: FactoryLayout = {
      items: [{ factoryId: 'nb' }, { group: { id: 'g1', name: 'Clients', factoryIds: ['ms'] } }],
    }
    const filters = { factoryGroups: ['g1'] }
    expect(ids(filterTasks(all, filters, '', grouped))).toEqual(['MS-1'])
    expect(ids(filterTasks(all, { ...filters, factories: ['nb'] }, '', grouped))).toContain('NB-1')
    const later: FactoryLayout = {
      items: [{ group: { id: 'g1', name: 'Clients', factoryIds: ['ms', 'nb'] } }],
    }
    expect(ids(filterTasks(all, filters, '', later))).toEqual(ids(filterTasks(all, {})))
    const emptied: FactoryLayout = {
      items: [{ group: { id: 'g1', name: 'Clients', factoryIds: [] } }],
    }
    expect(filterTasks(all, filters, '', emptied)).toEqual([])
    expect(ids(filterTasks(all, filters, '', { items: [] }))).toEqual(ids(filterTasks(all, {})))
    expect(activeFilterCount(filters, grouped)).toBe(1)
    expect(activeFilterCount(filters, { items: [] })).toBe(0)
    expect(filterChips(filters, factories, grouped).map((c) => c.label)).toEqual([
      'Factory group is Clients',
    ])
    expect(filterChips(filters, factories, { items: [] })).toEqual([])
  })
})

describe('sort and group', () => {
  const a = task({ displayId: 'NB-10', priority: 'low', rank: 1, title: 'Bravo', stage: 'work' })
  const b = task({ displayId: 'NB-11', priority: 'urgent', rank: 5, title: 'Alpha', stage: 'done' })
  const c = task({ displayId: 'NB-12', priority: 'low', rank: 0.5, title: 'Charlie' })
  const d = task({
    displayId: 'MS-10',
    factoryId: 'ms',
    priority: 'none',
    rank: 2,
    title: 'Delta',
    stage: 'intake',
    status: { kind: 'queued', place: 1 },
    statuses: ['queued'],
    updatedAt: '2026-11-09T00:00:00Z',
  })
  const all = [a, b, c, d]

  test('Manual sorts by Priority, then rank', () => {
    expect(ids(sortTasks(all, 'manual'))).toEqual(['NB-11', 'NB-12', 'NB-10', 'MS-10'])
  })

  test('the other sorts', () => {
    expect(ids(sortTasks(all, 'title'))).toEqual(['NB-11', 'NB-10', 'NB-12', 'MS-10'])
    expect(ids(sortTasks(all, 'stage'))).toEqual(['NB-12', 'MS-10', 'NB-10', 'NB-11'])
    expect(ids(sortTasks(all, 'updated'))[0]).toBe('MS-10')
  })

  test('grouping by Stage follows the Stage order and starts with Done collapsed', () => {
    const groups = groupTasks(all, defaultView('all'), factories)
    expect(groups.map((g) => [g.label, ids(g.tasks), g.collapsed])).toEqual([
      ['Backlog', ['NB-12'], false],
      ['Intake', ['MS-10'], false],
      ['Work', ['NB-10'], false],
      ['Done', ['NB-11'], true],
    ])
  })

  test('grouping by Factory, Status, Priority or None', () => {
    const view = defaultView('all')
    expect(groupTasks(all, { ...view, group: 'factory' }, factories).map((g) => g.label)).toEqual([
      'Notebook',
      'Marketing site',
    ])
    expect(groupTasks(all, { ...view, group: 'status' }, factories).map((g) => g.label)).toEqual([
      'Queued',
      'No status',
    ])
    expect(groupTasks(all, { ...view, group: 'priority' }, factories).map((g) => g.label)).toEqual([
      'Urgent',
      'Low',
      'No priority',
    ])
    expect(
      groupTasks(all, { ...view, group: 'none' }, factories).map((g) => g.tasks.length),
    ).toEqual([4])
  })

  test('grouping by Factory group follows the layout, then No group', () => {
    const layout: FactoryLayout = {
      items: [{ factoryId: 'nb' }, { group: { id: 'g1', name: 'Clients', factoryIds: ['ms'] } }],
    }
    const view = { ...defaultView('all'), group: 'factory-group' as const }
    expect(
      groupTasks(all, view, factories, [], layout).map((g) => [g.label, ids(g.tasks)]),
    ).toEqual([
      ['Clients', ['MS-10']],
      ['No Factory group', ['NB-11', 'NB-12', 'NB-10']],
    ])
  })
})

describe('the queue', () => {
  test('the Queue column shows only with Status = Queued, Manual and Group None', () => {
    const view = queueView('all')
    expect(isQueueMode(view)).toBe(true)
    expect(isQueueMode({ ...view, sort: 'priority' })).toBe(false)
    expect(isQueueMode({ ...view, group: 'factory' })).toBe(false)
    expect(isQueueMode({ ...view, filters: { statuses: ['queued', 'working'] } })).toBe(false)
  })

  test('the summary names the machine-wide queue', () => {
    const queued = [task({ displayId: 'NB-30' }), task({ displayId: 'MS-30' })]
    expect(summaryLine(queued, queued, queueView('all'), 'all', factories)).toBe(
      '2 Tasks · machine-wide queue, in start order',
    )
  })
})

describe('dragging', () => {
  const list = ['NB-1', 'NB-2', 'NB-3', 'NB-4'].map((displayId) => task({ displayId }))

  test('a drop lands between its new neighbours', () => {
    expect(neighbours(list, 'NB-4', 1)).toEqual({ after: 'NB-1', before: 'NB-2' })
    expect(neighbours(list, 'NB-1', 0)).toEqual({ before: 'NB-2' })
    expect(neighbours(list, 'NB-1', 3)).toEqual({ after: 'NB-4' })
  })

  test('⌥↑ and ⌥↓ move a Task past one neighbour of the same Priority', () => {
    expect(rankMove(list, 'NB-3', 'up')).toEqual({ after: 'NB-1', before: 'NB-2' })
    expect(rankMove(list, 'NB-2', 'up')).toEqual({ before: 'NB-1' })
    expect(rankMove(list, 'NB-2', 'down')).toEqual({ after: 'NB-3', before: 'NB-4' })
    expect(rankMove(list, 'NB-3', 'down')).toEqual({ after: 'NB-4' })
    expect(rankMove(list, 'NB-1', 'up')).toBeUndefined()
    expect(rankMove(list, 'NB-4', 'down')).toBeUndefined()
    const urgent = task({ displayId: 'NB-9', priority: 'urgent' })
    expect(rankMove([urgent, ...list], 'NB-1', 'up')).toBeUndefined()
  })

  test('while dragging, empty groups that accept a drop still show', () => {
    const backlog = task({ displayId: 'NB-50' })
    const view = defaultView('nb')
    expect(groupTasks([backlog], view, factories).map((g) => g.key)).toEqual(['backlog'])
    expect(
      groupTasks([backlog], view, factories, dropTargets('stage')).map((g) => [
        g.key,
        g.tasks.length,
      ]),
    ).toEqual([
      ['backlog', 1],
      ['intake', 0],
    ])
  })

  test('only Backlog → Intake starts and Queued → Backlog un-starts between Stage groups', () => {
    const backlog = task({ displayId: 'NB-40' })
    const queued = task({
      displayId: 'NB-41',
      stage: 'intake',
      status: { kind: 'queued', place: 1 },
      statuses: ['queued'],
    })
    const working = task({ displayId: 'NB-42', stage: 'intake', statuses: ['working'] })
    expect(dropAction(backlog, 'stage', 'backlog', 'backlog')).toBe('reorder')
    expect(dropAction(backlog, 'stage', 'backlog', 'intake')).toBe('start')
    expect(dropAction(backlog, 'stage', 'backlog', 'work')).toBeUndefined()
    expect(dropAction(queued, 'stage', 'intake', 'backlog')).toBe('unstart')
    expect(dropAction(working, 'stage', 'intake', 'backlog')).toBeUndefined()
    expect(dropAction(backlog, 'priority', 'none', 'high')).toBe('reorder')
  })
})

describe('selection', () => {
  const list = ['NB-1', 'NB-2', 'NB-3', 'NB-4'].map((displayId) => task({ displayId }))

  test('⇧-click selects the range from the anchor, either way', () => {
    expect(selectionRange(list, 'NB-2', 'NB-4')).toEqual(['NB-2', 'NB-3', 'NB-4'])
    expect(selectionRange(list, 'NB-4', 'NB-1')).toEqual(['NB-1', 'NB-2', 'NB-3', 'NB-4'])
    expect(selectionRange(list, undefined, 'NB-3')).toEqual(['NB-3'])
  })

  test('on the Board, ⇧-click selects a range in the anchor’s column and toggles from another', () => {
    const column = list.slice(0, 3)
    expect(columnSelection(['NB-1', 'NB-4'], column, 'NB-1', 'NB-3')).toEqual([
      'NB-4',
      'NB-1',
      'NB-2',
      'NB-3',
    ])
    expect(columnSelection(['NB-4'], column, 'NB-4', 'NB-2')).toEqual(['NB-4', 'NB-2'])
    expect(columnSelection(['NB-4', 'NB-2'], column, 'NB-4', 'NB-2')).toEqual(['NB-4'])
    expect(columnSelection([], column, undefined, 'NB-2')).toEqual(['NB-2'])
  })

  test('Start says how many selected Tasks start now and how many wait for a Run slot', () => {
    const slots = (fields: Partial<RunSlots> = {}): RunSlots => ({
      limit: 4,
      working: 2,
      queued: 0,
      holders: [],
      queue: [],
      factories: [],
      ...fields,
    })
    const three = list.slice(0, 3)
    expect(startSplit(slots(), three)).toEqual({ now: 2, wait: 1 })
    expect(startSplit(slots({ working: 0 }), three)).toEqual({ now: 3, wait: 0 })
    expect(
      startSplit(slots({ factories: [{ factoryId: 'nb', cap: 3, working: 2 }] }), three),
    ).toEqual({ now: 1, wait: 2 })
    expect(startSplit(slots({ busy: { loadRatio: 2 } }), three)).toEqual({ now: 0, wait: 3 })
    expect(startSplit(slots({ working: 0, busy: { memoryAvailable: 0.05 } }), three)).toEqual({
      now: 1,
      wait: 2,
    })
    const queued = {
      kind: 'task' as const,
      place: 1,
      taskId: 'NB-9',
      displayId: 'NB-9',
      title: 'Queued first',
      factoryId: 'nb',
      priority: 'none' as const,
    }
    expect(startSplit(slots({ queued: 1, queue: [queued] }), three)).toEqual({ now: 1, wait: 2 })
    const chat = {
      kind: 'coordinator' as const,
      place: 1,
      runId: 'c1',
      factoryId: 'nb',
      name: 'Coordinator',
    }
    expect(startSplit(slots({ queued: 1, queue: [chat] }), three)).toEqual({ now: 2, wait: 1 })

    expect(startWaitLine({ now: 3, wait: 0 })).toBeUndefined()
    expect(startWaitLine({ now: 2, wait: 3 })).toBe('2 start now, 3 wait for a Run slot')
    expect(startWaitLine({ now: 1, wait: 1 })).toBe('1 starts now, 1 waits for a Run slot')
    expect(startWaitLine({ now: 0, wait: 3 })).toBe('All 3 wait for a Run slot')
    expect(startWaitLine({ now: 0, wait: 1 })).toBe('It waits for a Run slot')
  })
})

describe('Show all from the Board’s Done column', () => {
  test('opens the List with only Done Tasks, newest first and ungrouped', () => {
    const done = [
      task({ displayId: 'NB-1', stage: 'done', updatedAt: '2026-11-01T00:00:00Z' }),
      task({ displayId: 'NB-2', stage: 'done', updatedAt: '2026-11-05T00:00:00Z' }),
      task({ displayId: 'NB-3', stage: 'work' }),
    ]
    const view = doneView('nb')

    expect(view).toMatchObject({ sort: 'updated', group: 'none', filters: { stages: ['done'] } })
    const shown = sortTasks(filterTasks(done, view.filters), view.sort)
    expect(shown.map((t) => t.displayId)).toEqual(['NB-2', 'NB-1'])
  })
})

describe('empty groups', () => {
  test.each(['stage', 'factory', 'factory-group', 'status', 'priority'] as ListGroup[])(
    '%s groups stay visible after all Tasks are filtered out when enabled',
    (group) => {
      const view = { ...defaultView('all'), group, showEmptyGroups: true }
      const filtered = filterTasks([task({ displayId: 'NB-90' })], {}, 'no match')
      const groups = groupTasks(filtered, view, factories)
      expect(groups.length).toBeGreaterThan(0)
      expect(groups.every((g) => g.tasks.length === 0)).toBe(true)
      expect(groupTasks(filtered, { ...view, showEmptyGroups: false }, factories)).toEqual([])
      expect(groupTasks(filtered, { ...defaultView('all'), group }, factories)).toEqual([])
    },
  )

  test('all Priority groups appear in order beside populated groups', () => {
    const view = { ...defaultView('all'), group: 'priority' as const, showEmptyGroups: true }
    const tasks = [task({ displayId: 'NB-91', priority: 'high' })]
    expect(groupTasks(tasks, view, factories).map((g) => [g.key, g.tasks.length])).toEqual([
      ['urgent', 0],
      ['high', 1],
      ['medium', 0],
      ['low', 0],
      ['none', 0],
    ])
    expect(
      groupTasks(tasks, { ...view, showEmptyGroups: false }, factories).map((g) => g.key),
    ).toEqual(['high'])
  })

  test('None never adds an empty group', () => {
    expect(
      groupTasks([], { ...defaultView('all'), group: 'none', showEmptyGroups: true }, factories),
    ).toEqual([])
  })
})

describe('nestedRows', () => {
  const shape = (rows: ReturnType<typeof nestedRows>) =>
    rows.map((r) => [r.task.displayId, r.depth, r.hasChildren])

  test('nests children under a parent in the same group and keeps the group order', () => {
    const parent = task({ displayId: 'NB-40', childIds: ['NB-41', 'NB-42'] })
    const first = task({ displayId: 'NB-41', parentId: 'NB-40', childIds: ['NB-43'] })
    const second = task({ displayId: 'NB-42', parentId: 'NB-40' })
    const grandchild = task({ displayId: 'NB-43', parentId: 'NB-41' })
    const other = task({ displayId: 'NB-44' })
    expect(shape(nestedRows([second, other, grandchild, parent, first], new Set()))).toEqual([
      ['NB-44', 0, false],
      ['NB-40', 0, true],
      ['NB-42', 1, false],
      ['NB-41', 1, true],
      ['NB-43', 2, false],
    ])
  })

  test('a child whose parent is in another group stays at the top level', () => {
    const child = task({ displayId: 'NB-51', parentId: 'NB-50' })
    const loose = task({ displayId: 'NB-52' })
    expect(shape(nestedRows([child, loose], new Set()))).toEqual([
      ['NB-51', 0, false],
      ['NB-52', 0, false],
    ])
  })

  test('a collapsed parent hides all its descendants', () => {
    const parent = task({ displayId: 'NB-60', childIds: ['NB-61'] })
    const child = task({ displayId: 'NB-61', parentId: 'NB-60', childIds: ['NB-62'] })
    const grandchild = task({ displayId: 'NB-62', parentId: 'NB-61' })
    const after = task({ displayId: 'NB-63' })
    expect(shape(nestedRows([parent, child, grandchild, after], new Set(['NB-60'])))).toEqual([
      ['NB-60', 0, true],
      ['NB-63', 0, false],
    ])
    expect(shape(nestedRows([parent, child, grandchild, after], new Set(['NB-61'])))).toEqual([
      ['NB-60', 0, true],
      ['NB-61', 1, true],
      ['NB-63', 0, false],
    ])
  })

  test('a parent from another group shows faded above its children there, with its own ancestors', () => {
    const root = task({ displayId: 'NB-80', stage: 'clarify' })
    const parent = task({ displayId: 'NB-81', parentId: 'NB-80', stage: 'clarify' })
    const child = task({ displayId: 'NB-82', parentId: 'NB-81' })
    const sibling = task({ displayId: 'NB-83', parentId: 'NB-81' })
    const loose = task({ displayId: 'NB-84' })
    const every = [root, parent, child, sibling, loose]
    const rows = nestedRows([child, loose, sibling], new Set(), every)
    expect(rows.map((r) => [r.task.displayId, r.depth, r.hasChildren, r.context === true])).toEqual(
      [
        ['NB-80', 0, true, true],
        ['NB-81', 1, true, true],
        ['NB-82', 2, false, false],
        ['NB-83', 2, false, false],
        ['NB-84', 0, false, false],
      ],
    )
    expect(
      nestedRows([parent, child], new Set(), every).map((r) => [r.task.displayId, r.context]),
    ).toEqual([
      ['NB-80', true],
      ['NB-81', undefined],
      ['NB-82', undefined],
    ])
    expect(shape(nestedRows([child], new Set(['NB-81']), every))).toEqual([
      ['NB-80', 0, true],
      ['NB-81', 1, true],
    ])
  })

  test('a parent cycle shows every Task once without looping', () => {
    const a = task({ displayId: 'NB-70', parentId: 'NB-71' })
    const b = task({ displayId: 'NB-71', parentId: 'NB-70' })
    const tail = task({ displayId: 'NB-72', parentId: 'NB-71' })
    const self = task({ displayId: 'NB-73', parentId: 'NB-73' })
    expect(shape(nestedRows([tail, a, b, self], new Set()))).toEqual([
      ['NB-70', 0, true],
      ['NB-71', 1, true],
      ['NB-72', 2, false],
      ['NB-73', 0, false],
    ])
  })
})
