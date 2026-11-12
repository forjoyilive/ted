import type { InboxItem } from '@ted/protocol'
import { expect, test } from 'vitest'
import { inboxChange } from '../src/renderer/inbox-events.ts'
import { comment, task } from './support/fixtures.ts'

const items: InboxItem[] = [
  { request: comment({ id: 'c1' }), task: task({ id: 'a' }) },
  { request: comment({ id: 'c2' }), task: task({ id: 'b' }) },
  { request: comment({ id: 'c3' }), task: task({ id: 'a' }) },
]

const apply = (change: ReturnType<typeof inboxChange>, to = items) => {
  if (typeof change !== 'function') throw new Error(`expected an update, got ${String(change)}`)
  return change(to)
}

test.each(['waiting', 'answered'] as const)(
  'the %s list reloads for requests and what is waiting, not for notes or new Tasks',
  (list) => {
    expect(inboxChange({ type: 'inbox-changed', waiting: [] }, items, list)).toBe('reload')
    expect(inboxChange({ type: 'comment-posted', comment: comment() }, items, list)).toBe('reload')
    expect(inboxChange({ type: 'comment-updated', comment: comment() }, items, list)).toBe('reload')
    const note = comment({ kind: 'note' })
    expect(inboxChange({ type: 'comment-posted', comment: note }, items, list)).toBeUndefined()
    expect(inboxChange({ type: 'comment-updated', comment: note }, items, list)).toBeUndefined()
    expect(
      inboxChange({ type: 'task-created', task: task({ id: 'c' }) }, items, list),
    ).toBeUndefined()
    expect(inboxChange({ type: 'run-output', runId: 'r1' }, items, list)).toBeUndefined()
  },
)

test('a Task update replaces the Task on its items and an archived or deleted Task leaves', () => {
  const renamed = task({ id: 'a', title: 'Renamed', stage: 'work' })
  const next = apply(inboxChange({ type: 'task-updated', task: renamed }, items, 'waiting'))
  expect(next.map((item) => item.task.title)).toEqual(['Renamed', 'Sync notes', 'Renamed'])
  expect(next.map((item) => item.request.id)).toEqual(['c1', 'c2', 'c3'])
  expect(next[1]).toBe(items[1])

  const archived = task({ id: 'a', archived: true })
  for (const list of ['waiting', 'answered'] as const) {
    const left = apply(inboxChange({ type: 'task-updated', task: archived }, items, list))
    expect(left.map((item) => item.request.id)).toEqual(['c2'])
  }
  const deleted = apply(inboxChange({ type: 'task-deleted', taskId: 'b' }, items, 'waiting'))
  expect(deleted.map((item) => item.request.id)).toEqual(['c1', 'c3'])
})

test('a Task the list does not show changes nothing, except that Answered reloads for one that may be back', () => {
  const other = task({ id: 'z' })
  expect(apply(inboxChange({ type: 'task-updated', task: other }, items, 'waiting'))).toBe(items)
  expect(apply(inboxChange({ type: 'task-deleted', taskId: 'z' }, items, 'waiting'))).toBe(items)
  expect(inboxChange({ type: 'task-updated', task: other }, items, 'answered')).toBe(2000)
  const gone = task({ id: 'z', archived: true })
  expect(apply(inboxChange({ type: 'task-updated', task: gone }, items, 'answered'))).toBe(items)
  const loaded = apply(inboxChange({ type: 'task-updated', task: other }, [], 'waiting'), items)
  expect(loaded).toBe(items)
})
