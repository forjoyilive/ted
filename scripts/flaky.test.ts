import path from 'node:path'
import { expect, test } from 'vitest'
import { flakyArgs, flakyRefusal, flakySummary, runResult } from './flaky.ts'

const file = path.resolve(import.meta.dirname, '..', 'packages/daemon/test/a.test.ts')

const report = (statuses: string[]) => {
  const failed = statuses.filter((status) => status === 'failed').length
  const passed = statuses.filter((status) => status === 'passed').length
  const skipped = statuses.filter((status) => status === 'skipped').length
  return JSON.stringify({
    numTotalTests: statuses.length,
    numPassedTests: passed,
    numFailedTests: failed,
    numPendingTests: skipped,
    numTodoTests: 0,
    numTotalTestSuites: 1,
    numPassedTestSuites: failed ? 0 : 1,
    numFailedTestSuites: failed ? 1 : 0,
    numPendingTestSuites: 0,
    success: failed === 0,
    testResults: [
      {
        name: file,
        status: failed ? 'failed' : 'passed',
        assertionResults: statuses.map((status, index) => ({
          fullName: `test ${index}`,
          status,
        })),
      },
    ],
  })
}

test('pnpm flaky takes one test file, a test name, a run count and a load', () => {
  expect(flakyArgs(['a.test.ts'], 12)).toEqual({ file: 'a.test.ts', runs: 5, load: 12 })
  expect(flakyArgs(['a.test.ts', '-t', 'opens a Task', '--runs', '8', '--load=4'], 12)).toEqual({
    file: 'a.test.ts',
    name: 'opens a Task',
    runs: 8,
    load: 4,
  })
  expect(flakyArgs(['a.test.ts', '--load', '0'], 12)).toMatchObject({ load: 0 })
  expect(flakyArgs([], 12)).toContain('Name one test file.')
  expect(flakyArgs(['a.test.ts', 'b.test.ts'], 12)).toContain('Name one test file.')
  expect(flakyArgs(['a.test.ts', '--runs', '0'], 12)).toContain('--runs needs a whole number')
  expect(flakyArgs(['a.test.ts', '--runs', '51'], 12)).toContain('from 1 to 50')
  expect(flakyArgs(['a.test.ts', '--load', '49'], 12)).toContain('from 0 to 48')
  expect(flakyArgs(['a.test.ts', '-t'], 12)).toContain('-t needs a test name')
  expect(flakyArgs(['a.test.ts', '--bail'], 12)).toContain('Unknown option --bail')
})

test('a Run can’t run pnpm flaky', () => {
  expect(flakyRefusal({})).toBeUndefined()
  expect(flakyRefusal({ TED_RUN: 'run-1' })).toContain('A Run can’t run pnpm flaky')
})

test('a run passes only when every test passed first time and the report is whole', () => {
  expect(runResult(report(['passed', 'skipped']), '{"passedOnRetry":[]}', true, 1200)).toEqual({
    ok: true,
    ms: 1200,
    failures: [],
    retried: [],
    problems: [],
  })
  expect(runResult(report(['passed', 'failed']), undefined, false, 10)).toMatchObject({
    ok: false,
    failures: ['packages/daemon/test/a.test.ts > test 1'],
  })
  expect(
    runResult(report(['passed']), '{"passedOnRetry":["a.test.ts > test 0"]}', true, 10),
  ).toMatchObject({ ok: false, retried: ['a.test.ts > test 0'] })
  expect(runResult(report(['skipped']), undefined, true, 10)).toMatchObject({
    ok: false,
    problems: ['flaky: no test ran'],
  })
  expect(runResult('', undefined, false, 10)).toMatchObject({
    ok: false,
    problems: ['flaky: missing or invalid JSON report'],
  })
})

test('the summary counts the runs that passed and the runs each test failed in', () => {
  const pass = { ok: true, ms: 1, failures: [], retried: [], problems: [] }
  const fail = (...failures: string[]) => ({ ...pass, ok: false, failures })
  expect(flakySummary([pass, pass], 2, 12)).toBe(
    '\n2 of 2 runs passed with 12 busy threads beside the tests.',
  )
  expect(
    flakySummary(
      [
        pass,
        fail('a > one', 'a > two'),
        fail('a > two'),
        { ...pass, ok: false, retried: ['a > x'] },
      ],
      5,
      1,
    ),
  ).toBe(
    [
      '\n1 of 4 runs passed with 1 busy thread beside the tests.',
      'Stopped early: 1 of 5 runs did not happen.',
      'Tests that failed:',
      '  2 of 4 runs  a > two',
      '  1 of 4 runs  a > one',
      'Tests that failed, then passed on retry:',
      '  1 of 4 runs  a > x',
    ].join('\n'),
  )
})
