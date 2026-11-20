import { expect, test, vi } from 'vitest'
import { type EventChange, eventValue } from '../src/renderer/event-value.ts'

function source<T>(initial: T, event: (event: string) => EventChange<T>, retryEveryMs?: number) {
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
    retryEveryMs,
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
  void s.refresh()
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

test('reload events during a load keep one request in flight and one queued', async () => {
  const s = source(0, () => 'reload')
  for (let i = 0; i < 5; i++) s.emit('reload')
  expect(s.calls).toHaveLength(1)
  s.calls[0]?.resolve(1)
  await Promise.resolve()
  expect(s.changed).toHaveBeenLastCalledWith(1)
  expect(s.calls).toHaveLength(2)
  s.emit('reload')
  s.calls[1]?.resolve(2)
  await Promise.resolve()
  expect(s.changed).toHaveBeenLastCalledWith(2)
  expect(s.calls).toHaveLength(3)
  s.calls[2]?.reject(new Error('offline'))
  await Promise.resolve()
  expect(s.calls).toHaveLength(3)
  s.emit('reload')
  expect(s.calls).toHaveLength(4)
  s.dispose()
})

test('an explicit refresh covers a queued reload', async () => {
  const s = source(0, () => 'reload')
  s.emit('reload')
  void s.refresh()
  s.calls[1]?.resolve(2)
  await Promise.resolve()
  expect(s.calls).toHaveLength(2)
  s.dispose()
})

test('a timed invalidation loads once per interval while events keep coming', async () => {
  vi.useFakeTimers()
  try {
    const s = source(0, () => 1500)
    s.calls[0]?.resolve(1)
    await Promise.resolve()
    for (let i = 0; i < 40; i++) {
      s.emit('output')
      await vi.advanceTimersByTimeAsync(150)
      s.calls.at(-1)?.resolve(s.calls.length)
    }
    await Promise.resolve()
    expect(s.calls).toHaveLength(5)
    expect(s.changed.mock.calls.map(([v]) => v)).toEqual([1, 2, 3, 4, 5])
    s.dispose()
  } finally {
    vi.useRealTimers()
  }
})

test('a timed invalidation keeps the reply in flight and takes the shortest wait', async () => {
  vi.useFakeTimers()
  try {
    const s = source(0, (e) => (e === 'soon' ? 500 : 1500))
    s.emit('later')
    s.calls[0]?.resolve(1)
    await Promise.resolve()
    expect(s.changed).toHaveBeenLastCalledWith(1)
    s.emit('soon')
    s.emit('later')
    await vi.advanceTimersByTimeAsync(499)
    expect(s.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(s.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1500)
    expect(s.calls).toHaveLength(2)
    s.emit('later')
    await vi.advanceTimersByTimeAsync(1500)
    expect(s.calls).toHaveLength(2)
    s.calls[1]?.resolve(2)
    await Promise.resolve()
    expect(s.calls).toHaveLength(3)
    s.dispose()
  } finally {
    vi.useRealTimers()
  }
})

test('an update that returns the same value publishes nothing but still applies to a load', async () => {
  const s = source<number[]>([], (e) => (current) => (e === 'same' ? current : [...current, 1]))
  s.emit('same')
  expect(s.changed).not.toHaveBeenCalled()
  s.emit('add')
  s.calls[0]?.resolve([0])
  await Promise.resolve()
  expect(s.changed).toHaveBeenLastCalledWith([0, 1])
  s.dispose()
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

test('an awaited refresh follows the replacement read without waiting for its obsolete read', async () => {
  const s = source(0, () => 'reload')
  const completed = vi.fn()
  const pending = s.refresh().then(completed)
  void s.refresh()
  s.calls[2]?.resolve(3)
  await pending
  expect(completed).toHaveBeenCalledExactlyOnceWith(3)
  s.calls[1]?.resolve(2)
  s.calls[0]?.resolve(1)
  await Promise.resolve()
  expect(s.changed).toHaveBeenCalledExactlyOnceWith(3)
  s.dispose()
})

test.each(['failure', 'dispose'] as const)(
  'an awaited refresh finishes when its replacement ends in %s',
  async (ending) => {
    const s = source(0, () => 'reload')
    const pending = s.refresh()
    void s.refresh()
    if (ending === 'failure') s.calls[2]?.reject(new Error('Current read failed'))
    else s.dispose()
    expect(await pending).toBeUndefined()
    s.calls[1]?.resolve(2)
    s.calls[0]?.resolve(1)
    await Promise.resolve()
    expect(s.changed).not.toHaveBeenCalled()
    s.dispose()
  },
)

test('a failed load is tried again after retryEveryMs until one works, and dispose stops it', async () => {
  vi.useFakeTimers()
  try {
    const s = source(0, () => undefined, 2_000)
    s.calls[0]?.reject(new Error('busy'))
    await vi.advanceTimersByTimeAsync(1_999)
    expect(s.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(s.calls).toHaveLength(2)
    s.calls[1]?.reject(new Error('busy'))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(s.calls).toHaveLength(3)
    s.calls[2]?.resolve(4)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(s.calls).toHaveLength(3)
    expect(s.changed).toHaveBeenCalledExactlyOnceWith(4)
    expect(s.error).toHaveBeenCalledTimes(2)
    void s.refresh()
    s.calls[3]?.reject(new Error('busy'))
    await vi.advanceTimersByTimeAsync(0)
    s.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(s.calls).toHaveLength(4)
  } finally {
    vi.useRealTimers()
  }
})

test('a failed load is not tried again without retryEveryMs', async () => {
  vi.useFakeTimers()
  try {
    const s = source(0, () => undefined)
    s.calls[0]?.reject(new Error('busy'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(s.calls).toHaveLength(1)
    expect(s.error).toHaveBeenCalledOnce()
    s.dispose()
  } finally {
    vi.useRealTimers()
  }
})
