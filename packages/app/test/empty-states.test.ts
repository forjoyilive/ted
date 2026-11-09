import type { Task } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { boardEmpty, inboxEmpty } from '../src/renderer/empty-states.ts'

describe('Inbox empty state', () => {
  test('nothing waiting offers Show answered', () => {
    expect(inboxEmpty({ showAnswered: false, anyTasks: true })).toEqual({
      title: 'Nothing waiting on you',
      action: 'show-answered',
    })
  })

  test('offers New Task instead when no Factory has any Task', () => {
    expect(inboxEmpty({ showAnswered: false, anyTasks: false })).toEqual({
      title: 'Nothing waiting on you',
      action: 'new-task',
    })
  })

  test('filtered to one Factory, names it and offers Show all Factories', () => {
    expect(inboxEmpty({ showAnswered: false, anyTasks: true, factoryName: 'Notebook' })).toEqual({
      title: 'Nothing waiting in Notebook',
      action: 'show-all-factories',
    })
  })

  test('the Answered view has no action', () => {
    expect(inboxEmpty({ showAnswered: true, anyTasks: true })).toEqual({
      title: 'Nothing answered in the last 30 days',
    })
    expect(inboxEmpty({ showAnswered: true, anyTasks: true, factoryName: 'Notebook' })).toEqual({
      title: 'Nothing answered in Notebook in the last 30 days',
    })
  })
})

const task = (fields: Partial<Task> = {}) =>
  ({ id: 'a', factoryId: 'nb', stage: 'backlog', priority: 'none', ...fields }) as Task

describe('Board empty state', () => {
  test('a Board with no Tasks says No Tasks yet, even when every Task is archived', () => {
    expect(boardEmpty([], {})).toBe('no-tasks')
    expect(
      boardEmpty(
        [task({ archived: { at: '2026-11-07T00:00:00Z', ended: { kind: 'never-started' } } })],
        {},
      ),
    ).toBe('no-tasks')
  })

  test('filters that hide every Task say so', () => {
    expect(boardEmpty([task()], { priorities: ['urgent'] })).toBe('no-matches')
  })

  test('a Board with Tasks showing has no empty state', () => {
    expect(boardEmpty([task()], {})).toBeUndefined()
    expect(boardEmpty([task({ priority: 'urgent' })], { priorities: ['urgent'] })).toBeUndefined()
  })
})
