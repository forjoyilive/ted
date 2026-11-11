import { expect, test } from 'vitest'
import { parseWaits, summarize } from './test-waits.ts'

test('the wait log is summed per group, and lines that aren’t records are skipped', () => {
  const line = (event: string, kind: string, waitedMs: number, heldMs?: number) =>
    JSON.stringify({
      event,
      at: '2026-11-11T10:00:00.000Z',
      pid: 1,
      kind,
      cwd: '/a',
      waitedMs,
      heldMs,
    })
  const records = parseWaits(
    [
      line('start', 'small', 1_000),
      line('end', 'small', 1_000, 30_000),
      line('start', 'small', 5_000),
      'not json',
      '{"event":"other"}',
      line('start', 'full', 60_000),
      line('end', 'full', 60_000, 600_000),
      '',
    ].join('\n'),
  )
  expect(summarize(records, (record) => record.kind)).toEqual([
    {
      name: 'full',
      runs: 1,
      waitedMs: 60_000,
      medianWaitMs: 60_000,
      longestWaitMs: 60_000,
      heldMs: 600_000,
    },
    {
      name: 'small',
      runs: 2,
      waitedMs: 6_000,
      medianWaitMs: 5_000,
      longestWaitMs: 5_000,
      heldMs: 30_000,
    },
  ])
})
