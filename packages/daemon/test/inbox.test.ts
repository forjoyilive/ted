import type { Comment, CommentAnswer, Priority, Task } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { answered, waiting } from '../src/tasks/inbox.ts'

const task = (id: string, priority: Priority, extra: Partial<Task> = {}) =>
  ({ id, displayId: id, factoryId: 'nb', priority, ...extra }) as Task

const request = (
  id: string,
  taskId: string,
  createdAt: string,
  extra: Partial<Comment> = {},
): Comment => ({
  id,
  taskId,
  kind: 'question',
  body: id,
  author: { kind: 'run', runId: 'r' },
  createdAt,
  ...extra,
})

const at = (answer: CommentAnswer) => ({ answer })

describe('Inbox order', () => {
  test('waiting requests sort by the Task’s Priority, Urgent first, then oldest first', () => {
    const tasks = [task('low', 'low'), task('urgent', 'urgent'), task('none', 'none')]
    const items = waiting(
      [
        request('a', 'low', '2026-11-01T10:00:00Z'),
        request('b', 'none', '2026-11-01T09:00:00Z'),
        request('c', 'urgent', '2026-11-01T11:00:00Z'),
        request('d', 'low', '2026-11-01T08:00:00Z'),
      ],
      tasks,
    )
    expect(items.map((i) => i.request.id)).toEqual(['c', 'd', 'a', 'b'])
  })

  test('notes, answered requests and archived Tasks’ requests aren’t waiting', () => {
    const tasks = [task('t', 'none'), task('gone', 'none', { archived: { at: '' } as never })]
    const items = waiting(
      [
        request('note', 't', '2026-11-01T10:00:00Z', { kind: 'note' }),
        request('done', 't', '2026-11-01T10:00:00Z', at({ kind: 'approved', at: 'x' })),
        request('archived', 'gone', '2026-11-01T10:00:00Z'),
        request('open', 't', '2026-11-01T10:00:00Z'),
      ],
      tasks,
    )
    expect(items.map((i) => i.request.id)).toEqual(['open'])
  })
})

describe('Answered', () => {
  const now = new Date('2026-11-30T12:00:00Z')
  const tasks = [task('t', 'urgent')]

  test('lists what the human answered in the last 30 days, newest answer first', () => {
    const items = answered(
      [
        request(
          'old',
          't',
          '2026-10-01T00:00:00Z',
          at({ kind: 'answered', at: '2026-10-30T11:00:00Z' }),
        ),
        request(
          'a',
          't',
          '2026-11-01T00:00:00Z',
          at({ kind: 'approved', at: '2026-11-02T00:00:00Z' }),
        ),
        request(
          'b',
          't',
          '2026-11-03T00:00:00Z',
          at({ kind: 'denied', at: '2026-11-29T00:00:00Z' }),
        ),
        request('c', 't', '2026-11-04T00:00:00Z', {
          kind: 'review',
          ...at({ kind: 'changes-requested', at: '2026-11-10T00:00:00Z', text: 'Split it' }),
        }),
        request('open', 't', '2026-11-05T00:00:00Z'),
      ],
      tasks,
      now,
    )
    expect(items.map((i) => i.request.id)).toEqual(['b', 'c', 'a'])
  })

  test('withdrawn and superseded requests weren’t answered, so they aren’t listed', () => {
    const items = answered(
      [
        request(
          'w',
          't',
          '2026-11-01T00:00:00Z',
          at({ kind: 'withdrawn', at: '2026-11-20T00:00:00Z', archived: true }),
        ),
        request(
          's',
          't',
          '2026-11-01T00:00:00Z',
          at({ kind: 'superseded', at: '2026-11-20T00:00:00Z', by: 'x' }),
        ),
      ],
      tasks,
      now,
    )
    expect(items).toEqual([])
  })
})
