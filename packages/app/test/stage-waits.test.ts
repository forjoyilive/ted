import type { FlowPeriod, FlowReasonSample, FlowStageSample } from '@ted/protocol'
import { noStageParts } from '@ted/protocol/stage-parts'
import { expect, test } from 'vitest'
import { withoutUserWaits } from '../src/renderer/views/stage-waits.ts'

const hour = 3_600_000
const at = (h: number) => new Date(Date.parse('2026-11-04T00:00:00.000Z') + h * hour).toISOString()
const span = (from: number, to: number) => ({ from: at(from), to: at(to) })

function visit(taskId: string, ...spans: [number, number][]): FlowStageSample {
  const elapsedMs = spans.reduce((n, [from, to]) => n + (to - from) * hour, 0)
  return {
    taskId,
    elapsedMs,
    intervals: spans.map(([from, to]) => span(from, to)),
    parts: { ...noStageParts(), other: elapsedMs },
  }
}

function requests(
  taskId: string,
  coverage: FlowReasonSample['coverage'],
  spans: [number, number][],
  notices: string[] = [],
): FlowReasonSample {
  return {
    taskId,
    elapsedMs: spans.reduce((n, [from, to]) => n + (to - from) * hour, 0),
    eligibleMs: 0,
    coveredMs: null,
    coverage,
    intervals: spans.map(([from, to]) => ({ ...span(from, to), contributors: [] })),
    coverageIntervals: [],
    notices,
    invocations: [],
  }
}

function period(
  stages: Record<string, FlowStageSample[]>,
  samples: FlowReasonSample[],
  working: FlowReasonSample[] = [],
) {
  return {
    stages: Object.entries(stages).map(([stage, samples]) => ({
      stage,
      factoryIds: ['one', 'two'],
      totalMs: samples.reduce((n, s) => n + s.elapsedMs, 0),
      medianMs: null,
      p25Ms: null,
      p75Ms: null,
      samples,
    })),
    reasons: [
      { reason: 'user-request', totalMs: 0, medianMs: null, p25Ms: null, p75Ms: null, samples },
      {
        reason: 'run-working',
        totalMs: 0,
        medianMs: null,
        p25Ms: null,
        p75Ms: null,
        samples: working,
      },
    ],
  } as FlowPeriod
}

test('time with an open request is taken out of each Stage visit it overlaps', () => {
  const result = withoutUserWaits(
    period(
      {
        clarify: [visit('a', [0, 4], [10, 12]), visit('b', [0, 2])],
        design: [visit('a', [4, 10])],
      },
      [
        requests('a', 'full', [
          [1, 3],
          [3.5, 5],
          [11, 20],
        ]),
        requests('b', 'full', []),
      ],
      [requests('a', 'full', [[0, 2]])],
    ),
  )
  expect(result.leftOut).toEqual([])
  const [clarify, design] = result.stages
  expect(clarify?.samples.map((s) => [s.taskId, s.elapsedMs / hour])).toEqual([
    ['a', 2.5],
    ['b', 2],
  ])
  expect(clarify?.samples[0]?.intervals).toHaveLength(2)
  expect(clarify).toMatchObject({
    totalMs: 4.5 * hour,
    medianMs: 2.25 * hour,
    p25Ms: 2.125 * hour,
    p75Ms: 2.375 * hour,
  })
  expect(design?.samples.map((s) => s.elapsedMs / hour)).toEqual([5])
  expect(design).toMatchObject({ totalMs: 5 * hour, medianMs: 5 * hour })
  expect(clarify?.samples[0]?.parts).toMatchObject({ working: hour, you: 0, other: 1.5 * hour })
  expect(clarify?.parts).toMatchObject({ working: hour, you: 0, other: 3.5 * hour })
})

test('a Task without a complete record of requests is left out of every Stage and its Factory’s count', () => {
  const result = withoutUserWaits(
    period(
      {
        work: [visit('full', [0, 3]), visit('partial', [0, 5]), visit('none', [0, 7])],
        review: [visit('partial', [5, 6]), visit('unavailable', [0, 1])],
      },
      [
        requests('full', 'full', [[0, 1]]),
        requests('partial', 'partial', [[0, 1]], ['Observed recording starts later.']),
        requests('unavailable', 'unavailable', []),
      ],
    ),
    new Map([
      ['full', 'one'],
      ['partial', 'two'],
      ['none', 'two'],
      ['unavailable', 'two'],
    ]),
  )
  expect(result.stages.map((s) => s.samples.map((t) => t.taskId))).toEqual([['full'], []])
  expect(result.stages.map((s) => s.factoryIds)).toEqual([['one'], []])
  expect(result.stages[0]).toMatchObject({ totalMs: 2 * hour, medianMs: 2 * hour })
  expect(result.stages[1]).toMatchObject({ totalMs: 0, medianMs: null, p25Ms: null, p75Ms: null })
  expect(result.leftOut).toEqual([
    { taskId: 'none', reasons: ['No record of requests to you for this Task.'] },
    { taskId: 'partial', reasons: ['Observed recording starts later.'] },
    { taskId: 'unavailable', reasons: ['No record of requests to you for this Task.'] },
  ])
})
