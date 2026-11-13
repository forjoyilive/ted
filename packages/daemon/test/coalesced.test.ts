import { expect, test } from 'vitest'
import { coalesced } from '../src/tasks/coalesced.ts'

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve))

test('a burst of calls runs the work once per key, after the burst, and a later call runs it again', async () => {
  const ran: string[] = []
  const soon = coalesced((key: string) => ran.push(key))

  for (let i = 0; i < 100; i++) soon('a')
  soon('b')
  expect(ran).toEqual([])
  await nextTick()
  expect(ran).toEqual(['a', 'b'])

  soon('a')
  await nextTick()
  expect(ran).toEqual(['a', 'b', 'a'])

  let runs = 0
  const plain = coalesced(() => {
    runs++
    if (runs === 1) plain()
  })
  plain()
  plain()
  await nextTick()
  expect(runs).toBe(1)
  await nextTick()
  expect(runs).toBe(2)
})
