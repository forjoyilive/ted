import type { Factory, InboxItem } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { inboxChips, inFactory, nextSelection } from '../src/renderer/inbox.ts'

const item = (id: string, factoryId = 'nb') =>
  ({ request: { id }, task: { id: `t-${id}`, factoryId } }) as unknown as InboxItem

const factories = [
  { id: 'nb', name: 'Notebook' },
  { id: 'ms', name: 'Marketing site' },
] as Factory[]

describe('Inbox chips', () => {
  test('All counts every waiting request, then one chip per Factory with its count', () => {
    const items = [item('a'), item('b', 'ms'), item('c')]
    expect(inboxChips(items, factories)).toEqual([
      { label: 'All', count: 3 },
      { factoryId: 'nb', label: 'Notebook', count: 2 },
      { factoryId: 'ms', label: 'Marketing site', count: 1 },
    ])
    expect(inFactory(items, 'ms').map((i) => i.request.id)).toEqual(['b'])
    expect(inFactory(items, undefined)).toBe(items)
  })
})

describe('after answering', () => {
  const before = [item('a'), item('b'), item('c')]

  test('the selection moves to the next row', () => {
    expect(nextSelection(before, [item('a'), item('c')], 'b')?.request.id).toBe('c')
  })

  test('the last row moves the selection up; an empty Inbox selects nothing', () => {
    expect(nextSelection(before, [item('a'), item('b')], 'c')?.request.id).toBe('b')
    expect(nextSelection(before, [], 'c')).toBeUndefined()
  })

  test('nothing moves while the selected request is still waiting, or when nothing was selected', () => {
    expect(nextSelection(before, before, 'b')).toBeUndefined()
    expect(nextSelection(before, [item('a')], undefined)).toBeUndefined()
    expect(nextSelection(before, [item('a')], 'elsewhere')).toBeUndefined()
  })
})
