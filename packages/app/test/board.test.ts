import type { BoardStage, BoardView, QueuedForSlot, StageId, Task } from '@ted/protocol'
import { defaultBoardView } from '@ted/protocol/board-view'
import { describe, expect, test } from 'vitest'
import {
  boardColumns,
  boardDrop,
  boardLayout,
  boardViewFor,
  canStart,
  cardActivity,
  doneCardLine,
  mergedLine,
  placeCard,
  startPlace,
  startStage,
  withoutBlockers,
} from '../src/renderer/board.ts'

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
    createdAt: '2026-11-06T10:00:00Z',
    updatedAt: '2026-11-06T10:00:00Z',
    ...fields,
  }
}

const on = (id: StageId, gate = false): BoardStage => ({ id, enabled: true, gate })
const off = (id: StageId, gate = false): BoardStage => ({ id, enabled: false, gate })

const queued = (displayId: string, place: number, fields: Partial<Task> = {}) =>
  task({
    displayId,
    stage: 'intake',
    statuses: ['queued'],
    status: { kind: 'queued', place },
    ...fields,
  })

const ids = (tasks: readonly Task[]) => tasks.map((t) => t.displayId)

describe('Board columns', () => {
  test('follow the Workflow’s enabled Stages, with Gates marked', () => {
    const columns = boardColumns(
      [on('backlog'), on('intake'), on('design', true), on('work'), on('done')],
      [],
    )

    expect(columns.map((c) => [c.stage, c.gate, c.turnedOff])).toEqual([
      ['backlog', false, false],
      ['intake', false, false],
      ['design', true, false],
      ['work', false, false],
      ['done', false, false],
    ])
  })

  test('a turned-off Stage shows only while it holds Tasks, marked Turned off', () => {
    const stages = [on('backlog'), on('intake'), off('design', true), on('work'), on('done')]
    expect(boardColumns(stages, []).map((c) => c.stage)).not.toContain('design')

    const columns = boardColumns(stages, [task({ displayId: 'NB-1', stage: 'design' })])

    const design = columns.find((c) => c.stage === 'design')
    expect(design).toMatchObject({ turnedOff: true, gate: true })
    expect(columns.map((c) => c.stage)).toEqual(['backlog', 'intake', 'design', 'work', 'done'])
  })

  test('a Stage the Workflow no longer lists keeps a turned-off column in its built-in place', () => {
    const columns = boardColumns(
      [on('backlog'), on('intake'), on('work'), on('done')],
      [task({ displayId: 'NB-1', stage: 'clarify' })],
    )

    expect(columns.map((c) => [c.stage, c.turnedOff])).toEqual([
      ['backlog', false],
      ['intake', false],
      ['clarify', true],
      ['work', false],
      ['done', false],
    ])
  })

  test('order cards by Priority, then rank, and leave archived Tasks off', () => {
    const columns = boardColumns(
      [on('backlog'), on('done')],
      [
        task({ displayId: 'NB-1', priority: 'low', rank: 1 }),
        task({ displayId: 'NB-2', priority: 'urgent', rank: 5 }),
        task({ displayId: 'NB-3', priority: 'low', rank: 0.5 }),
        task({
          displayId: 'NB-4',
          priority: 'urgent',
          archived: { at: '2026-11-07T00:00:00Z', ended: { kind: 'never-started' } },
        }),
      ],
    )

    expect(ids(columns[0]?.tasks ?? [])).toEqual(['NB-2', 'NB-3', 'NB-1'])
  })

  test('Queued cards sit at the top of the first Stage, in queue order', () => {
    const columns = boardColumns(
      [on('backlog'), on('intake'), on('done')],
      [
        task({ displayId: 'NB-1', stage: 'intake', priority: 'urgent', statuses: ['working'] }),
        queued('NB-2', 2, { rank: 9 }),
        queued('NB-3', 1, { priority: 'high', rank: 10 }),
      ],
    )

    expect(ids(columns[1]?.tasks ?? [])).toEqual(['NB-3', 'NB-2', 'NB-1'])
  })

  test('the start Stage is the first enabled Stage after Backlog', () => {
    expect(startStage([on('backlog'), off('intake'), on('clarify'), on('done')])).toBe('clarify')
    expect(startStage([on('backlog'), on('done')])).toBeUndefined()
  })
})

describe('Board drag rules', () => {
  const backlogCard = task({ displayId: 'NB-1' })

  test('Backlog to the start Stage starts the Task; other columns refuse it', () => {
    expect(boardDrop(backlogCard, 'backlog', 'intake', 'intake')).toBe('start')
    expect(boardDrop(backlogCard, 'backlog', 'work', 'intake')).toBeUndefined()
    expect(boardDrop(backlogCard, 'backlog', 'done', 'intake')).toBeUndefined()
  })

  test('a blocked Backlog Task can’t be started by a drop, nor has a Start button', () => {
    const blocked = task({ displayId: 'NB-2', markers: [{ kind: 'blocked-by', by: 'NB-9' }] })
    expect(boardDrop(blocked, 'backlog', 'intake', 'intake')).toBeUndefined()
    expect(canStart(blocked)).toBe(false)
    expect(canStart(backlogCard)).toBe(true)
    expect(canStart(task({ displayId: 'NB-3', stage: 'intake' }))).toBe(false)
  })

  test('a Queued Task that never had a Run goes back to Backlog; a working one doesn’t', () => {
    expect(boardDrop(queued('NB-4', 1), 'intake', 'backlog', 'intake')).toBe('unstart')
    const working = task({ displayId: 'NB-5', stage: 'intake', leadRunId: 'r1' })
    expect(boardDrop(working, 'intake', 'backlog', 'intake')).toBeUndefined()
    expect(boardDrop(working, 'intake', 'work', 'intake')).toBeUndefined()
  })

  test('within a column a drop reorders, except in Done', () => {
    expect(boardDrop(backlogCard, 'backlog', 'backlog', 'intake')).toBe('reorder')
    const done = task({ displayId: 'NB-6', stage: 'done' })
    expect(boardDrop(done, 'done', 'done', 'intake')).toBeUndefined()
  })
})

describe('placing a dropped card', () => {
  const backlog = boardColumns(
    [on('backlog'), on('intake'), on('done')],
    [
      task({ displayId: 'NB-1', priority: 'high' }),
      task({ displayId: 'NB-2', priority: 'high' }),
      task({ displayId: 'NB-3', priority: 'low' }),
    ],
  )[0]

  test('names the cards it now sits between', () => {
    if (!backlog) throw new Error('no column')
    const moving = backlog.tasks[2] as Task
    expect(placeCard(backlog, moving, 'reorder', 1, 'intake')).toEqual({
      index: 1,
      after: 'NB-1',
      before: 'NB-2',
    })
    expect(placeCard(backlog, moving, 'reorder', 0, 'intake')).toEqual({
      index: 0,
      before: 'NB-1',
    })
  })

  const intake = boardColumns(
    [on('backlog'), on('intake'), on('done')],
    [
      queued('NB-7', 3),
      queued('NB-8', 4),
      task({ displayId: 'NB-9', stage: 'intake', leadRunId: 'r1', statuses: ['working'] }),
    ],
  )[1]

  test('a started card joins the Queued cards, never below the ones already running', () => {
    if (!intake) throw new Error('no column')
    const moving = task({ displayId: 'NB-1' })
    expect(placeCard(intake, moving, 'start', 3, 'intake')).toEqual({ index: 2, after: 'NB-8' })
    expect(placeCard(intake, moving, 'start', 1, 'intake')).toEqual({
      index: 1,
      after: 'NB-7',
      before: 'NB-8',
    })
  })

  test('a running card in the start column stays below the Queued cards', () => {
    if (!intake) throw new Error('no column')
    const running = intake.tasks[2] as Task
    expect(placeCard(intake, running, 'reorder', 0, 'intake')).toEqual({ index: 2 })
  })

  test('the drop slot says which place in the queue a start takes', () => {
    const queue: QueuedForSlot[] = [
      {
        kind: 'task',
        place: 1,
        taskId: 'MS-1',
        displayId: 'MS-1',
        title: '',
        factoryId: 'ms',
        priority: 'urgent',
      },
      {
        kind: 'task',
        place: 2,
        taskId: 'MS-2',
        displayId: 'MS-2',
        title: '',
        factoryId: 'ms',
        priority: 'none',
      },
      {
        kind: 'task',
        place: 3,
        taskId: 'NB-7',
        displayId: 'NB-7',
        title: '',
        factoryId: 'nb',
        priority: 'none',
      },
      {
        kind: 'task',
        place: 4,
        taskId: 'NB-8',
        displayId: 'NB-8',
        title: '',
        factoryId: 'nb',
        priority: 'none',
      },
    ]
    const moving = task({ displayId: 'NB-1' })
    expect(startPlace({ index: 2, after: 'NB-8' }, moving, queue)).toBe(5)
    expect(startPlace({ index: 1, after: 'NB-7', before: 'NB-8' }, moving, queue)).toBe(4)
    expect(startPlace({ index: 0 }, task({ displayId: 'NB-2', priority: 'high' }), queue)).toBe(2)
  })
})

describe('the card’s activity line', () => {
  const now = Date.parse('2026-11-08T10:00:00Z')

  test('is the Task’s own line when it has one', () => {
    const reading = task({ displayId: 'NB-1', stage: 'work', activity: 'Reading notes' })
    expect(cardActivity(reading, now)).toBe('Reading notes')
  })

  test('says who created a Backlog Task and when, in place of Not started', () => {
    const fresh = task({ displayId: 'NB-1', activity: 'Not started' })
    expect(cardActivity(fresh, now)).toBe('Created by you · 2d ago')
  })

  test('says when a blocked Task starts, and that a Queued one waits for a slot', () => {
    const blocked = task({
      displayId: 'NB-2',
      markers: [{ kind: 'blocked-by', by: 'NB-41' }],
      activity: 'Starts when NB-41 merges',
    })
    expect(cardActivity(blocked, now)).toBe('Starts when NB-41 merges')
    expect(cardActivity(queued('NB-3', 1), now)).toBe('Waiting for a free Run slot')
    expect(cardActivity(task({ displayId: 'NB-4', stage: 'work' }), now)).toBeUndefined()
  })
})

describe('the Done column', () => {
  const now = Date.parse('2026-11-09T12:00:00Z')
  const done = (displayId: string, at: string, fields: Partial<Task> = {}) =>
    task({ displayId, stage: 'done', merged: { at, pullRequests: [] }, ...fields })
  const stages = [on('backlog'), on('work'), on('done')]

  test('shows Tasks that reached Done in the last 7 days, newest first, and counts them all', () => {
    const columns = boardColumns(
      stages,
      [
        done('NB-24', '2026-11-03T12:00:00Z', { priority: 'urgent' }),
        done('NB-28', '2026-11-09T10:00:00Z'),
        done('NB-20', '2026-11-01T12:00:00Z'),
        done('NB-27', '2026-11-08T12:00:00Z'),
        done('NB-19', '2026-10-30T12:00:00Z', {
          archived: { at: '2026-11-01T00:00:00Z', ended: { kind: 'merged', at: '' } },
        }),
      ],
      now,
    )

    const column = columns.find((c) => c.stage === 'done')
    expect(ids(column?.tasks ?? [])).toEqual(['NB-28', 'NB-27', 'NB-24'])
    expect(column?.allDone).toBe(4)
  })

  test('cards read the ID and when it merged', () => {
    expect(doneCardLine(done('NB-28', '2026-11-09T10:00:00Z'), now)).toBe('NB-28 · Merged 2h ago')
  })

  test('a Done Task’s activity line names its pull requests', () => {
    const merged = done('NB-28', '2026-11-09T10:00:00Z', {
      merged: { at: '2026-11-09T10:00:00Z', pullRequests: [470, 88] },
    })
    expect(mergedLine(merged, now)).toBe('Merged 2h ago · PR #470, #88')
    expect(mergedLine(done('NB-27', '2026-11-08T12:00:00Z'), now)).toBe('Merged 1d ago')
    expect(mergedLine(task({ displayId: 'NB-1', stage: 'work' }), now)).toBeUndefined()
  })
})

describe('the Board’s Display choices', () => {
  const now = Date.parse('2026-11-09T12:00:00Z')
  const stages = [on('backlog'), on('intake'), on('design', true), on('work'), on('done')]
  const waiting = task({
    displayId: 'NB-1',
    stage: 'design',
    statuses: ['waiting-on-you'],
    status: { kind: 'waiting-on-you' },
  })
  const failed = task({
    displayId: 'NB-2',
    stage: 'design',
    statuses: ['failed'],
    status: { kind: 'failed' },
  })
  const working = task({
    displayId: 'NB-3',
    stage: 'design',
    statuses: ['working'],
    status: { kind: 'working' },
  })
  const oldDone = task({
    displayId: 'NB-4',
    stage: 'done',
    merged: { at: '2026-10-01T12:00:00Z', pullRequests: [] },
  })
  const columns = boardColumns(
    stages,
    [task({ displayId: 'NB-5' }), waiting, failed, working, oldDone],
    now,
  )
  const view = (fields: Partial<BoardView>): BoardView => ({ ...defaultBoardView, ...fields })
  const shown = (fields: Partial<BoardView>, takesDrop?: (stage: StageId) => boolean) =>
    boardLayout(columns, view(fields), takesDrop).columns.map((c) => c.stage)

  test('a Factory without saved choices shows full cards, every field and every column', () => {
    expect(boardViewFor(undefined, 'nb')).toEqual(defaultBoardView)
    expect(boardViewFor({ other: view({ cardSize: 'compact' }) }, 'nb')).toEqual(defaultBoardView)
    expect(boardViewFor({ nb: view({ cardSize: 'compact' }) }, 'nb').cardSize).toBe('compact')
    expect(boardLayout(columns, defaultBoardView)).toEqual({ columns, hidden: [] })
  })

  test('a hidden column leaves the Board and is listed with its Tasks and those that need the user', () => {
    const layout = boardLayout(columns, view({ hiddenStages: ['done', 'design', 'backlog'] }))
    expect(layout.columns.map((c) => c.stage)).toEqual(['intake', 'work'])
    expect(layout.hidden).toEqual([
      { stage: 'backlog', count: 1, needsYou: 0 },
      { stage: 'design', count: 3, needsYou: 2 },
      { stage: 'done', count: 0, needsYou: 0 },
    ])
  })

  test('Hide empty columns drops columns without Tasks, but not a Done column with older Tasks', () => {
    expect(shown({ hideEmpty: true })).toEqual(['backlog', 'design', 'done'])
    const noDone = boardColumns(stages, [waiting], now)
    expect(boardLayout(noDone, view({ hideEmpty: true })).columns.map((c) => c.stage)).toEqual([
      'design',
    ])
  })

  test('an empty column that takes the dragged card is drawn; a hidden one stays hidden', () => {
    const takesIntake = (stage: StageId) => stage === 'intake'
    expect(shown({ hideEmpty: true }, takesIntake)).toEqual(['backlog', 'intake', 'design', 'done'])
    const layout = boardLayout(
      columns,
      view({ hideEmpty: true, hiddenStages: ['intake'] }),
      takesIntake,
    )
    expect(layout.columns.map((c) => c.stage)).toEqual(['backlog', 'design', 'done'])
    expect(layout.hidden).toEqual([{ stage: 'intake', count: 0, needsYou: 0 }])
  })

  test('with Blockers off a card loses its blocked status and keeps its other markers', () => {
    const blocked = task({
      displayId: 'NB-6',
      statuses: ['blocked'],
      status: { kind: 'blocked', by: 'NB-9' },
      markers: [{ kind: 'blocked-by', by: 'NB-9' }, { kind: 'needs-planning' }],
    })
    const plain = withoutBlockers(blocked)
    expect(plain.status).toBeUndefined()
    expect(plain.markers).toEqual([{ kind: 'needs-planning' }])
    expect(withoutBlockers(working).status).toEqual({ kind: 'working' })
  })
})
