import { describe, expect, test } from 'vitest'
import type { LinearWorkflowState } from '../src/linear/linear.ts'
import { isClosedType, linearMove, pickState } from '../src/tasks/linear-sync.ts'

const states: LinearWorkflowState[] = [
  { id: 'todo', name: 'Todo', type: 'unstarted', position: 0 },
  { id: 'progress', name: 'In Progress', type: 'started', position: 1 },
  { id: 'review', name: 'In Review', type: 'started', position: 2 },
  { id: 'done', name: 'Done', type: 'completed', position: 3 },
]
const progress = { name: 'In Progress', type: 'started' }

describe('Linear sync decisions', () => {
  test('a team without a review state skips the move and can still progress to Done', () => {
    const withoutReview = states.filter((state) => state.id !== 'review')
    expect(linearMove({ stage: 'merge' }, false, 'started', progress)).toEqual({
      step: 'review',
      move: true,
    })
    expect(pickState(withoutReview, 'review')).toBeUndefined()
    const done = linearMove({ stage: 'done' }, true, 'review', progress)
    expect(done).toEqual({ step: 'done', move: true })
    expect(pickState(withoutReview, 'done')?.id).toBe('done')
  })

  test('an issue already further along records progress without moving backward', () => {
    expect(
      linearMove({ stage: 'work' }, false, undefined, { name: 'In Review', type: 'started' }),
    ).toEqual({
      step: 'started',
      move: false,
    })
    expect(
      linearMove({ stage: 'merge' }, false, 'started', { name: 'In Review', type: 'started' }),
    ).toEqual({
      step: 'review',
      move: false,
    })
  })

  test('recorded steps never repeat or move backward', () => {
    expect(linearMove({ stage: 'work' }, false, 'review', progress)).toBeUndefined()
    expect(linearMove({ stage: 'merge' }, false, 'review', progress)).toBeUndefined()
    expect(linearMove({ stage: 'done' }, true, 'done', progress)).toBeUndefined()
  })

  test('only a merged Task targets Done; inactive Tasks have no target', () => {
    expect(linearMove({ stage: 'backlog' }, false, undefined, progress)).toBeUndefined()
    expect(linearMove({ stage: 'done' }, false, undefined, progress)).toBeUndefined()
    expect(
      linearMove(
        {
          stage: 'work',
          archived: { at: '2026-11-09T00:00:00Z', ended: { kind: 'never-started' } },
        },
        false,
        undefined,
        progress,
      ),
    ).toBeUndefined()
    expect(
      linearMove(
        {
          stage: 'done',
          archived: { at: '2026-11-09T00:00:00Z', ended: { kind: 'never-started' } },
        },
        true,
        undefined,
        progress,
      ),
    ).toEqual({ step: 'done', move: true })
  })

  test.each(['completed', 'canceled'])('an open Task leaves a %s issue alone', (type) => {
    expect(isClosedType(type)).toBe(true)
    expect(
      linearMove({ stage: 'work' }, false, undefined, { name: 'Closed', type }),
    ).toBeUndefined()
  })

  test('state selection prefers conventional names, then position, without mutating the list', () => {
    const alternatives = [
      { id: 'doing', name: 'Doing', type: 'started', position: -2 },
      { id: 'reviewing', name: 'Code Review', type: 'started', position: -1 },
      { id: 'finished', name: 'Finished', type: 'completed', position: -3 },
      ...states,
    ]
    const before = [...alternatives]
    expect(pickState(alternatives, 'started')?.id).toBe('progress')
    expect(pickState(alternatives, 'review')?.id).toBe('review')
    expect(pickState(alternatives, 'done')?.id).toBe('done')
    expect(pickState(alternatives.slice(0, 3), 'started')?.id).toBe('doing')
    expect(pickState(alternatives.slice(0, 3), 'review')?.id).toBe('reviewing')
    expect(pickState(alternatives.slice(0, 3), 'done')?.id).toBe('finished')
    expect(alternatives).toEqual(before)
  })
})
