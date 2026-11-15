import { expect, test } from 'vitest'
import { groupsFor } from './check.ts'
import {
  busy,
  busyAbove,
  loadPerCore,
  quietMaxWaitMs,
  quietStep,
  quietWaitMs,
  scaledWorkers,
  waitForQuiet,
} from './machine-load.ts'

test('the load per core comes from the machine unless TED_TEST_LOAD names it or turns it off', () => {
  expect(process.env.TED_TEST_LOAD).toBe('off')
  expect(loadPerCore({}, () => 1.2345)).toBe(1.23)
  expect(loadPerCore({ TED_TEST_LOAD: 'off' }, () => 9)).toBeUndefined()
  expect(loadPerCore({ TED_TEST_LOAD: '2.5' }, () => 9)).toBe(2.5)
  expect(loadPerCore({ TED_TEST_LOAD: 'nonsense' }, () => 0.4)).toBe(0.4)
  expect(loadPerCore({})).toBeGreaterThanOrEqual(0)
})

test('worker counts stay as they are up to the busy mark and shrink above it, never below 1', () => {
  expect(busy(undefined)).toBe(false)
  expect(busy(busyAbove)).toBe(false)
  expect(busy(0.76)).toBe(true)
  const counts = (load: number | undefined) => [scaledWorkers(6, load), scaledWorkers(3, load)]
  expect(counts(undefined)).toEqual([6, 3])
  expect(counts(0)).toEqual([6, 3])
  expect(counts(0.75)).toEqual([6, 3])
  expect(counts(1)).toEqual([5, 2])
  expect(counts(1.5)).toEqual([3, 2])
  expect(counts(2)).toEqual([2, 1])
  expect(counts(4)).toEqual([1, 1])
  expect(counts(15.7)).toEqual([1, 1])
  expect(groupsFor(undefined)).toEqual([
    { project: 'electron', maxWorkers: 3 },
    { project: 'node', maxWorkers: 6 },
  ])
  expect(groupsFor(2)).toEqual([
    { project: 'electron', maxWorkers: 1 },
    { project: 'node', maxWorkers: 2 },
  ])
})

test('pnpm check waits for a quiet machine only when asked, by flag or environment', () => {
  expect(quietWaitMs(['--all'], {})).toBeUndefined()
  expect(quietWaitMs(['--wait-for-quiet'], {})).toBe(quietMaxWaitMs)
  expect(quietWaitMs(['--all', '--wait-for-quiet=5'], {})).toBe(5 * 60_000)
  expect(quietWaitMs(['--wait-for-quiet=1'], {})).toBe(60_000)
  expect(quietWaitMs(['--wait-for-quiet=0'], { TED_CHECK_WAIT_FOR_QUIET: '10' })).toBeUndefined()
  expect(quietWaitMs([], { TED_CHECK_WAIT_FOR_QUIET: '1' })).toBe(quietMaxWaitMs)
  expect(quietWaitMs([], { TED_CHECK_WAIT_FOR_QUIET: 'on' })).toBe(quietMaxWaitMs)
  expect(quietWaitMs([], { TED_CHECK_WAIT_FOR_QUIET: '90' })).toBe(90 * 60_000)
  expect(quietWaitMs([], { TED_CHECK_WAIT_FOR_QUIET: 'off' })).toBeUndefined()
})

test('the wait ends when the load is at the mark or below, or when the longest wait has passed', async () => {
  expect(quietStep(0.75, 0, 1000)).toBe('start')
  expect(quietStep(undefined, 0, 1000)).toBe('start')
  expect(quietStep(3, 999, 1000)).toBe('wait')
  expect(quietStep(3, 1000, 1000)).toBe('give-up')

  const drive = async (loads: number[], maxWaitMs: number) => {
    let clock = 0
    const lines: string[] = []
    const result = await waitForQuiet({
      maxWaitMs,
      pollMs: 10_000,
      reportMs: 20_000,
      read: () => loads.shift() ?? 9,
      now: () => clock,
      pause: async (ms) => {
        clock += ms
      },
      log: (line) => lines.push(line),
    })
    return { result, lines }
  }

  expect(await drive([0.2], 60_000)).toEqual({ result: { waitedMs: 0, quiet: true }, lines: [] })

  const quiet = await drive([3, 2.5, 2, 0.5], 60_000)
  expect(quiet.result).toEqual({ waitedMs: 30_000, quiet: true })
  expect(quiet.lines).toEqual([
    'Waiting for the machine to be quiet: load per core is 3.00, and the tests start at 0.75 or below, or after 1 minute…',
    'Still waiting after 20 seconds: load per core is 2.00.',
    'The machine is quiet (load per core 0.50) after 30 seconds.',
  ])

  const busyStill = await drive([], 25_000)
  expect(busyStill.result).toEqual({ waitedMs: 25_000, quiet: false })
  expect(busyStill.lines.at(-1)).toBe(
    'Warning: the machine is still busy after 25 seconds (load per core 9.00). Starting the tests anyway.',
  )

  let slowClock = 0
  const slowLines: string[] = []
  const slow = await waitForQuiet({
    maxWaitMs: 1,
    read: () => 2,
    now: () => {
      slowClock += 50
      return slowClock
    },
    pause: async () => {},
    log: (line) => slowLines.push(line),
  })
  expect(slow).toEqual({ waitedMs: 50, quiet: false })
  expect(slowLines).toEqual([
    'Waiting for the machine to be quiet: load per core is 2.00, and the tests start at 0.75 or below, or after 0 seconds…',
    'Warning: the machine is still busy after 0 seconds (load per core 2.00). Starting the tests anyway.',
  ])
})
