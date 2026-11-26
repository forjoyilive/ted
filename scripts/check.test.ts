import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
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
import {
  affectedRefusal,
  failedTests,
  groupsFor,
  onlyAppChanged,
  parseReport,
  parseRetries,
  passedFiles,
  passedInRun,
  recordPassed,
  runRefusal,
  sandboxSkipped,
  sandboxSkippedInRun,
} from './check.ts'
import {
  appendRun,
  type FailureRun,
  failureSummary,
  parseHistory,
  recordFailureRun,
} from './check-history.ts'

describe('which tests a change needs', () => {
  test('a change inside the app’s source and tests needs only the app’s tests', () => {
    expect(onlyAppChanged(['packages/app/src/renderer/views/Board.tsx'])).toBe(true)
    expect(
      onlyAppChanged([
        'packages/app/test/board-component.test.tsx',
        'packages/app/src/main.ts',
        'docs/environment.md',
        'AGENTS.md',
      ]),
    ).toBe(true)
  })

  test.each([
    ['daemon code', ['packages/app/src/main.ts', 'packages/daemon/src/server.ts']],
    ['protocol code', ['packages/app/src/main.ts', 'packages/protocol/src/task.ts']],
    ['the CLI', ['packages/cli/src/main.ts']],
    ['the app’s own config', ['packages/app/src/main.ts', 'packages/app/package.json']],
    ['the repo’s config', ['packages/app/src/main.ts', 'vitest.config.ts']],
    ['the lockfile', ['packages/app/src/main.ts', 'pnpm-lock.yaml']],
    ['the check script', ['packages/app/src/main.ts', 'scripts/check.ts']],
    ['docs alone', ['docs/agents/tasks.md', 'AGENTS.md']],
    ['nothing', []],
  ])('a change that touches %s needs every test', (_, files) => {
    expect(onlyAppChanged(files)).toBe(false)
  })
})

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

describe('recording a passed commit', () => {
  const commit = 'a'.repeat(40)

  test('appends the commit to ted-checked', () => {
    const file = historyFile()
    expect(recordPassed(commit, file)).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toBe(`${commit}\n`)
  })

  test('returns the error instead of throwing when ted-checked can’t be written', () => {
    const file = historyFile()
    mkdirSync(file)
    expect(recordPassed(commit, file)).toMatch(/EISDIR/)
  })
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

describe('pnpm check started by a Run', () => {
  test('is refused', () => {
    expect(runRefusal({})).toBeUndefined()
    expect(runRefusal({ TED_RUN: 'run-1' })).toContain('pnpm vitest run <files>')
  })
})

describe('pnpm check --affected', () => {
  test('is refused for a Run unless it only lists', () => {
    expect(affectedRefusal({})).toBeUndefined()
    expect(affectedRefusal({ TED_TASK: 'TED-1', CI: '1' })).toBeUndefined()
    expect(affectedRefusal({ TED_RUN: 'run-1' })).toContain('--list')
  })

  test('runs only the projects that have files, with a small run’s workers below 10 files', () => {
    expect(groupsFor(undefined)).toEqual([
      { project: 'electron', maxWorkers: 3 },
      { project: 'node', maxWorkers: 6 },
    ])
    expect(groupsFor(undefined, { node: ['a.test.ts'], electron: [] })).toEqual([
      { project: 'node', maxWorkers: 3 },
    ])
    const many = Array.from({ length: 10 }, (_, index) => `${index}.test.ts`)
    expect(groupsFor(undefined, { node: many, electron: ['e.test.ts'] })).toEqual([
      { project: 'electron', maxWorkers: 3 },
      { project: 'node', maxWorkers: 6 },
    ])
    expect(groupsFor(1.5, { node: many })).toEqual([{ project: 'node', maxWorkers: 3 }])
  })

  test('keeps to the CPUs Ted allows a Check, before the load scales it further', () => {
    const many = Array.from({ length: 10 }, (_, index) => `${index}.test.ts`)
    expect(groupsFor(undefined, { node: many }, 6)).toEqual([{ project: 'node', maxWorkers: 3 }])
    expect(groupsFor(undefined, { node: many }, 12)).toEqual([{ project: 'node', maxWorkers: 6 }])
    expect(groupsFor(undefined, { node: many, electron: ['e.test.ts'] }, 6)).toEqual([
      { project: 'electron', maxWorkers: 1 },
      { project: 'node', maxWorkers: 2 },
    ])
    expect(groupsFor(undefined, { node: ['a.test.ts'] }, 6)).toEqual([
      { project: 'node', maxWorkers: 3 },
    ])
    expect(groupsFor(1.5, { node: many }, 6)).toEqual([{ project: 'node', maxWorkers: 2 }])
  })

  test('counts a file as passed only when every test passed on the first try', () => {
    const file = 'scripts/example.test.ts'
    expect(passedFiles(parse(report('passed')).report, [])).toEqual([file])
    expect(passedFiles(parse(report('passed')).report, [`${file} > example works`])).toEqual([])
    expect(passedFiles(parse(report('passed')).report, ['scripts/other.test.ts > x'])).toEqual([
      file,
    ])
    expect(passedFiles(parse(report('failed'), false).report, [])).toEqual([])
    const value = report('passed')
    const suiteError = {
      ...value,
      testResults: value.testResults.map((result) => ({ ...result, message: 'afterAll failed' })),
    }
    expect(passedFiles(parse(suiteError).report, [])).toEqual([])
  })

  test('a file whose tests Ted’s sandbox skipped is left out, not counted as passed', () => {
    const file = 'scripts/example.test.ts'
    const reason = 'a second sandbox can’t start'
    const value = {
      ...report('passed'),
      numTotalTests: 3,
      numPassedTests: 1,
      numPendingTests: 2,
      testResults: report('passed').testResults.map((result) => ({
        ...result,
        assertionResults: [
          { fullName: 'example works', status: 'passed', meta: {} },
          { fullName: 'needs a sandbox', status: 'skipped', meta: { tedSandboxSkipped: reason } },
          { fullName: 'needs it too', status: 'skipped', meta: { tedSandboxSkipped: reason } },
        ],
      })),
    }
    const parsed = parse(value)
    expect(parsed.problems).toEqual([])
    expect(sandboxSkipped(parsed.report)).toEqual(new Map([[file, [reason]]]))
    expect(passedFiles(parsed.report, [])).toEqual([])
    expect([...sandboxSkippedInRun([{ project: 'node', result: parsed, retried: [] }])]).toEqual([
      [file, [reason]],
    ])
    expect([...passedInRun([{ project: 'node', result: parsed, retried: [] }])]).toEqual([])
  })

  test('a test skipped for another reason still lets its file count as passed', () => {
    const file = 'scripts/example.test.ts'
    const value = {
      ...report('passed'),
      numTotalTests: 2,
      numPendingTests: 1,
      testResults: report('passed').testResults.map((result) => ({
        ...result,
        assertionResults: [
          { fullName: 'example works', status: 'passed' },
          { fullName: 'only on Linux', status: 'skipped', meta: {} },
        ],
      })),
    }
    const parsed = parse(value)
    expect(sandboxSkipped(parsed.report).size).toBe(0)
    expect(passedFiles(parsed.report, [])).toEqual([file])
  })

  test('a project whose report has problems or no retry report records no passes', () => {
    const file = 'scripts/example.test.ts'
    const valid = { project: 'node', result: parse(report('passed')), retried: [] }
    expect([...passedInRun([valid])]).toEqual([file])
    expect([...passedInRun([{ ...valid, retried: undefined }])]).toEqual([])
    const badTotals = parse({ ...report('passed'), numPassedTests: 2 })
    expect(badTotals.problems.length).toBeGreaterThan(0)
    expect([...passedInRun([{ ...valid, result: badTotals }])]).toEqual([])
    expect([...passedInRun([{ ...valid, result: parse(report('passed'), false) }])]).toEqual([])
  })
})

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

  test('lists tests that passed on retry apart from failures, once per run', () => {
    const retried = { ...run(), passedOnRetry: ['flaky', 'flaky'] }
    const runs = appendRun(appendRun([run(['broken'])], retried), retried)
    expect(runs[2]?.passedOnRetry).toEqual(['flaky'])
    expect(runs[2]?.ok).toBe(true)
    expect(failureSummary(runs)).toBe(
      [
        '== Most frequently observed test failures (last 3 runs; 0 incomplete)',
        '  1 run  broken',
        '== Tests that failed, then passed on retry (last 3 runs)',
        '  2 runs  flaky',
      ].join('\n'),
    )
    expect(appendRun([], { ...run(), passedOnRetry: [] })).toEqual([run()])
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

  test('reads history written before retries were recorded, and history with them', () => {
    const file = historyFile()
    writeFileSync(file, JSON.stringify({ version: 1, runs: [run(['old'])] }))
    recordFailureRun(file, { ...run(), passedOnRetry: ['flaky'] }, () => {})
    expect(parseHistory(readFileSync(file, 'utf8'))).toEqual([
      run(['old']),
      { ...run(), passedOnRetry: ['flaky'] },
    ])
    expect(() =>
      parseHistory(JSON.stringify({ version: 1, runs: [{ ...run(), passedOnRetry: [7] }] })),
    ).toThrow()
  })

  test('reads a retry report and rejects a malformed one', () => {
    expect(parseRetries('{"passedOnRetry":["a > b"]}')).toEqual(['a > b'])
    expect(parseRetries('{"passedOnRetry":[]}')).toEqual([])
    for (const text of ['', '{', '{}', '{"passedOnRetry":[1]}', '[]']) {
      expect(parseRetries(text)).toBeUndefined()
    }
  })

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
    'install-failed',
    'retried',
    'failed',
    'missing',
    'malformed',
    'write-error',
    'timing-error',
    'timing-error-with-failure',
    'missing-suites',
    'malformed-assertion',
    'malformed-file',
    'malformed-counter',
    'pending-suite',
    'suite-error',
    'affected',
  ])('records and reports a %s run without executing the suite', (mode) => {
    const root = path.dirname(historyFile())
    const scripts = path.join(root, 'scripts')
    const support = path.join(root, 'packages/daemon/test/support')
    const cache = path.join(root, 'node_modules/.cache')
    mkdirSync(scripts, { recursive: true })
    mkdirSync(support, { recursive: true })
    mkdirSync(cache, { recursive: true })
    for (const file of [
      'check.ts',
      'check-history.ts',
      'check-measurement.ts',
      'machine-load.ts',
    ]) {
      copyFileSync(path.join(import.meta.dirname, file), path.join(scripts, file))
    }
    mkdirSync(path.join(root, 'packages/protocol/src'), { recursive: true })
    copyFileSync(
      path.join(import.meta.dirname, '../packages/protocol/src/parse.ts'),
      path.join(root, 'packages/protocol/src/parse.ts'),
    )
    writeFileSync(
      path.join(support, 'suite-lock.ts'),
      `
        import { writeFileSync } from 'node:fs'
        export const heldLockEnv = 'TED_STUB_CHECK_LOCK'
        export const smallRunFiles = 10
        export const waitingMessage = () => ''
        export async function acquireFullRun() {
          writeFileSync(${JSON.stringify(path.join(root, 'locked'))}, 'yes')
          return async () => writeFileSync(${JSON.stringify(path.join(root, 'unlocked'))}, 'yes')
        }
      `,
    )
    writeFileSync(
      path.join(scripts, 'test-reporting.ts'),
      `export { acquireFullRun as reportedTestLock } from '../packages/daemon/test/support/suite-lock.ts'`,
    )
    const failed = [
      'failed',
      'missing-suites',
      'malformed-assertion',
      'malformed-file',
      'malformed-counter',
      'pending-suite',
      'suite-error',
      'timing-error-with-failure',
    ].includes(mode)
    const busyMachine = mode === 'retried'
    writeFileSync(
      path.join(root, 'run.ts'),
      `
        import { runChecks } from ${JSON.stringify(path.join(scripts, 'check.ts'))}
        console.log('RESULT=' + await runChecks(${
          mode === 'affected' || mode === 'install-failed'
            ? "{ testsOnly: true, files: { node: ['scripts/a.test.ts'], electron: [] }, onResults: (results) => console.log('RESULTS=' + results.map((r) => r.project + ':' + r.result.problems.length).join(',')) }"
            : busyMachine
              ? '{ quietWait: 1 }'
              : ''
        }))
      `,
    )
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
        if (args[0] === 'install' && !fs.existsSync(${JSON.stringify(path.join(root, 'locked'))})) process.exit(9)
        if (args[0] === 'install' && ${JSON.stringify(mode === 'install-failed')}) process.exit(1)
        if (args[0] === 'exec') {
          const project = args[args.indexOf('--project') + 1]
          const file = args[args.indexOf('--outputFile.json') + 1]
          const omit = project === 'electron' && ${JSON.stringify(mode === 'missing')}
          if (${JSON.stringify(mode === 'retried')}) {
            const retried = project === 'electron' ? ['packages/app/test/a.test.ts > opens'] : []
            fs.writeFileSync(process.env.TED_RETRY_REPORT, JSON.stringify({ passedOnRetry: retried }))
          }
          if (!omit) fs.writeFileSync(file, project === 'node' ? ${JSON.stringify(mode === 'malformed' ? '{' : JSON.stringify(nodeReport))} : ${JSON.stringify(mode === 'malformed' ? '{' : JSON.stringify(value))})
          console.log(' Test Files 1 ' + ${JSON.stringify(failed ? 'failed' : 'passed')})
          process.exit(project === 'node' ? ${nodeReport.success === false ? 1 : 0} : ${failed ? 1 : 0})
        }
      `,
      { mode: 0o755 },
    )
    if (mode === 'write-error') mkdirSync(path.join(cache, 'ted-test-failures.json'))
    if (mode.startsWith('timing-error')) mkdirSync(path.join(cache, 'ted-test-times.json'))
    const result = spawnSync(process.execPath, [path.join(root, 'run.ts')], {
      env: {
        ...process.env,
        PATH: `${root}${path.delimiter}${process.env.PATH}`,
        TED_CHECK_EVIDENCE_DIR: root,
        TED_CHECK_CPUS: '',
        ...(busyMachine && { TED_TEST_LOAD: '2' }),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    const output = result.stdout
    expect(output).toContain(
      `RESULT=${mode === 'passed' || mode === 'retried' || mode === 'affected'}`,
    )
    if (mode.startsWith('timing-error')) {
      expect(result.stderr).toContain('Could not save test timings')
      expect(result.stderr).toContain('Timing reporting')
    }
    if (mode === 'install-failed') {
      expect(readFileSync(path.join(root, 'unlocked'), 'utf8')).toBe('yes')
      const measured = JSON.parse(readFileSync(path.join(root, 'check-measurement.json'), 'utf8'))
      expect(measured.ok).toBe(false)
      expect(measured.lockWaitMs).toBeGreaterThanOrEqual(0)
      expect(measured.artifacts).toEqual({})
      expect(readFileSync(path.join(root, 'commands'), 'utf8')).not.toContain('vitest')
      expect(output).not.toContain('RESULTS=')
      return
    }
    expect(readFileSync(path.join(root, 'unlocked'), 'utf8')).toBe('yes')
    if (mode === 'affected') {
      const commands = readFileSync(path.join(root, 'commands'), 'utf8')
      expect(commands).toContain('"--project","node","--maxWorkers","3"')
      expect(commands).toContain('"scripts/a.test.ts"]')
      expect(commands).not.toContain('"electron"')
      expect(commands).not.toContain('typecheck')
      expect(commands).not.toContain('lint')
      expect(output).toContain('== Test (node ×3)')
      expect(output).toContain('RESULTS=node:0')
      expect(existsSync(path.join(cache, 'ted-test-times.json'))).toBe(false)
      return
    }
    const measured = JSON.parse(readFileSync(path.join(root, 'check-measurement.json'), 'utf8'))
    expect(measured.phases.lock.endMs).toBeGreaterThanOrEqual(measured.phases.lock.startMs)
    expect(measured.testProcessEnvelopeMs).toBeGreaterThan(0)
    expect(measured.workMs + measured.lockWaitMs).toBeCloseTo(measured.totalMs)
    expect(measured.ok).toBe(mode === 'passed' || mode === 'retried')
    const commands = readFileSync(path.join(root, 'commands'), 'utf8')
    expect(commands).toContain('--config.confirm-modules-purge=false')
    expect(measured.phases.install.startMs).toBeGreaterThanOrEqual(measured.phases.lock.endMs)
    expect(commands).toContain(`"--project","electron","--maxWorkers","${busyMachine ? 1 : 3}"`)
    expect(commands).toContain(`"--project","node","--maxWorkers","${busyMachine ? 2 : 6}"`)
    expect(output.includes('The machine is busy (load per core 2.00')).toBe(busyMachine)
    expect(output.includes('Waiting for the machine to be quiet: load per core is 2.00')).toBe(
      busyMachine,
    )
    expect(output.includes('Starting the tests anyway.')).toBe(busyMachine)
    if (mode === 'write-error') return
    const runs = parseHistory(readFileSync(path.join(cache, 'ted-test-failures.json'), 'utf8'))
    expect(runs).toHaveLength(1)
    expect(runs[0]?.ok).toBe(mode === 'passed' || mode === 'retried')
    expect(runs[0]).toMatchObject(
      busyMachine
        ? { load: 2, workers: { electron: 1, node: 2 } }
        : { workers: { electron: 3, node: 6 } },
    )
    expect(commands).toContain('retry-reporter.ts')
    if (mode === 'retried') {
      expect(runs[0]?.passedOnRetry).toEqual(['packages/app/test/a.test.ts > opens'])
      expect(output).toContain('↻ passed on retry: packages/app/test/a.test.ts > opens')
      expect(output).toContain('Tests that failed, then passed on retry (last 1 runs)')
      expect(result.stderr).not.toContain('no retry report')
    } else {
      expect(runs[0]?.passedOnRetry).toBeUndefined()
      expect(result.stderr).toContain('no retry report')
    }
    expect(output).toContain('Most frequently observed test failures (last 1 runs;')
    if (failed) {
      expect(runs[0]?.failures).toHaveLength(1)
      expect(output).toContain('× ')
      if (!mode.startsWith('timing-error')) expect(output).toContain('Slowest test files')
    }
    if (!['passed', 'retried', 'failed'].includes(mode) && !mode.startsWith('timing-error')) {
      expect(runs[0]?.problems.length).toBeGreaterThan(0)
      expect(output).toContain('1 incomplete')
    }
    if (mode === 'suite-error') {
      expect(runs[0]?.problems.join('\n')).toContain('afterAll cleanup failed')
      expect(result.stderr).toContain('afterAll cleanup failed')
    }
  })
})
