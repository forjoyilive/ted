import { expect, test, vi } from 'vitest'
import { sharedValues } from '../src/renderer/shared-value.ts'

function store() {
  const calls: ReturnType<typeof Promise.withResolvers<number>>[] = []
  const listeners = new Set<(event: string) => void>()
  const shared = sharedValues<string>({
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    describe: (error) => (error as Error).message,
  })
  const request = {
    load: () => {
      const call = Promise.withResolvers<number>()
      calls.push(call)
      return call.promise
    },
    event: (event: string) => (event === 'reload' ? ('reload' as const) : undefined),
  }
  return {
    shared,
    calls,
    listeners,
    request,
    emit: (event: string) => {
      for (const listener of [...listeners]) listener(event)
    },
  }
}

test('users of one key share one request, one subscription and one value', async () => {
  const s = store()
  const first = vi.fn()
  const second = vi.fn()
  const other = vi.fn()
  const leaveFirst = s.shared.use('a', 0, s.request, first)
  const leaveSecond = s.shared.use('a', 0, s.request, second)
  const leaveOther = s.shared.use('b', 0, s.request, other)
  expect(s.calls).toHaveLength(2)
  expect(s.listeners.size).toBe(2)
  expect(s.shared.read('a')).toEqual({ value: undefined, loaded: false, error: undefined })

  s.calls[0]?.resolve(1)
  await Promise.resolve()
  expect(s.shared.read('a')).toEqual({ value: 1, loaded: true, error: undefined })
  expect(s.shared.read('b').loaded).toBe(false)
  expect(first).toHaveBeenCalled()
  expect(second).toHaveBeenCalled()
  expect(other).not.toHaveBeenCalled()

  s.emit('reload')
  expect(s.calls).toHaveLength(3)
  s.calls[2]?.reject(new Error('offline'))
  await Promise.resolve()
  expect(s.shared.read('a')).toEqual({ value: 1, loaded: true, error: 'offline' })
  s.shared.update<number>('a', () => 5)
  expect(s.shared.read('a')).toEqual({ value: 5, loaded: true, error: undefined })

  leaveFirst()
  expect(s.shared.read<number>('a').value).toBe(5)
  expect(s.listeners.size).toBe(2)
  leaveSecond()
  leaveOther()
  expect(s.listeners.size).toBe(0)
  expect(s.shared.read('a')).toEqual({ value: undefined, loaded: false, error: undefined })
})

test('a new connection reloads the entry once and keeps its value meanwhile', async () => {
  const s = store()
  const notified = vi.fn()
  const leave = s.shared.use('a', 0, s.request, notified)
  s.shared.use('a', 0, s.request, () => undefined)
  s.calls[0]?.resolve(1)
  await Promise.resolve()
  s.shared.renew('a', 0)
  expect(s.calls).toHaveLength(1)

  s.shared.renew('a', 1)
  s.shared.renew('a', 1)
  s.shared.renew('missing', 1)
  expect(s.calls).toHaveLength(2)
  expect(s.listeners.size).toBe(1)
  expect(s.shared.read<number>('a').value).toBe(1)
  notified.mockClear()
  s.calls[1]?.resolve(2)
  await Promise.resolve()
  expect(s.shared.read<number>('a').value).toBe(2)
  expect(notified).toHaveBeenCalled()
  leave()
})
