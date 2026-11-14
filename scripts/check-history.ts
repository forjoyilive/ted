import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

export type FailureRun = {
  at: string
  ok: boolean
  failures: string[]
  problems: string[]
  passedOnRetry?: string[]
  load?: number
  workers?: Record<string, number>
}

type History = { version: 1; runs: FailureRun[] }

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function parseHistory(text: string): FailureRun[] {
  const value: unknown = JSON.parse(text)
  if (
    !object(value) ||
    value.version !== 1 ||
    !Array.isArray(value.runs) ||
    !value.runs.every(
      (run: unknown) =>
        object(run) &&
        typeof run.at === 'string' &&
        Number.isFinite(Date.parse(run.at)) &&
        typeof run.ok === 'boolean' &&
        strings(run.failures) &&
        strings(run.problems) &&
        (run.passedOnRetry === undefined || strings(run.passedOnRetry)),
    )
  ) {
    throw new Error('invalid or unsupported failure history')
  }
  return value.runs.slice(-20)
}

export function appendRun(runs: FailureRun[], run: FailureRun): FailureRun[] {
  const { passedOnRetry, ...rest } = run
  const retried = [...new Set(passedOnRetry ?? [])]
  return [
    ...runs,
    {
      ...rest,
      failures: [...new Set(run.failures)],
      ...(retried.length > 0 && { passedOnRetry: retried }),
    },
  ].slice(-20)
}

function ranked(runs: FailureRun[], pick: (run: FailureRun) => string[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const run of runs) {
    for (const name of new Set(pick(run))) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts].sort(([a, ac], [b, bc]) => bc - ac || (a < b ? -1 : a > b ? 1 : 0))
}

const countLine = ([name, count]: [string, number]) =>
  `  ${count} run${count === 1 ? '' : 's'}  ${name}`

export function failureSummary(runs: FailureRun[]): string {
  const failures = ranked(runs, (run) => run.failures)
  const retried = ranked(runs, (run) => run.passedOnRetry ?? [])
  const incomplete = runs.filter((run) => run.problems.length > 0).length
  const lines = [
    `== Most frequently observed test failures (last ${runs.length} runs; ${incomplete} incomplete)`,
    ...failures.slice(0, 10).map(countLine),
  ]
  if (failures.length === 0) lines.push('  No named test failures recorded.')
  if (incomplete > 0) lines.push('  Incomplete runs may have unreported failures.')
  if (retried.length > 0) {
    lines.push(
      `== Tests that failed, then passed on retry (last ${runs.length} runs)`,
      ...retried.slice(0, 10).map(countLine),
    )
  }
  return lines.join('\n')
}

export function recordFailureRun(
  file: string,
  run: FailureRun,
  warn: (message: string) => void,
): string {
  let runs: FailureRun[] = []
  try {
    runs = parseHistory(readFileSync(file, 'utf8'))
  } catch (error) {
    if (!object(error) || error.code !== 'ENOENT') {
      warn(`check: Could not read failure history; starting fresh: ${String(error)}`)
    }
  }
  runs = appendRun(runs, run)
  const history: History = { version: 1, runs }
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(history, null, 2)}\n`, { flag: 'wx' })
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
  return failureSummary(runs)
}
