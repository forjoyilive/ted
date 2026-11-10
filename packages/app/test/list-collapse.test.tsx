// @vitest-environment jsdom
import type { ListGroup } from '@ted/protocol'
import { act, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useListCollapsed } from '../src/renderer/list-collapse.ts'
import './support/component.ts'

test('collapse choices are separate per scope and grouping and survive remounting', () => {
  const initialProps: { scope: string; grouping: ListGroup } = { scope: 'all', grouping: 'stage' }
  const a = renderHook(({ scope, grouping }) => useListCollapsed(scope, grouping), { initialProps })
  act(() => a.result.current.change('backlog', true))
  act(() => a.result.current.change('done', false))
  a.rerender({ scope: 'factory-1', grouping: 'stage' })
  expect(a.result.current.collapsed('backlog', false)).toBe(false)
  act(() => a.result.current.change('backlog', false))
  a.rerender({ scope: 'all', grouping: 'status' })
  expect(a.result.current.collapsed('backlog', false)).toBe(false)
  act(() => a.result.current.change('backlog', false))
  a.rerender(initialProps)
  expect(a.result.current.collapsed('backlog', false)).toBe(true)
  expect(a.result.current.collapsed('done', true)).toBe(false)
  a.unmount()
  const b = renderHook(() => useListCollapsed('all', 'stage'))
  expect(b.result.current.collapsed('backlog', false)).toBe(true)
  expect(b.result.current.collapsed('done', true)).toBe(false)
})

test.each(['invalid json', 'null', '[]', '{"bad":"true"}'])(
  'invalid saved collapse choices fall back to group defaults: %s',
  (stored) => {
    localStorage.setItem('ted.list.collapsed', stored)
    const a = renderHook(() => useListCollapsed('all', 'stage'))
    expect(a.result.current.collapsed('backlog', false)).toBe(false)
    expect(a.result.current.collapsed('done', true)).toBe(true)
    act(() => a.result.current.change('backlog', true))
    expect(a.result.current.collapsed('backlog', false)).toBe(true)
  },
)

test('unavailable storage keeps toggles usable in memory', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('Storage disabled')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Storage disabled')
  })
  const a = renderHook(() => useListCollapsed('all', 'stage'))
  act(() => a.result.current.change('backlog', true))
  expect(a.result.current.collapsed('backlog', false)).toBe(true)
  act(() => a.result.current.change('backlog', false))
  expect(a.result.current.collapsed('backlog', false)).toBe(false)
})
