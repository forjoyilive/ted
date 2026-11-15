import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import {
  heldLockEnv,
  smallRunFiles,
  waitingMessage,
} from '../packages/daemon/test/support/suite-lock.ts'
import { recordFailureRun } from './check-history.ts'
import { type CheckMeasurement, measureCheck } from './check-measurement.ts'
import {
  busy,
  busyLine,
  loadPerCore,
  quietWaitMs,
  scaledWorkers,
  waitForQuiet,
} from './machine-load.ts'
import { reportedTestLock } from './test-reporting.ts'

const root = path.resolve(import.meta.dirname, '..')
const cacheDir = path.join(root, 'node_modules', '.cache')
export const timesFile = path.join(cacheDir, 'ted-test-times.json')
export const failuresFile = path.join(cacheDir, 'ted-test-failures.json')
export const leftOutFile = path.join(cacheDir, 'ted-affected-left-out.txt')

const idleGroups = [
  { project: 'electron', maxWorkers: 3 },
  { project: 'node', maxWorkers: 6 },
]

type TestGroup = (typeof idleGroups)[number]

export type TestFiles = Record<string, readonly string[]>

export function groupsFor(load: number | undefined, files?: TestFiles): TestGroup[] {
  const shared = files !== undefined && fileCount(files) < smallRunFiles
  return idleGroups
    .filter((group) => files === undefined || (files[group.project]?.length ?? 0) > 0)
    .map((group) => ({
      ...group,
      maxWorkers: scaledWorkers(shared ? Math.min(group.maxWorkers, 3) : group.maxWorkers, load),
    }))
}

function fileCount(files: TestFiles): number {
  return Object.values(files).reduce((sum, list) => sum + list.length, 0)
}

const groupText = (groups: readonly TestGroup[]) =>
  groups.map((group) => `${group.project} ×${group.maxWorkers}`).join(', ')

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function checkedFile(): string {
  return path.resolve(root, git('rev-parse', '--git-common-dir'), 'ted-checked')
}

export function checkedCommits(text: string): Set<string> {
  return new Set(text.split('\n').filter((line) => /^[0-9a-f]{40}$/.test(line)))
}

export function hasPassed(commit: string): boolean {
  const file = checkedFile()
  return existsSync(file) && checkedCommits(readFileSync(file, 'utf8')).has(commit)
}

const appTests = 'packages/app/test'

export function onlyAppChanged(files: readonly string[]): boolean {
  return (
    files.some((file) => file.startsWith('packages/app/')) &&
    files.every(
      (file) => /^packages\/app\/(src|test)\//.test(file) || /^(docs\/|[^/]+\.md$)/.test(file),
    )
  )
}

function changedSinceMain(): string[] {
  try {
    if (git('branch', '--show-current') === 'main') return []
    const lines = (text: string) => text.split('\n').filter((line) => line !== '')
    return [
      ...lines(git('diff', '--name-only', git('merge-base', 'HEAD', 'origin/main'), 'HEAD')),
      ...lines(git('diff', '--name-only', 'HEAD')),
      ...lines(git('ls-files', '--others', '--exclude-standard')),
    ]
  } catch {
    return []
  }
}

type Step = { title: string; ok: boolean; output: string }

function run(
  title: string,
  args: string[],
  onLine?: (line: string) => void,
  more: Record<string, string> = {},
  measurement?: CheckMeasurement,
): Promise<Step> {
  measurement?.start(title)
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      ...more,
      [heldLockEnv]: String(process.pid),
      ...(process.stdout.isTTY && { FORCE_COLOR: '1' }),
    }
    const child = spawn('pnpm', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let partial = ''
    const take = (chunk: Buffer) => {
      const text = chunk.toString()
      output += text
      if (!onLine) return
      const lines = (partial + text).split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) onLine(line)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', (error) => {
      output += String(error)
    })
    child.on('close', (code) => {
      measurement?.end(title)
      if (onLine && partial) onLine(partial)
      resolve({ title, ok: code === 0, output })
    })
  })
}

export function summary(output: string): string {
  const lines = output.split('\n')
  const start = lines.findIndex((line) => /^\s*Test Files\b/.test(stripVTControlCharacters(line)))
  return start === -1 ? lines.slice(-15).join('\n') : lines.slice(start).join('\n').trimEnd()
}

type JsonReport = {
  testResults?: {
    name: string
    startTime?: number
    endTime?: number
    assertionResults?: { fullName: string; status: string }[]
  }[]
}

export function failedTests(report: JsonReport): string[] {
  return (report.testResults ?? []).flatMap((result) =>
    (result.assertionResults ?? [])
      .filter((test) => test.status === 'failed')
      .map((test) => `${path.relative(root, result.name)} > ${test.fullName}`),
  )
}

export function fileTimes(reports: JsonReport[]): Record<string, number> {
  const times: Record<string, number> = {}
  for (const report of reports) {
    for (const result of report.testResults ?? []) {
      if (result.startTime === undefined || result.endTime === undefined) continue
      times[path.relative(root, result.name)] = result.endTime - result.startTime
    }
  }
  return times
}

function reportFile(project: string): string {
  return path.join(cacheDir, `ted-test-report-${project}.json`)
}

function retryFile(project: string): string {
  return path.join(cacheDir, `ted-test-retries-${project}.json`)
}

export function parseRetries(text: string): string[] | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (!object(value) || !Array.isArray(value.passedOnRetry)) return undefined
    return value.passedOnRetry.every((name) => typeof name === 'string')
      ? value.passedOnRetry
      : undefined
  } catch {
    return undefined
  }
}

function readRetries(project: string): string[] | undefined {
  try {
    return parseRetries(readFileSync(retryFile(project), 'utf8'))
  } catch {
    return undefined
  }
}

type ProjectReport = { report: JsonReport; problems: string[]; ok: boolean }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function parseReport(text: string, project: string, exitedOk: boolean): ProjectReport {
  const report: JsonReport = { testResults: [] }
  const problems: string[] = []
  const problem = (message: string) => problems.push(`${project}: ${message}`)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    problem('missing or invalid JSON report')
    return { report, problems, ok: false }
  }
  if (!object(value) || !Array.isArray(value.testResults)) {
    problem('invalid report structure')
    return { report, problems, ok: false }
  }
  const counters = [
    'numTotalTests',
    'numPassedTests',
    'numFailedTests',
    'numPendingTests',
    'numTodoTests',
    'numTotalTestSuites',
    'numPassedTestSuites',
    'numFailedTestSuites',
    'numPendingTestSuites',
  ]
  if (counters.some((key) => count(value[key]) === undefined) || typeof value.success !== 'boolean')
    problem('invalid report totals or success flag')
  let assertions = 0
  let failures = 0
  let passed = 0
  let pending = 0
  let todo = 0
  for (const file of value.testResults) {
    if (!object(file) || typeof file.name !== 'string' || !Array.isArray(file.assertionResults)) {
      problem('invalid test file result')
      continue
    }
    const results: { fullName: string; status: string }[] = []
    for (const test of file.assertionResults) {
      if (
        !object(test) ||
        typeof test.fullName !== 'string' ||
        typeof test.status !== 'string' ||
        !['passed', 'failed', 'skipped', 'pending', 'todo', 'disabled'].includes(test.status)
      ) {
        problem(`invalid assertion in ${path.relative(root, file.name)}`)
        continue
      }
      const status = test.status
      results.push({ fullName: test.fullName, status })
      assertions++
      if (status === 'failed') failures++
      if (status === 'passed') passed++
      if (['skipped', 'pending', 'disabled'].includes(status)) pending++
      if (status === 'todo') todo++
      if (status === 'pending') problem(`unfinished assertion in ${path.relative(root, file.name)}`)
    }
    if (file.status !== 'passed' && file.status !== 'failed') problem('invalid test file status')
    if (typeof file.message === 'string' && file.message.trim()) {
      problem(`suite error in ${path.relative(root, file.name)}: ${file.message}`)
    } else if (file.message !== undefined && typeof file.message !== 'string') {
      problem(`invalid suite error in ${path.relative(root, file.name)}`)
    }
    if (file.status === 'failed' && !results.some((test) => test.status === 'failed')) {
      problem(`suite failed without a named test failure: ${path.relative(root, file.name)}`)
    }
    report.testResults?.push({
      name: file.name,
      assertionResults: results,
      ...(typeof file.startTime === 'number' &&
        Number.isFinite(file.startTime) &&
        typeof file.endTime === 'number' &&
        Number.isFinite(file.endTime) &&
        file.endTime >= file.startTime && { startTime: file.startTime, endTime: file.endTime }),
    })
  }
  if (
    assertions !== value.numTotalTests ||
    failures !== value.numFailedTests ||
    passed !== value.numPassedTests ||
    pending !== value.numPendingTests ||
    todo !== value.numTodoTests
  ) {
    problem('assertion results do not match report totals')
  }
  const totalSuites = count(value.numTotalTestSuites)
  const passedSuites = count(value.numPassedTestSuites)
  const failedSuites = count(value.numFailedTestSuites)
  const pendingSuites = count(value.numPendingTestSuites)
  if (
    totalSuites !== undefined &&
    passedSuites !== undefined &&
    failedSuites !== undefined &&
    pendingSuites !== undefined
  ) {
    if (
      totalSuites < value.testResults.length ||
      passedSuites + failedSuites + pendingSuites !== totalSuites ||
      (totalSuites > 0 && value.testResults.length === 0)
    ) {
      problem('suite results do not match report totals')
    }
    // Vitest counts unfinished and intentional todo suites together in JSON.
    if (pendingSuites > 0) {
      problem('pending suites cannot be confirmed complete (includes intentional todo suites)')
    }
  }
  if (value.success === false && failures === 0)
    problem('project failed without named test failures')
  if (!exitedOk && failures === 0) problem('test process failed without named test failures')
  if (
    value.success === true &&
    (failures > 0 || (failedSuites !== undefined && failedSuites > 0) || !exitedOk)
  ) {
    problem('successful report conflicts with failed execution')
  }
  return {
    report,
    problems: [...new Set(problems)],
    ok: exitedOk && value.success === true && problems.length === 0,
  }
}

function readReport(project: string, exitedOk: boolean): ProjectReport {
  let text = ''
  try {
    text = readFileSync(reportFile(project), 'utf8')
  } catch {
    return parseReport('', project, exitedOk)
  }
  return parseReport(text, project, exitedOk)
}

function recordTimes(reports: JsonReport[], save: boolean): void {
  const times = fileTimes(reports)
  const files = Object.entries(times).sort(([, a], [, b]) => b - a)
  if (files.length === 0) return
  if (save)
    writeFileSync(
      timesFile,
      `${JSON.stringify({ at: new Date().toISOString(), files: Object.fromEntries(files) }, null, 2)}\n`,
    )
  console.log(
    save
      ? `\n== Slowest test files (all times in ${path.relative(root, timesFile)})`
      : '\n== Slowest test files',
  )
  for (const [file, ms] of files.slice(0, 10)) {
    console.log(`${(ms / 1000).toFixed(1).padStart(7)} s  ${file}`)
  }
}

export async function runChecks({
  appOnly = false,
  quietWait,
  testsOnly = false,
  files,
}: {
  appOnly?: boolean
  quietWait?: number
  testsOnly?: boolean
  files?: TestFiles
} = {}): Promise<boolean> {
  const measurement = measureCheck(process.env.TED_CHECK_EVIDENCE_DIR, cacheDir)
  let unlock: (() => Promise<void>) | undefined
  let ok = false
  try {
    measurement?.start('lock')
    const count = files === undefined ? smallRunFiles : fileCount(files)
    unlock = await reportedTestLock(count < smallRunFiles ? count : 'check', {
      onWait: (pid) => console.log(waitingMessage(pid)),
    })
    measurement?.end('lock')
    console.log('\n== Install')
    measurement?.start('install')
    // pnpm asks before reinstalling node_modules from scratch, and the run holds the test lock
    // until someone answers; the setting and the closed stdin stop any question.
    const install = ['install', '--frozen-lockfile', '--config.confirm-modules-purge=false']
    const stdio = ['ignore', 'inherit', 'inherit'] as const
    const installed = spawnSync('pnpm', install, { cwd: root, stdio: [...stdio] }).status === 0
    measurement?.end('install')
    if (!installed) {
      console.error('check: Install failed')
      return false
    }
    mkdirSync(cacheDir, { recursive: true })
    if (quietWait !== undefined) await waitForQuiet({ maxWaitMs: quietWait })
    const load = loadPerCore()
    const testGroups = groupsFor(load, files)
    if (busy(load))
      console.log(
        `\n${busyLine(load, groupText(testGroups), groupText(groupsFor(undefined, files)))}`,
      )
    ok = await checkInParallel(
      { appOnly, testsOnly, ...(files !== undefined && { files }) },
      testGroups,
      load,
      measurement,
    )
    return ok
  } finally {
    try {
      measurement?.finish(ok)
    } finally {
      await unlock?.()
    }
  }
}

async function checkInParallel(
  scope: { appOnly: boolean; testsOnly: boolean; files?: TestFiles },
  testGroups: readonly TestGroup[],
  load: number | undefined,
  measurement?: CheckMeasurement,
): Promise<boolean> {
  for (const group of testGroups) {
    rmSync(reportFile(group.project), { force: true })
    rmSync(retryFile(group.project), { force: true })
  }
  const { appOnly, testsOnly, files } = scope
  console.log(`\n== ${testsOnly ? 'Test' : 'Typecheck, Lint and Test'} (${groupText(testGroups)})`)
  const printBlock = (step: Step) => {
    console.log(`\n== ${step.title} ${step.ok ? 'passed' : 'failed'}`)
    if (!step.ok || step.output.trim()) console.log(step.output.trimEnd())
    return step
  }
  const tests = testGroups.map((group) => {
    const tag = `[${group.project}]`
    return run(
      `Test ${group.project}`,
      [
        'exec',
        'vitest',
        'run',
        '--project',
        group.project,
        '--maxWorkers',
        String(group.maxWorkers),
        '--reporter',
        'default',
        '--reporter',
        'json',
        '--reporter',
        path.join(root, 'scripts', 'retry-reporter.ts'),
        '--outputFile.json',
        reportFile(group.project),
        ...(files?.[group.project] ?? (appOnly ? [appTests] : [])),
      ],
      (line) => console.log(`${tag} ${line}`),
      { TED_RETRY_REPORT: retryFile(group.project) },
      measurement,
    )
  })
  const steps = await Promise.all([
    ...tests,
    ...(testsOnly
      ? []
      : [run('Typecheck', ['typecheck']).then(printBlock), run('Lint', ['lint']).then(printBlock)]),
  ])
  const reports = testGroups.map((group, index) =>
    readReport(group.project, steps[index]?.ok === true),
  )
  const retries = testGroups.map((group) => readRetries(group.project))
  for (const [index, step] of steps.slice(0, testGroups.length).entries()) {
    const result = reports[index]
    console.log(`\n== ${step.title} ${result?.ok ? 'passed' : 'failed'}`)
    console.log(summary(step.output))
    for (const name of result ? failedTests(result.report) : []) console.log(`  × ${name}`)
    for (const name of retries[index] ?? []) console.log(`  ↻ passed on retry: ${name}`)
    if (retries[index] === undefined) {
      console.error(
        `  ! ${testGroups[index]?.project}: no retry report, so retried tests are unknown`,
      )
    }
    for (const problem of result?.problems ?? []) console.error(`  ! ${problem}`)
  }
  const failed = steps
    .filter((step, index) => !step.ok || (index < testGroups.length && !reports[index]?.ok))
    .map((step) => step.title)
  try {
    recordTimes(
      reports.map((result) => result.report),
      !appOnly && !testsOnly,
    )
  } catch (error) {
    console.error(`check: Could not save test timings: ${String(error)}`)
    failed.push('Timing reporting')
  }
  try {
    console.log(
      `\n${recordFailureRun(
        failuresFile,
        {
          at: new Date().toISOString(),
          ok: failed.length === 0,
          failures: reports.flatMap((result) => failedTests(result.report)),
          problems: reports.flatMap((result) => result.problems),
          passedOnRetry: retries.flatMap((names) => names ?? []),
          ...(load !== undefined && { load }),
          workers: Object.fromEntries(testGroups.map((g) => [g.project, g.maxWorkers])),
        },
        (message) => console.error(message),
      )}`,
    )
  } catch (error) {
    console.error(`check: Could not save failure history: ${String(error)}`)
    failed.push('Failure reporting')
  }
  if (failed.length > 0) console.error(`\ncheck: ${failed.join(', ')} failed`)
  return failed.length === 0
}

export function runRefusal(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!env.TED_RUN) return undefined
  return 'A Run can’t run pnpm check. It runs every test, takes the whole machine and makes every other Run wait; only the human or a merge runs it. Run pnpm typecheck, pnpm lint and the test files your change touches: pnpm vitest run <files>.'
}

export async function checkAndRecord({
  all = false,
  quietWait,
}: {
  all?: boolean
  quietWait?: number
} = {}): Promise<boolean> {
  const refusal = runRefusal()
  if (refusal) {
    console.error(`check: ${refusal}`)
    return false
  }
  const clean = git('status', '--porcelain') === ''
  const commit = git('rev-parse', 'HEAD')
  const appOnly = !all && onlyAppChanged(changedSinceMain())
  if (appOnly)
    console.log(
      `\n== Only packages/app/src and packages/app/test changed since origin/main: running the tests in ${appTests} alone. pnpm check --all runs every test.`,
    )
  if (!(await runChecks({ appOnly, ...(quietWait !== undefined && { quietWait }) }))) return false
  if (appOnly) {
    console.log(
      '\nThe app’s checks passed. The daemon, CLI, protocol and script tests did not run, so nothing was recorded.',
    )
  } else if (clean && git('status', '--porcelain') === '' && git('rev-parse', 'HEAD') === commit) {
    appendFileSync(checkedFile(), `${commit}\n`)
    console.log(
      `\nAll checks passed on ${commit.slice(0, 7)}. A release of this commit can skip them.`,
    )
  } else {
    console.log(
      '\nAll checks passed, but the working tree had changes or HEAD moved, so nothing was recorded.',
    )
  }
  return true
}

export function affectedRefusal(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!env.TED_RUN) return undefined
  return 'A Run can’t run pnpm check --affected: TED runs it as the Affected tests Check. pnpm check --affected --list prints what it selects without running anything. To look into a failure, run that test file: pnpm vitest run <file>.'
}

export async function checkAffected({
  list = false,
  quietWait,
}: {
  list?: boolean
  quietWait?: number
} = {}): Promise<boolean> {
  const refusal = list ? undefined : affectedRefusal()
  if (refusal) {
    console.error(`check: ${refusal}`)
    return false
  }
  const affected = await import('./affected.ts')
  const base = affected.defaultBranch(root)
  let files: TestFiles | undefined
  try {
    const repo = affected.readRepo(root)
    const selection = affected.affectedTests({
      changed: affected.changedSince(root, base),
      ...repo,
    })
    const chosen = affected.chooseTier(selection, repo.tests.length)
    console.log(`\n${affected.selectionText(selection, chosen, base, repo.electron)}`)
    const sandbox = affected.electronSandbox()
    const leftOut = sandbox && affected.leftOutText(chosen.run, repo.electron, sandbox)
    if (leftOut) console.log(`\n${leftOut}`)
    if (!list) {
      mkdirSync(cacheDir, { recursive: true })
      if (leftOut) writeFileSync(leftOutFile, `${leftOut}\n`)
      else rmSync(leftOutFile, { force: true })
    }
    const run = chosen.run.map((pick) => pick.file)
    files = {
      electron: sandbox ? [] : run.filter((file) => repo.electron.has(file)),
      node: run.filter((file) => !repo.electron.has(file)),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
    console.log(
      `\nAffected tests since ${base}: every test, because the changes can’t be read (${message}).`,
    )
  }
  if (list) return true
  if (files && fileCount(files) === 0) {
    console.log('\nNo affected tests to run.')
    return true
  }
  const ok = await runChecks({
    testsOnly: true,
    ...(files && { files }),
    ...(quietWait !== undefined && { quietWait }),
  })
  if (ok)
    console.log(
      '\nThe affected tests passed. Nothing was recorded: only a full pnpm check records a passing commit.',
    )
  return ok
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const quietWait = quietWaitMs(args)
  const wait = quietWait !== undefined && { quietWait }
  process.exit(
    (
      args.includes('--affected')
        ? await checkAffected({ list: args.includes('--list'), ...wait })
        : await checkAndRecord({ all: args.includes('--all'), ...wait })
    )
      ? 0
      : 1,
  )
}
