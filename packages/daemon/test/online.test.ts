import { afterEach, expect, test, vi } from 'vitest'
import { type OnlineWatch, watchOnline } from '../src/health/online.ts'

let monitor: OnlineWatch | undefined

afterEach(() => {
  monitor?.close()
  vi.useRealTimers()
})

test('a failed check followed by success does not report offline', async () => {
  vi.useFakeTimers()
  const changed = vi.fn()
  const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
  monitor = watchOnline({ isOnline: probe, onChange: changed })

  await monitor.check()
  expect(changed).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(probe).toHaveBeenCalledTimes(2)
  expect(changed).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(probe).toHaveBeenCalledTimes(3)
})

test('confirms sustained failure and recovers on the first successful check', async () => {
  vi.useFakeTimers()
  let online = false
  const changed = vi.fn()
  monitor = watchOnline({ isOnline: async () => online, onChange: changed })

  await monitor.check()
  await vi.advanceTimersByTimeAsync(9_999)
  expect(changed).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(changed.mock.calls).toEqual([[false]])
  await vi.advanceTimersByTimeAsync(10_000)
  expect(changed.mock.calls).toEqual([[false]])
  online = true
  await monitor.check()
  expect(changed.mock.calls).toEqual([[false], [true]])
  online = false
  await monitor.check()
  expect(changed.mock.calls).toEqual([[false], [true]])
})

test('retry checks cannot confirm early or postpone the scheduled confirmation', async () => {
  vi.useFakeTimers()
  const changed = vi.fn()
  const probe = vi.fn().mockResolvedValue(false)
  monitor = watchOnline({ isOnline: probe, onChange: changed })

  await monitor.check()
  await vi.advanceTimersByTimeAsync(5_000)
  await Promise.all([monitor.check(), monitor.check(), monitor.check()])
  expect(probe).toHaveBeenCalledTimes(2)
  expect(changed).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(probe).toHaveBeenCalledTimes(3)
  expect(changed.mock.calls).toEqual([[false]])
})

test('a slow early retry needs a fresh confirmation after it finishes', async () => {
  vi.useFakeTimers()
  const changed = vi.fn()
  let finish: (online: boolean) => void = () => {}
  const probe = vi
    .fn()
    .mockResolvedValueOnce(false)
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValue(true)
  monitor = watchOnline({ isOnline: probe, onChange: changed })

  await monitor.check()
  await vi.advanceTimersByTimeAsync(1_000)
  const retry = monitor.check()
  await vi.advanceTimersByTimeAsync(20_000)
  expect(probe).toHaveBeenCalledTimes(2)
  finish(false)
  await retry
  expect(changed).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(0)
  expect(probe).toHaveBeenCalledTimes(3)
  expect(changed).not.toHaveBeenCalled()
})

test('closing during a confirmation prevents notifications and further probes', async () => {
  vi.useFakeTimers()
  const changed = vi.fn()
  let finish: (online: boolean) => void = () => {}
  const probe = vi
    .fn()
    .mockResolvedValueOnce(false)
    .mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        }),
    )
  monitor = watchOnline({ isOnline: probe, onChange: changed })

  await monitor.check()
  await vi.advanceTimersByTimeAsync(10_000)
  monitor.close()
  finish(false)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(changed).not.toHaveBeenCalled()
  expect(probe).toHaveBeenCalledTimes(2)
})
