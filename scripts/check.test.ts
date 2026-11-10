import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { failedTests, parseReport } from './check.ts'
import {
  appendRun,
  type FailureRun,
  failureSummary,
  parseHistory,
  recordFailureRun,
} from './check-history.ts'

const at = '2026-11-10T00:00:00.000Z'
const run = (failures: string[] = [], problems: string[] = []): FailureRun => ({
  at,
  ok: failures.length === 0 && problems.length === 0,
  failures,
  problems,
})
const folders: string[] = []
function historyFile(): string {
  const folder = mkdtempSync(path.join(tmpdir(), 'ted-check-history-'))
  folders.push(folder)
  return path.join(folder, 'failures.json')
}
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function report(status = 'passed') {
  const failed = status === 'failed'
  return {
    success: !failed,
    numTotalTests: 1,
    numPassedTests: failed ? 0 : 1,
    numFailedTests: failed ? 1 : 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTestSuites: 1,
    numPassedTestSuites: failed ? 0 : 1,
    numFailedTestSuites: failed ? 1 : 0,
    numPendingTestSuites: 0,
    testResults: [
      {
        name: path.resolve('scripts/example.test.ts'),
        status: failed ? 'failed' : 'passed',
        startTime: 10,
        endTime: 20,
        assertionResults: [{ fullName: 'example works', status }],
      },
    ],
  }
}
const parse = (value: unknown, exitedOk = true) =>
  parseReport(JSON.stringify(value), 'node', exitedOk)

describe('failure window', () => {
  test('successful runs age failures out after 20 runs', () => {
    let runs = [run(['old'])]
    for (let i = 0; i < 19; i++) runs = appendRun(runs, run())
    expect(runs).toHaveLength(20)
    expect(failureSummary(runs)).toContain('1 run  old')
    runs = appendRun(runs, run())
    expect(runs).toHaveLength(20)
    expect(failureSummary(runs)).toContain('No named test failures recorded.')
    expect(failureSummary(runs)).not.toContain('1 run  old')
  })

  test('counts each test once per run and orders ties by identity', () => {
    const runs = appendRun([run(['b', 'b', 'a'])], run(['c', 'b', 'b']))
    expect(runs[1]?.failures).toEqual(['c', 'b'])
    expect(failureSummary(runs)).toBe(
      '== Most frequently observed test failures (last 2 runs; 0 incomplete)\n  2 runs  b\n  1 run  a\n  1 run  c',
    )
  })

  test('prints at most 10 failures with deterministic ties', () => {
    const summary = failureSummary([
      run(Array.from({ length: 12 }, (_, i) => `test-${String(i).padStart(2, '0')}`)),
    ])
    expect(summary.split('\n')).toHaveLength(11)
    expect(summary).toContain('test-09')
    expect(summary).not.toContain('test-10')
  })

  test('shows incomplete windows even when no named failure is available', () => {
    expect(failureSummary([run([], ['electron: missing report'])])).toContain('1 incomplete')
    expect(failureSummary([run([], ['electron: missing report'])])).toContain(
      'may have unreported failures',
    )
  })
})

describe('history persistence', () => {
  test('creates missing history and round-trips successful and failed runs', () => {
    const file = historyFile()
    const warnings: string[] = []
    recordFailureRun(file, run(['failure']), (message) => warnings.push(message))
    recordFailureRun(file, run(), (message) => warnings.push(message))
    expect(parseHistory(readFileSync(file, 'utf8'))).toEqual([run(['failure']), run()])
    expect(warnings).toEqual([])
    expect(readdirSync(path.dirname(file))).toEqual(['failures.json'])
  })

  test.each(['{', 'null', '{"version":2,"runs":[]}', '{"version":1,"runs":[{}]}'])(
    'warns and resets invalid history: %s',
    (text) => {
      const file = historyFile()
      writeFileSync(file, text)
      const warnings: string[] = []
      recordFailureRun(file, run(), (message) => warnings.push(message))
      expect(warnings).toHaveLength(1)
      expect(parseHistory(readFileSync(file, 'utf8'))).toEqual([run()])
    },
  )

  test('rejects invalid fields and caps loaded history', () => {
    expect(() =>
      parseHistory(JSON.stringify({ version: 1, runs: [{ ...run(), failures: [7] }] })),
    ).toThrow()
    expect(() =>
      parseHistory(JSON.stringify({ version: 1, runs: [{ ...run(), at: 'yesterday' }] })),
    ).toThrow()
    expect(
      parseHistory(JSON.stringify({ version: 1, runs: Array.from({ length: 25 }, () => run()) })),
    ).toHaveLength(20)
  })

  test('surfaces write failures and removes temporary files', () => {
    const file = historyFile()
    expect(() =>
      recordFailureRun(path.join(file, 'missing', 'failures.json'), run(), () => {}),
    ).toThrow()
    expect(readdirSync(path.dirname(file))).toEqual([])
  })
})

describe('project reports', () => {
  test('accepts passing and named-failure reports and preserves durations', () => {
    expect(parse(report())).toMatchObject({ ok: true, problems: [] })
    const result = parse(report('failed'), false)
    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([])
    expect(failedTests(result.report)).toEqual(['scripts/example.test.ts > example works'])
    expect(result.report.testResults?.[0]).toMatchObject({ startTime: 10, endTime: 20 })
  })

  test.each(['skipped', 'todo', 'disabled'])('accepts intentional %s assertions', (status) => {
    const value = report(status)
    value.numPassedTests = 0
    if (status === 'todo') value.numTodoTests = 1
    else value.numPendingTests = 1
    expect(parse(value)).toMatchObject({ ok: true, problems: [] })
  })

  test('accepts an explicitly successful empty project', () => {
    const value = report()
    value.testResults = []
    value.numTotalTests = 0
    value.numPassedTests = 0
    value.numTotalTestSuites = 0
    value.numPassedTestSuites = 0
    expect(parse(value)).toMatchObject({ ok: true, problems: [] })
  })

  test.each(['', '{', 'null', '{}', '{"testResults":[]}'])(
    'never treats absent or invalid reports as clean: %s',
    (text) => {
      expect(parseReport(text, 'electron', true)).toMatchObject({ ok: false })
      expect(parseReport(text, 'electron', true).problems.length).toBeGreaterThan(0)
    },
  )

  test('reports suite-load failures without named failures', () => {
    const value = report('failed')
    for (const file of value.testResults) file.assertionResults = []
    value.numTotalTests = 0
    value.numFailedTests = 0
    const result = parse(value, false)
    expect(result.ok).toBe(false)
    expect(result.problems.join('\n')).toContain('suite failed without a named test failure')
  })

  test('rejects unfinished assertions, mismatched totals and contradictory exit results', () => {
    expect(parse(report('pending')).problems.join('\n')).toContain('unfinished assertion')
    expect(parse({ ...report(), numTotalTests: 2 }).problems.join('\n')).toContain('do not match')
    expect(parse(report(), false).problems.join('\n')).toContain('failed execution')
  })

  test('rejects positive suite totals without file results but accepts nested suites', () => {
    const value = report()
    expect(parse({ ...value, numTotalTestSuites: 3, numPassedTestSuites: 3 }).ok).toBe(true)
    const missing = parse({ ...value, numTotalTests: 0, numPassedTests: 0, testResults: [] })
    expect(missing.ok).toBe(false)
    expect(missing.problems.join('\n')).toContain('suite results do not match')
  })

  test.each([
    'numTotalTests',
    'numPassedTests',
    'numFailedTests',
    'numPendingTests',
    'numTodoTests',
    'numTotalTestSuites',
    'numPassedTestSuites',
    'numFailedTestSuites',
    'numPendingTestSuites',
  ])('retains named failures when %s is an object that cannot be coerced', (field) => {
    const result = parse({ ...report('failed'), [field]: { toString: null } }, false)
    expect(result.ok).toBe(false)
    expect(result.problems.join('\n')).toContain('invalid report totals')
    expect(failedTests(result.report)).toEqual(['scripts/example.test.ts > example works'])
  })

  test('retains valid assertions despite malformed assertion and file statuses', () => {
    const value = report('failed')
    const result = parse(
      {
        ...value,
        testResults: value.testResults.map((file) => ({
          ...file,
          status: { toString: null },
          assertionResults: [
            ...file.assertionResults,
            { fullName: 'malformed', status: { toString: null } },
          ],
        })),
      },
      false,
    )
    expect(result.ok).toBe(false)
    expect(result.problems.join('\n')).toContain('invalid assertion')
    expect(result.problems.join('\n')).toContain('invalid test file status')
    expect(failedTests(result.report)).toEqual(['scripts/example.test.ts > example works'])
  })

  test('rejects ambiguous pending suites, including intentional todo suites', () => {
    const value = report()
    const result = parse({
      ...value,
      numTotalTests: 0,
      numPassedTests: 0,
      numPassedTestSuites: 0,
      numPendingTestSuites: 1,
      testResults: value.testResults.map((file) => ({ ...file, assertionResults: [] })),
    })
    expect(result.ok).toBe(false)
    expect(result.problems.join('\n')).toContain('pending suites cannot be confirmed complete')
    expect(result.problems.join('\n')).toContain('intentional todo suites')
  })

  test('preserves suite errors alongside named assertion failures', () => {
    const value = report('failed')
    const result = parse(
      {
        ...value,
        testResults: value.testResults.map((file) => ({
          ...file,
          message: 'afterAll cleanup failed',
        })),
      },
      false,
    )
    expect(result.ok).toBe(false)
    expect(result.problems.join('\n')).toContain('afterAll cleanup failed')
    expect(failedTests(result.report)).toEqual(['scripts/example.test.ts > example works'])
  })

  test('keeps valid failures from partial reports and persists an incomplete window', () => {
    const value = report('failed')
    const partial = { ...value, testResults: [...value.testResults, null] }
    const result = parse(partial, false)
    const missing = parseReport('', 'electron', false)
    const file = historyFile()
    const summary = recordFailureRun(
      file,
      run(
        [...failedTests(result.report), ...failedTests(missing.report)],
        [...result.problems, ...missing.problems],
      ),
      () => {},
    )
    expect(summary).toContain('1 run  scripts/example.test.ts > example works')
    expect(summary).toContain('1 incomplete')
    expect(parseHistory(readFileSync(file, 'utf8'))[0]?.ok).toBe(false)
  })
})

describe('check runner integration with stub processes', () => {
  test.each([
    'passed',
    'failed',
    'missing',
    'malformed',
    'write-error',
    'missing-suites',
    'malformed-assertion',
    'malformed-file',
    'malformed-counter',
    'pending-suite',
    'suite-error',
  ])('records and reports a %s run without executing the suite', (mode) => {
    const root = path.dirname(historyFile())
    const scripts = path.join(root, 'scripts')
    const support = path.join(root, 'packages/daemon/test/support')
    const cache = path.join(root, 'node_modules/.cache')
    mkdirSync(scripts, { recursive: true })
    mkdirSync(support, { recursive: true })
    mkdirSync(cache, { recursive: true })
    for (const file of ['check.ts', 'check-history.ts']) {
      copyFileSync(path.join(import.meta.dirname, file), path.join(scripts, file))
    }
    writeFileSync(
      path.join(support, 'suite-lock.ts'),
      `
        import { writeFileSync } from 'node:fs'
        export const heldLockEnv = 'TED_STUB_CHECK_LOCK'
        export const waitingMessage = () => ''
        export async function acquireSuiteLock() {
          return async () => writeFileSync(${JSON.stringify(path.join(root, 'unlocked'))}, 'yes')
        }
      `,
    )
    writeFileSync(
      path.join(root, 'run.ts'),
      `
        import { runChecks } from ${JSON.stringify(path.join(scripts, 'check.ts'))}
        console.log('RESULT=' + await runChecks())
      `,
    )
    const failed = [
      'failed',
      'missing-suites',
      'malformed-assertion',
      'malformed-file',
      'malformed-counter',
      'pending-suite',
      'suite-error',
    ].includes(mode)
    const value = report(failed ? 'failed' : 'passed')
    let nodeReport: Record<string, unknown> = value
    if (mode === 'malformed-counter')
      nodeReport = { ...value, numTotalTestSuites: { toString: null } }
    if (mode === 'malformed-assertion')
      nodeReport = {
        ...value,
        testResults: value.testResults.map((file) => ({
          ...file,
          assertionResults: [
            ...file.assertionResults,
            { fullName: 'malformed', status: { toString: null } },
          ],
        })),
      }
    if (mode === 'malformed-file')
      nodeReport = {
        ...value,
        testResults: value.testResults.map((file) => ({
          ...file,
          status: { toString: null },
        })),
      }
    if (mode === 'suite-error')
      nodeReport = {
        ...value,
        testResults: value.testResults.map((file) => ({
          ...file,
          message: 'afterAll cleanup failed',
        })),
      }
    if (mode === 'missing-suites' || mode === 'pending-suite') {
      const empty = report()
      nodeReport = {
        ...empty,
        numTotalTests: 0,
        numPassedTests: 0,
        numPassedTestSuites: mode === 'pending-suite' ? 0 : 1,
        numPendingTestSuites: mode === 'pending-suite' ? 1 : 0,
        testResults:
          mode === 'missing-suites'
            ? []
            : empty.testResults.map((file) => ({
                ...file,
                assertionResults: [],
              })),
      }
    }
    writeFileSync(
      path.join(root, 'pnpm'),
      `#!${process.execPath}
        const fs = require('node:fs')
        const args = process.argv.slice(2)
        fs.appendFileSync(${JSON.stringify(path.join(root, 'commands'))}, JSON.stringify(args) + '\\n')
        if (args[0] === 'exec') {
          const project = args[args.indexOf('--project') + 1]
          const file = args[args.indexOf('--outputFile.json') + 1]
          const omit = project === 'electron' && ${JSON.stringify(mode === 'missing')}
          if (!omit) fs.writeFileSync(file, project === 'node' ? ${JSON.stringify(mode === 'malformed' ? '{' : JSON.stringify(nodeReport))} : ${JSON.stringify(mode === 'malformed' ? '{' : JSON.stringify(value))})
          console.log(' Test Files 1 ' + ${JSON.stringify(failed ? 'failed' : 'passed')})
          process.exit(project === 'node' ? ${nodeReport.success === false ? 1 : 0} : ${failed ? 1 : 0})
        }
      `,
      { mode: 0o755 },
    )
    if (mode === 'write-error') mkdirSync(path.join(cache, 'ted-test-failures.json'))
    const output = execFileSync(process.execPath, [path.join(root, 'run.ts')], {
      env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}` },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(output).toContain(`RESULT=${mode === 'passed'}`)
    expect(readFileSync(path.join(root, 'unlocked'), 'utf8')).toBe('yes')
    const commands = readFileSync(path.join(root, 'commands'), 'utf8')
    expect(commands).toContain('"--project","electron","--maxWorkers","3"')
    expect(commands).toContain('"--project","node","--maxWorkers","6"')
    if (mode === 'write-error') return
    const runs = parseHistory(readFileSync(path.join(cache, 'ted-test-failures.json'), 'utf8'))
    expect(runs).toHaveLength(1)
    expect(runs[0]?.ok).toBe(mode === 'passed')
    expect(output).toContain('Most frequently observed test failures (last 1 runs;')
    if (failed) {
      expect(runs[0]?.failures).toHaveLength(1)
      expect(output).toContain('× ')
      expect(output).toContain('Slowest test files')
    }
    if (!['passed', 'failed'].includes(mode)) {
      expect(runs[0]?.problems.length).toBeGreaterThan(0)
      expect(output).toContain('1 incomplete')
    }
    if (mode === 'suite-error') {
      expect(runs[0]?.problems.join('\n')).toContain('afterAll cleanup failed')
    }
  })
})
