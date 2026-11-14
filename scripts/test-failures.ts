import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  type FailureRecord,
  failureLogEnv,
  failureLogPath,
  type Outcome,
  parseFailures,
  type RunRecord,
} from './failure-log.ts'
import { busy, busyAbove } from './machine-load.ts'

export const brokenRunTests = 10

export interface FailureRow {
  name: string
  failed: number
  retried: number
  busy: number
  runs: number
  rate: number
}

export interface FailureReport {
  runs: number
  failedRuns: number
  retriedRuns: number
  excludedRuns: number
  busyRuns: number
  busyFailedRuns: number
  tests: FailureRow[]
  files: FailureRow[]
}

type Counts = Map<string, { file: string; failed: number; retried: number; busy: number }>

function rows(counts: Counts, included: Map<string, number>): FailureRow[] {
  return [...counts]
    .map(([name, { file, failed, retried, busy }]) => {
      const runs = Math.max(included.get(file) ?? 0, failed + retried)
      return { name, failed, retried, busy, runs, rate: (failed + retried) / runs }
    })
    .sort(
      (a, b) =>
        b.failed + b.retried - (a.failed + a.retried) ||
        b.rate - a.rate ||
        (a.name < b.name ? -1 : 1),
    )
}

export function failureReport(records: readonly FailureRecord[], since: number): FailureReport {
  const runs = new Map<string, { run: RunRecord; tests: Map<string, Map<string, Outcome>> }>()
  for (const record of records) {
    if (record.type === 'run' && Date.parse(record.at) >= since)
      runs.set(record.run, { run: record, tests: new Map() })
  }
  for (const record of records) {
    if (record.type !== 'test') continue
    const run = runs.get(record.run)
    if (!run) continue
    const tests = run.tests.get(record.file) ?? new Map<string, Outcome>()
    if (tests.get(record.test) !== 'failed') tests.set(record.test, record.outcome)
    run.tests.set(record.file, tests)
  }
  const report = {
    runs: runs.size,
    failedRuns: 0,
    retriedRuns: 0,
    excludedRuns: 0,
    busyRuns: 0,
    busyFailedRuns: 0,
  }
  const included = new Map<string, number>()
  const tests: Counts = new Map()
  const files: Counts = new Map()
  const count = (
    counts: Counts,
    name: string,
    file: string,
    outcome: Outcome,
    onBusyMachine: boolean,
  ) => {
    const entry = counts.get(name) ?? { file, failed: 0, retried: 0, busy: 0 }
    if (outcome === 'failed') entry.failed++
    else entry.retried++
    if (onBusyMachine) entry.busy++
    counts.set(name, entry)
  }
  for (const { run, tests: byFile } of runs.values()) {
    const outcomes = [...byFile.values()].flatMap((names) => [...names.values()])
    const failed = outcomes.filter((outcome) => outcome === 'failed').length
    const onBusyMachine = busy(run.load)
    if (onBusyMachine) report.busyRuns++
    if (onBusyMachine && failed > 0) report.busyFailedRuns++
    if (failed > 0) report.failedRuns++
    else if (outcomes.length > 0) report.retriedRuns++
    if (failed > brokenRunTests) {
      report.excludedRuns++
      continue
    }
    for (const file of new Set(run.files)) included.set(file, (included.get(file) ?? 0) + 1)
    for (const [file, names] of byFile) {
      for (const [name, outcome] of names)
        count(tests, `${file} > ${name}`, file, outcome, onBusyMachine)
      const anyFailed = [...names.values()].includes('failed')
      count(files, file, file, anyFailed ? 'failed' : 'passed-on-retry', onBusyMachine)
    }
  }
  return { ...report, tests: rows(tests, included), files: rows(files, included) }
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

function table(title: string, all: FailureRow[], limit: number): string[] {
  const lines = [`\n== ${title}`]
  if (all.length === 0) return [...lines, 'None.']
  lines.push(
    `${'failed'.padStart(6)}  ${'retried'.padStart(7)}  ${'busy'.padStart(4)}  ${'runs'.padStart(5)}  ${'rate'.padStart(5)}  name`,
  )
  for (const row of all.slice(0, limit)) {
    const rate = `${Math.round(row.rate * 100)}%`
    lines.push(
      `${String(row.failed).padStart(6)}  ${String(row.retried).padStart(7)}  ${String(row.busy).padStart(4)}  ${String(row.runs).padStart(5)}  ${rate.padStart(5)}  ${row.name}`,
    )
  }
  if (all.length > limit) lines.push(`… and ${all.length - limit} more`)
  return lines
}

export function failureText(report: FailureReport): string {
  const lines = [
    `${plural(report.runs, 'run')}: ${report.failedRuns} with a failed test, ${report.retriedRuns} more with only tests that passed on retry.`,
  ]
  if (report.excludedRuns > 0)
    lines.push(
      `Left out below: ${plural(report.excludedRuns, 'run')} with more than ${brokenRunTests} failed tests, which is usually a broken branch and not an unreliable test.`,
    )
  if (report.busyRuns > 0)
    lines.push(
      `${plural(report.busyRuns, 'run')} started on a busy machine (load per core above ${busyAbove}); ${report.busyFailedRuns} of them had a failed test. A test that fails only there is probably timing out under load: try pnpm flaky <file>.`,
    )
  lines.push(
    'failed: runs where it failed. retried: runs where it failed, then passed on retry. busy: how many of those runs started on a busy machine. runs: runs that included its file. rate: (failed + retried) / runs.',
    ...table('Tests', report.tests, 30),
    ...table('Files', report.files, 20),
  )
  return lines.join('\n')
}

if (import.meta.main) {
  const days = Number(process.argv[2]) || 7
  const file = failureLogPath()
  if (!file) {
    console.log(`Test failures aren’t recorded here: ${failureLogEnv} is off.`)
    process.exit(0)
  }
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    console.log(`No test runs recorded yet in ${file}.`)
    process.exit(0)
  }
  console.log(`Test failures of the last ${days} days, from ${file.replace(homedir(), '~')}`)
  console.log(failureText(failureReport(parseFailures(text), Date.now() - days * 24 * 60 * 60_000)))
}
