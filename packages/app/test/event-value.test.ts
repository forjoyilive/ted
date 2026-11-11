import { expect, test, vi } from 'vitest'
import { type EventChange, eventValue } from '../src/renderer/event-value.ts'

function source<T>(initial: T, event: (event: string) => EventChange<T>) {
  const calls: ReturnType<typeof Promise.withResolvers<T>>[] = []
  let listener: ((event: string) => void) | undefined
  const changed = vi.fn()
  const error = vi.fn()
  const unsubscribe = vi.fn(() => {
    listener = undefined
  })
  const live = eventValue({
    initial,
    event,
    changed,
    error,
    load: () => {
      const call = Promise.withResolvers<T>()
      calls.push(call)
      return call.promise
    },
    subscribe: (next) => {
      listener = next
      return unsubscribe
    },
  })
  return { ...live, calls, changed, error, unsubscribe, emit: (event: string) => listener?.(event) }
}

test('an event replacement wins over the initial load', async () => {
  const s = source(0, (e) => (e === 'new' ? () => 2 : undefined))
  s.emit('unrelated')
  expect(s.changed).not.toHaveBeenCalled()
  s.emit('new')
  s.calls[0]?.resolve(1)
  await Promise.resolve()
  expect(s.changed.mock.calls.map(([v]) => v)).toEqual([2, 2])
  s.dispose()
})

test('partial events and removals reconcile with unrelated loaded entries', async () => {
  const s = source<string[]>(
    [],
    (e) => (current) =>
      e === 'remove' ? current.filter((x) => x !== 'old') : [...current.filter((x) => x !== e), e],
  )
  s.emit('new')
  s.emit('remove')
  s.calls[0]?.resolve(['old', 'unrelated'])
  await Promise.resolve()
  expect(s.changed).toHaveBeenLastCalledWith(['unrelated', 'new'])
  s.dispose()
})

test('newer refreshes win and disposed results and errors are ignored', async () => {
  const s = source(0, () => 'reload')
  s.emit('reload')
  s.calls[1]?.resolve(2)
  await Promise.resolve()
  s.calls[0]?.resolve(1)
  await Promise.resolve()
  expect(s.changed).toHaveBeenCalledExactlyOnceWith(2)
  const pending = s.refresh()
  s.dispose()
  s.calls[2]?.reject(new Error('late'))
  await pending
  expect(s.error).not.toHaveBeenCalled()
  expect(s.unsubscribe).toHaveBeenCalledOnce()
})

test('debounced invalidation rejects an older load before the next load starts', async () => {
  vi.useFakeTimers()
  try {
    const s = source(0, () => 1500)
    s.emit('reload')
    s.calls[0]?.resolve(1)
    await Promise.resolve()
    expect(s.changed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1500)
    s.calls[1]?.resolve(2)
    await Promise.resolve()
    expect(s.changed).toHaveBeenLastCalledWith(2)
    s.dispose()
  } finally {
    vi.useRealTimers()
  }
})

test('load failures are reported and a later event can recover', async () => {
  const s = source(0, () => 'reload')
  const failure = new Error('offline')
  s.calls[0]?.reject(failure)
  await Promise.resolve()
  expect(s.error).toHaveBeenCalledExactlyOnceWith(failure)
  s.emit('retry')
  s.calls[1]?.resolve(2)
  await Promise.resolve()
  expect(s.changed).toHaveBeenLastCalledWith(2)
  s.dispose()
})

test('disposing cancels scheduled refreshes', async () => {
  vi.useFakeTimers()
  try {
    const s = source(0, () => 1500)
    s.emit('reload')
    s.dispose()
    await vi.advanceTimersByTimeAsync(1500)
    expect(s.calls).toHaveLength(1)
    s.calls[0]?.resolve(1)
    await Promise.resolve()
    expect(s.changed).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

test('subscription is installed before the loader can emit an update', async () => {
  let listener: ((event: number) => void) | undefined
  const changed = vi.fn()
  const s = eventValue({
    initial: 0,
    load: async () => {
      listener?.(2)
      return 1
    },
    subscribe: (next) => {
      listener = next
      return () => {
        listener = undefined
      }
    },
    event: (next: number) => () => next,
    changed,
  })
  await Promise.resolve()
  expect(changed).toHaveBeenLastCalledWith(2)
  s.dispose()
})
