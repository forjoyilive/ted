import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
  type FailureRecord,
  failureLogEnv,
  failureLogFile,
  failureLogPath,
  fileFailure,
  keepDays,
  mostWorkers,
  observed,
  parseFailures,
  pruneFailureLog,
  recordRun,
  recordVitestRun,
} from './failure-log.ts'
import { brokenRunTests, failureReport, failureText } from './test-failures.ts'

const day = 24 * 60 * 60_000
const now = Date.parse('2026-11-11T10:00:00.000Z')
const temp = () => path.join(mkdtempSync(path.join(tmpdir(), 'ted-failures-')), 'log.jsonl')

const run = (id: string, files: string[], at = now): FailureRecord => ({
  at: new Date(at).toISOString(),
  type: 'run',
  run: id,
  kind: 'small',
  checkout: '/a',
  files,
})

const failure = (
  id: string,
  file: string,
  name: string,
  outcome: 'failed' | 'passed-on-retry' = 'failed',
): FailureRecord => ({
  at: new Date(now).toISOString(),
  type: 'test',
  run: id,
  file,
  test: name,
  outcome,
})

const fakeTest = (fullName: string, state: string, flaky = false) => ({
  fullName,
  result: () => ({ state }),
  diagnostic: () => ({ flaky }),
})

const fakeModule = (moduleId: string, state: string, tests: ReturnType<typeof fakeTest>[]) => ({
  moduleId,
  state: () => state,
  children: { allTests: () => tests },
})

test('this suite’s own test files don’t record to the machine’s file', () => {
  expect(process.env[failureLogEnv]).toBe('off')
  expect(failureLogPath()).toBeUndefined()
  expect(failureLogPath({})).toBe(failureLogFile)
  expect(failureLogPath({ [failureLogEnv]: '/x/log.jsonl' })).toBe('/x/log.jsonl')
  recordVitestRun({
    state: {
      getPaths: () => {
        throw new Error('not read while recording is off')
      },
      getTestModules: () => [],
    },
  })
})

test('a run records the files that finished and the tests that failed or passed on retry', () => {
  const seen = observed(
    [
      fakeModule('/repo/scripts/a.test.ts', 'failed', [
        fakeTest('suite > passes', 'passed'),
        fakeTest('suite > fails', 'failed'),
        fakeTest('suite > flaky', 'passed', true),
      ]),
      fakeModule('/repo/scripts/b.test.ts', 'passed', [fakeTest('fine', 'passed')]),
      fakeModule('/repo/scripts/c.test.ts', 'failed', [fakeTest('never ran', 'skipped')]),
      fakeModule('/repo/scripts/d.test.ts', 'pending', [fakeTest('not finished', 'pending')]),
    ],
    '/repo',
  )
  expect(seen).toEqual({
    files: ['scripts/a.test.ts', 'scripts/b.test.ts', 'scripts/c.test.ts'],
    tests: [
      { file: 'scripts/a.test.ts', test: 'suite > fails', outcome: 'failed' },
      { file: 'scripts/a.test.ts', test: 'suite > flaky', outcome: 'passed-on-retry' },
      { file: 'scripts/c.test.ts', test: fileFailure, outcome: 'failed' },
    ],
  })

  const file = temp()
  recordRun(file, { checkout: '/repo', planned: 3, task: 'NB-1', ...seen }, now)
  recordRun(
    file,
    {
      checkout: '/repo',
      planned: 12,
      load: 2.5,
      workers: 2,
      files: ['scripts/b.test.ts'],
      tests: [],
    },
    now,
  )
  recordRun(file, { checkout: '/repo', planned: 0, files: [], tests: [] }, now)
  const text = readFileSync(file, 'utf8')
  expect(text.split('\n').every((line) => line === '' || line.startsWith('{"at":"'))).toBe(true)
  const records = parseFailures(text)
  expect(records.map((record) => record.type)).toEqual(['run', 'test', 'test', 'test', 'run'])
  expect(records[0]).toMatchObject({
    at: '2026-11-11T10:00:00.000Z',
    kind: 'small',
    checkout: '/repo',
    task: 'NB-1',
    files: seen.files,
  })
  expect(records[1]).toMatchObject({ run: records[0]?.run, ...seen.tests[0] })
  expect(records[0]).not.toHaveProperty('load')
  expect(records[4]).toMatchObject({
    kind: 'full',
    load: 2.5,
    workers: 2,
    files: ['scripts/b.test.ts'],
  })
  expect(
    mostWorkers({ config: { maxWorkers: 6 }, projects: [{ config: { maxWorkers: 2 } }] }),
  ).toBe(6)
  expect(mostWorkers({ config: {} })).toBeUndefined()
})

test('a log that can’t be written leaves the run alone', () => {
  const folder = path.dirname(temp())
  const blocked = path.join(folder, 'a-file')
  writeFileSync(blocked, '')
  const write = () =>
    recordRun(path.join(blocked, 'log.jsonl'), {
      checkout: '/repo',
      planned: 1,
      files: ['a.test.ts'],
      tests: [],
    })
  expect(write).not.toThrow()
  expect(readdirSync(folder)).toEqual(['a-file'])
})

test('lines older than 90 days are dropped once the first line is a day past that', () => {
  const file = temp()
  const old = run('old', ['a.test.ts'], now - (keepDays + 2) * day)
  const kept = run('kept', ['a.test.ts'], now - (keepDays - 1) * day)
  const lines = [old, failure('old', 'a.test.ts', 'x'), kept].map((r) => JSON.stringify(r))
  lines[1] = lines[1]?.replace(new Date(now).toISOString(), old.at) ?? ''
  writeFileSync(file, `${lines.join('\n')}\nnot json\n`)

  pruneFailureLog(file, now - 1.5 * day)
  expect(parseFailures(readFileSync(file, 'utf8'))).toHaveLength(3)

  recordRun(file, { checkout: '/a', planned: 1, files: ['a.test.ts'], tests: [] }, now)
  const text = readFileSync(file, 'utf8')
  expect(text).not.toContain('not json')
  expect(parseFailures(text).map((record) => record.at)).toEqual([
    kept.at,
    new Date(now).toISOString(),
  ])
  expect(readdirSync(path.dirname(file))).toEqual(['log.jsonl'])
})

test('tests are ranked by how often they failed, with a rate over the runs that had the file', () => {
  const many = Array.from({ length: brokenRunTests + 1 }, (_, index) =>
    failure('broken', 'a.test.ts', `test ${index}`),
  )
  const records = parseFailures(
    [
      run('r1', ['a.test.ts', 'b.test.ts']),
      failure('r1', 'a.test.ts', 'flaky one'),
      failure('r1', 'a.test.ts', 'other', 'passed-on-retry'),
      run('r2', ['a.test.ts']),
      failure('r2', 'a.test.ts', 'flaky one', 'passed-on-retry'),
      { ...run('r3', ['a.test.ts', 'b.test.ts']), load: 2.5, workers: 2 },
      failure('r3', 'b.test.ts', 'b fails'),
      failure('r3', 'b.test.ts', 'b fails', 'passed-on-retry'),
      { ...run('r4', ['a.test.ts']), load: 0.75 },
      run('broken', ['a.test.ts']),
      ...many,
      run('too old', ['a.test.ts'], now - 8 * day),
      failure('too old', 'a.test.ts', 'flaky one'),
      failure('no run line', 'a.test.ts', 'flaky one'),
    ]
      .map((record) => JSON.stringify(record))
      .concat('not json', '{"type":"run"}', '')
      .join('\n'),
  )
  const report = failureReport(records, now - 7 * day)
  expect(report).toEqual({
    runs: 5,
    failedRuns: 3,
    retriedRuns: 1,
    excludedRuns: 1,
    busyRuns: 1,
    busyFailedRuns: 1,
    tests: [
      { name: 'a.test.ts > flaky one', failed: 1, retried: 1, busy: 0, runs: 4, rate: 0.5 },
      { name: 'b.test.ts > b fails', failed: 1, retried: 0, busy: 1, runs: 2, rate: 0.5 },
      { name: 'a.test.ts > other', failed: 0, retried: 1, busy: 0, runs: 4, rate: 0.25 },
    ],
    files: [
      { name: 'a.test.ts', failed: 1, retried: 1, busy: 0, runs: 4, rate: 0.5 },
      { name: 'b.test.ts', failed: 1, retried: 0, busy: 1, runs: 2, rate: 0.5 },
    ],
  })
  const text = failureText(report)
  expect(text).toContain(
    '5 runs: 3 with a failed test, 1 more with only tests that passed on retry.',
  )
  expect(text).toContain(`Left out below: 1 run with more than ${brokenRunTests} failed tests`)
  expect(text).toContain('     1        1     0      4    50%  a.test.ts > flaky one')
  expect(text).toContain(
    '1 run started on a busy machine (load per core above 0.75); 1 of them had a failed test.',
  )
  expect(failureText(failureReport([], 0))).toContain('== Tests\nNone.')
})
