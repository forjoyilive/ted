import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { type RunKind, smallRunFiles } from '../packages/daemon/test/support/suite-lock.ts'

export const failureLogEnv = 'TED_TEST_FAILURES_FILE'
export const failureLogFile = path.join(homedir(), '.cache', 'ted', 'test-failures.jsonl')
export const keepDays = 90
export const fileFailure = '(the file or a hook failed)'

const dayMs = 24 * 60 * 60_000
const root = path.resolve(import.meta.dirname, '..')

export type Outcome = 'failed' | 'passed-on-retry'

export interface RunRecord {
  at: string
  type: 'run'
  run: string
  kind: RunKind
  checkout: string
  task?: string
  files: string[]
}

export interface TestRecord {
  at: string
  type: 'test'
  run: string
  file: string
  test: string
  outcome: Outcome
}

export type FailureRecord = RunRecord | TestRecord

export interface ObservedTest {
  file: string
  test: string
  outcome: Outcome
}

interface ObservedModule {
  moduleId: string
  state(): string
  children: {
    allTests(): Iterable<{
      fullName: string
      result(): { state: string }
      diagnostic(): { flaky: boolean } | undefined
    }>
  }
}

export function failureLogPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[failureLogEnv]
  if (value === 'off') return undefined
  return value || failureLogFile
}

export function observed(
  modules: readonly ObservedModule[],
  checkout: string,
): { files: string[]; tests: ObservedTest[] } {
  const files = new Set<string>()
  const tests: ObservedTest[] = []
  for (const module of modules) {
    const state = module.state()
    if (state !== 'passed' && state !== 'failed') continue
    const file = path.relative(checkout, module.moduleId).split(path.sep).join('/')
    files.add(file)
    let failed = false
    for (const test of module.children.allTests()) {
      if (test.result().state === 'failed') {
        failed = true
        tests.push({ file, test: test.fullName, outcome: 'failed' })
      } else if (test.diagnostic()?.flaky) {
        tests.push({ file, test: test.fullName, outcome: 'passed-on-retry' })
      }
    }
    if (state === 'failed' && !failed) tests.push({ file, test: fileFailure, outcome: 'failed' })
  }
  return { files: [...files], tests }
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function parseRecord(line: string): FailureRecord | undefined {
  try {
    const value = JSON.parse(line)
    if (typeof value?.at !== 'string' || !Number.isFinite(Date.parse(value.at))) return undefined
    if (typeof value.run !== 'string') return undefined
    if (value.type === 'run' && strings(value.files)) return value
    if (
      value.type === 'test' &&
      typeof value.file === 'string' &&
      typeof value.test === 'string' &&
      (value.outcome === 'failed' || value.outcome === 'passed-on-retry')
    )
      return value
  } catch {}
  return undefined
}

export function parseFailures(text: string): FailureRecord[] {
  const records: FailureRecord[] = []
  for (const line of text.split('\n')) {
    const record = parseRecord(line)
    if (record) records.push(record)
  }
  return records
}

function firstTime(file: string): number {
  const handle = openSync(file, 'r')
  try {
    const head = Buffer.alloc(64)
    const read = readSync(handle, head, 0, head.length, 0)
    return Date.parse(/^\{"at":"([^"]+)"/.exec(head.toString('utf8', 0, read))?.[1] ?? '')
  } finally {
    closeSync(handle)
  }
}

// Runs when the first line is a day past the limit, so about once a day. The file is renamed
// before it is read, so a line another run appends meanwhile lands in a new file and is kept.
export function pruneFailureLog(file: string, now: number = Date.now()): void {
  const cutoff = now - keepDays * dayMs
  const first = firstTime(file)
  if (first >= cutoff - dayMs) return
  const aside = `${file}.${randomUUID()}.old`
  renameSync(file, aside)
  try {
    const kept = readFileSync(aside, 'utf8')
      .split('\n')
      .filter((line) => Date.parse(parseRecord(line)?.at ?? '') >= cutoff)
    if (kept.length > 0) appendFileSync(file, kept.map((line) => `${line}\n`).join(''))
  } catch (error) {
    if (!existsSync(file)) renameSync(aside, file)
    throw error
  }
  rmSync(aside, { force: true })
}

export function recordRun(
  file: string,
  run: { checkout: string; planned: number; task?: string; files: string[]; tests: ObservedTest[] },
  now: number = Date.now(),
): void {
  if (run.files.length === 0) return
  try {
    const id = randomUUID()
    const at = new Date(now).toISOString()
    const records: FailureRecord[] = [
      {
        at,
        type: 'run',
        run: id,
        kind: Math.max(run.planned, run.files.length) >= smallRunFiles ? 'full' : 'small',
        checkout: run.checkout,
        ...(run.task && { task: run.task }),
        files: run.files,
      },
      ...run.tests.map((test) => ({ at, type: 'test' as const, run: id, ...test })),
    ]
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, records.map((record) => `${JSON.stringify(record)}\n`).join(''))
    pruneFailureLog(file, now)
  } catch {}
}

const recordedKey = Symbol.for('ted.vitest.failures-recorded')

declare global {
  namespace NodeJS {
    interface Process {
      [recordedKey]?: boolean
    }
  }
}

export function recordVitestRun(vitest: {
  state: { getPaths(): string[]; getTestModules(): ObservedModule[] }
}): void {
  try {
    const file = failureLogPath()
    if (!file || process[recordedKey]) return
    process[recordedKey] = true
    recordRun(file, {
      checkout: root,
      planned: vitest.state.getPaths().length,
      ...(process.env.TED_TASK && { task: process.env.TED_TASK }),
      ...observed(vitest.state.getTestModules(), root),
    })
  } catch {}
}
