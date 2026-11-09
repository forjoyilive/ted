import type { BoardStage, QueuedForSlot, StageId, Task } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import {
  boardColumns,
  boardDrop,
  canStart,
  cardActivity,
  placeCard,
  startPlace,
  startStage,
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
    repos: [],
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
