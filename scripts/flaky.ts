import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import { heldLockEnv, waitingMessage } from '../packages/daemon/test/support/suite-lock.ts'
import { failedTests, parseReport, parseRetries } from './check.ts'
import { startLoad } from './check-load.ts'
import { failureLogEnv } from './failure-log.ts'
import { loadEnv } from './machine-load.ts'
import { reportedTestLock } from './test-reporting.ts'

const root = path.resolve(import.meta.dirname, '..')
const cacheDir = path.join(root, 'node_modules', '.cache', 'ted-flaky')

export const defaultRuns = 5
export const maxRuns = 50
export const usage =
  'Usage: pnpm flaky <test file> [-t <test name>] [--runs <1–50, default 5>] [--load <busy threads, default one per core>]'

export interface FlakyArgs {
  file: string
  name?: string
  runs: number
  load: number
}

export function flakyArgs(
  args: readonly string[],
  cores: number = availableParallelism(),
): FlakyArgs | string {
  const files: string[] = []
  let name: string | undefined
  let runs = defaultRuns
  let load = cores
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    const [flag, inline] = arg.startsWith('--') ? arg.split(/=(.*)/s) : [arg]
    const value = () => inline ?? args[++index]
    if (flag === '-t' || flag === '--testNamePattern') {
      name = value()
      if (!name) return `${flag} needs a test name.\n${usage}`
    } else if (flag === '--runs' || flag === '--load') {
      const count = Number(value())
      const most = flag === '--runs' ? maxRuns : cores * 4
      const least = flag === '--runs' ? 1 : 0
      if (!Number.isSafeInteger(count) || count < least || count > most)
        return `${flag} needs a whole number from ${least} to ${most}.\n${usage}`
      if (flag === '--runs') runs = count
      else load = count
    } else if (arg.startsWith('-')) {
      return `Unknown option ${arg}.\n${usage}`
    } else files.push(arg)
  }
  if (files.length !== 1) return `Name one test file.\n${usage}`
  return { file: files[0] ?? '', ...(name && { name }), runs, load }
}

export function flakyRefusal(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!env.TED_RUN) return undefined
  return 'A Run can’t run pnpm flaky. It loads every core and takes the whole machine for several test runs, so every other Run’s tests wait or time out; only the human runs it. In Validate, run the test files your change touches once: pnpm vitest run <files>.'
}

export interface FlakyRun {
  ok: boolean
  ms: number
  failures: string[]
  retried: string[]
  problems: string[]
}

export function runResult(
  reportText: string,
  retryText: string | undefined,
  exitedOk: boolean,
  ms: number,
): FlakyRun {
  const parsed = parseReport(reportText, 'flaky', exitedOk)
  const failures = [...new Set(failedTests(parsed.report))]
  const retried = (retryText === undefined ? undefined : parseRetries(retryText)) ?? []
  const problems = [...parsed.problems]
  const ran = (parsed.report.testResults ?? []).some((file) =>
    (file.assertionResults ?? []).some((test) => ['passed', 'failed'].includes(test.status)),
  )
  if (!ran && problems.length === 0) problems.push('flaky: no test ran')
  return {
    ok: parsed.ok && failures.length === 0 && retried.length === 0 && problems.length === 0,
    ms,
    failures,
    retried,
    problems,
  }
}

const runsText = (count: number) => `${count} run${count === 1 ? '' : 's'}`

export function flakySummary(results: readonly FlakyRun[], planned: number, load: number): string {
  const passed = results.filter((run) => run.ok).length
  const lines = [
    `\n${passed} of ${runsText(results.length)} passed with ${load} busy thread${load === 1 ? '' : 's'} beside the tests.`,
  ]
  if (results.length < planned)
    lines.push(`Stopped early: ${planned - results.length} of ${runsText(planned)} did not happen.`)
  const counted = (pick: (run: FlakyRun) => string[]) => {
    const counts = new Map<string, number>()
    for (const run of results)
      for (const name of new Set(pick(run))) counts.set(name, (counts.get(name) ?? 0) + 1)
    return [...counts]
      .sort(([a, ac], [b, bc]) => bc - ac || (a < b ? -1 : 1))
      .map(([name, count]) => `  ${count} of ${runsText(results.length)}  ${name}`)
  }
  const failed = counted((run) => run.failures)
  const retried = counted((run) => run.retried)
  const problems = counted((run) => run.problems)
  if (failed.length > 0) lines.push('Tests that failed:', ...failed)
  if (retried.length > 0) lines.push('Tests that failed, then passed on retry:', ...retried)
  if (problems.length > 0) lines.push('Runs that broke without naming a test:', ...problems)
  return lines.join('\n')
}

function read(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

export async function flaky(args: FlakyArgs): Promise<boolean> {
  const folder = path.join(cacheDir, new Date().toISOString().replaceAll(':', '-'))
  let child: ChildProcess | undefined
  let interrupted = false
  const interrupt = () => {
    interrupted = true
    child?.kill('SIGTERM')
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  const results: FlakyRun[] = []
  let unlock: (() => Promise<void>) | undefined
  let load: Awaited<ReturnType<typeof startLoad>> | undefined
  try {
    unlock = await reportedTestLock('check', {
      onWait: (pid) => console.log(waitingMessage(pid)),
    })
    if (interrupted) return false
    mkdirSync(folder, { recursive: true })
    if (args.load > 0) load = await startLoad(args.load)
    load?.failed.catch((error) => {
      console.error(`flaky: The CPU load stopped: ${String(error)}`)
      interrupt()
    })
    console.log(
      `Running ${args.file}${args.name ? ` -t ${JSON.stringify(args.name)}` : ''} ${args.runs} time${args.runs === 1 ? '' : 's'} with ${args.load} busy thread${args.load === 1 ? '' : 's'}. Output of each run: ${path.relative(root, folder)}`,
    )
    for (let index = 1; index <= args.runs && !interrupted; index++) {
      const report = path.join(folder, `run-${index}.json`)
      const retries = path.join(folder, `run-${index}-retries.json`)
      const started = Date.now()
      let output = ''
      const code = await new Promise<number | null>((resolve) => {
        child = spawn(
          'pnpm',
          [
            'exec',
            'vitest',
            'run',
            args.file,
            ...(args.name ? ['-t', args.name] : []),
            '--retry',
            '0',
            '--reporter',
            'default',
            '--reporter',
            'json',
            '--reporter',
            path.join(root, 'scripts', 'retry-reporter.ts'),
            '--outputFile.json',
            report,
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              [heldLockEnv]: String(process.pid),
              [failureLogEnv]: 'off',
              [loadEnv]: 'off',
              TED_RETRY_REPORT: retries,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        const take = (chunk: Buffer) => {
          output += chunk.toString()
        }
        child.stdout?.on('data', take)
        child.stderr?.on('data', take)
        child.on('error', (error) => {
          output += String(error)
          resolve(null)
        })
        child.on('close', resolve)
      })
      child = undefined
      writeFileSync(path.join(folder, `run-${index}.log`), output)
      if (interrupted) break
      const result = runResult(read(report) ?? '', read(retries), code === 0, Date.now() - started)
      results.push(result)
      console.log(
        `Run ${index} of ${args.runs}: ${result.ok ? 'passed' : 'FAILED'} in ${(result.ms / 1000).toFixed(1)} s`,
      )
      for (const name of result.failures) console.log(`  × ${name}`)
      for (const name of result.retried) console.log(`  ↻ passed on retry: ${name}`)
      for (const problem of result.problems) console.log(`  ! ${problem}`)
    }
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    try {
      await load?.stop()
    } finally {
      await unlock?.()
    }
  }
  console.log(flakySummary(results, args.runs, args.load))
  if (interrupted) console.error('flaky: Interrupted.')
  return !interrupted && results.length === args.runs && results.every((run) => run.ok)
}

if (import.meta.main) {
  const refusal = flakyRefusal()
  const args = refusal ? undefined : flakyArgs(process.argv.slice(2))
  if (refusal || typeof args === 'string' || !args) {
    console.error(refusal ? `flaky: ${refusal}` : args)
    process.exit(2)
  }
  const file = path.resolve(args.file)
  if (!existsSync(file) || !statSync(file).isFile() || !/\.test\.tsx?$/.test(file)) {
    console.error(`flaky: ${args.file} is not a test file.\n${usage}`)
    process.exit(2)
  }
  process.exit((await flaky({ ...args, file: path.relative(root, file) })) ? 0 : 1)
}
