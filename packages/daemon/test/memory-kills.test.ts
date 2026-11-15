import { expect, test } from 'vitest'
import { createMemoryWatch, memoryKill, runKilledForMemory } from '../src/memory-kills.ts'

test('only a SIGKILL or exit 137 while memory was under the busy mark is a memory kill', () => {
  expect(memoryKill({ signal: 'SIGKILL' }, 0.05)).toBe(true)
  expect(memoryKill({ exitCode: 137 }, 0.09)).toBe(true)
  expect(memoryKill({ signal: 'SIGKILL' }, 0.1)).toBe(false)
  expect(memoryKill({ signal: 'SIGTERM' }, 0.05)).toBe(false)
  expect(memoryKill({ exitCode: 1 }, 0.05)).toBe(false)
  expect(memoryKill({ signal: 'SIGKILL' }, undefined)).toBe(false)
})

test('a Run’s ending counts by its signal or its exit code 137, and never when TED stopped it', () => {
  expect(runKilledForMemory({ how: 'exited', signal: 'SIGKILL' }, 0.05)).toBe(true)
  expect(runKilledForMemory({ how: 'exited', code: 137 }, 0.05)).toBe(true)
  expect(runKilledForMemory({ how: 'stopped', signal: 'SIGKILL' }, 0.05)).toBe(false)
  expect(runKilledForMemory({ how: 'lost' }, 0.05)).toBe(false)
  expect(runKilledForMemory({ how: 'exited', code: 1 }, 0.05)).toBe(false)
})

test('a watch keeps the lowest reading taken while it is open, and freed waits for memory above the resume mark', async () => {
  let share = 0.5
  let reads = 0
  const watch = createMemoryWatch({
    read: async () => {
      reads++
      return share
    },
    everyMs: 5,
  })
  const watching = watch.watch()
  share = 0.03
  const before = reads
  await expect.poll(() => reads).toBeGreaterThan(before + 1)
  share = 0.6
  const after = reads
  await expect.poll(() => reads).toBeGreaterThan(after + 1)
  expect(await watching.finish()).toBe(0.03)

  share = 0.15
  let done = false
  const freed = watch.freed().then((value) => {
    done = true
    return value
  })
  const waiting = reads
  await expect.poll(() => reads).toBeGreaterThan(waiting + 1)
  expect(done).toBe(false)
  share = 0.25
  expect(await freed).toBe(true)

  const stop = new AbortController()
  share = 0.01
  const stopped = watch.freed(stop.signal)
  stop.abort()
  expect(await stopped).toBe(false)
})
