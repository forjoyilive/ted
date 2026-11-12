import { afterEach, expect, test, vi } from 'vitest'
import { cleanupWithEvidence } from './support/cleanup-evidence.ts'

afterEach(() => {
  vi.useRealTimers()
})

test('slow cleanup reports the actual pending phase before the hook deadline', async () => {
  vi.useFakeTimers()
  const report = vi.fn()
  const held = Promise.withResolvers<void>()
  const remove = vi.fn(async () => {})
  const cleanup = cleanupWithEvidence(
    [
      { name: 'closeApp', run: async () => {} },
      { name: 'stopDaemonIn', run: () => held.promise },
      { name: 'removeHome', run: remove },
    ],
    report,
  )
  await vi.advanceTimersByTimeAsync(8000)
  expect(report).toHaveBeenCalledExactlyOnceWith({
    outcome: 'running',
    elapsedMs: 8000,
    steps: [
      { name: 'closeApp', state: 'passed', elapsedMs: 0 },
      { name: 'stopDaemonIn', state: 'running', elapsedMs: 8000 },
    ],
  })
  expect(remove).not.toHaveBeenCalled()
  held.resolve()
  await cleanup
  expect(remove).toHaveBeenCalledOnce()
  expect(report.mock.lastCall?.[0].outcome).toBe('passed')
  expect(vi.getTimerCount()).toBe(0)
})

test('a cleanup error is preserved even if reporting fails', async () => {
  vi.useFakeTimers()
  const error = new Error('stop failed')
  const remove = vi.fn(async () => {})
  await expect(
    cleanupWithEvidence(
      [
        {
          name: 'stopDaemonIn',
          run: async () => {
            throw error
          },
        },
        { name: 'removeHome', run: remove },
      ],
      () => {
        throw new Error('report failed')
      },
    ),
  ).rejects.toBe(error)
  expect(remove).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

test('quick cleanup records completed phases and leaves no warning timer', async () => {
  vi.useFakeTimers()
  const report = vi.fn()
  await cleanupWithEvidence([{ name: 'closeApp', run: async () => {} }], report)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(report).toHaveBeenCalledExactlyOnceWith({
    outcome: 'passed',
    elapsedMs: 0,
    steps: [{ name: 'closeApp', state: 'passed', elapsedMs: 0 }],
  })
  expect(vi.getTimerCount()).toBe(0)
})
