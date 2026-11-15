import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { redactSecrets } from '../packages/daemon/src/redact.ts'
import { ExecutionDiagnostics } from '../packages/daemon/test/support/execution-diagnostics.ts'
import {
  type ExecutionScenario,
  executionManifest,
  selectScenarios,
} from '../packages/daemon/test/support/execution-manifest.ts'
import {
  type Candidate,
  candidateIdentity,
  machineIdentity,
  prerequisiteVersions,
  publishReport,
  readObservations,
  readTestReport,
  reportDirectory,
  saveEvidence,
  type ValidationReport,
} from '../packages/daemon/test/support/execution-report.ts'
import { findMarked, killMarked } from '../packages/daemon/test/support/processes.ts'

export interface ScenarioCommand {
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  resultFile: string
  observationsFile: string
}
export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export async function executeScenario(command: ScenarioCommand): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const executable = command.argv[0]
    if (!executable) throw new Error('empty scenario command')
    const child = spawn(executable, command.argv.slice(1), {
      cwd: command.cwd,
      env: command.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const signal = (value: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, value)
        else child.kill(value)
      } catch (error) {
        // macOS answers EPERM, not ESRCH, for a group whose only members are zombies.
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ESRCH' && code !== 'EPERM') throw error
      }
    }
    const stdout = new ExecutionDiagnostics()
    const stderr = new ExecutionDiagnostics()
    let timedOut = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => stdout.push(chunk))
    child.stderr.on('data', (chunk: string) => stderr.push(chunk))
    const timer = setTimeout(() => {
      timedOut = true
      signal('SIGTERM')
    }, command.timeoutMs)
    const force = setTimeout(() => {
      if (timedOut) signal('SIGKILL')
    }, command.timeoutMs + 10_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      clearTimeout(force)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      clearTimeout(force)
      if (timedOut) signal('SIGKILL')
      resolve({
        code: timedOut ? 1 : (code ?? 1),
        stdout: stdout.text,
        stderr: stderr.text + (timedOut ? '\nScenario timed out\n' : ''),
      })
    })
  })
}

function completedTests(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const report = value as {
    success?: boolean
    numFailedTests?: number
    numPassedTests?: number
    numPendingTests?: number
    testResults?: { status?: string; assertionResults?: { status?: string }[] }[]
  }
  return (
    report.success === true &&
    report.numFailedTests === 0 &&
    Number(report.numPassedTests) > 0 &&
    report.numPendingTests === 0 &&
    Array.isArray(report.testResults) &&
    report.testResults.length > 0 &&
    report.testResults.every(
      (file) =>
        file.status === 'passed' &&
        Array.isArray(file.assertionResults) &&
        file.assertionResults.length > 0 &&
        file.assertionResults.every((test) => test.status === 'passed'),
    )
  )
}

async function stopOwnedRuns(runs: string[]) {
  for (const run of runs) {
    await killMarked('TED_TEST_RUN', run)
    if ((await findMarked('TED_TEST_RUN', run)).length)
      throw new Error(`owned scenario processes remain after cleanup: ${run}`)
  }
}

export interface ValidationOptions {
  root: string
  reportDir: string
  scenarios: string[]
  lab?: boolean
}
export interface ValidationDependencies {
  execute?: (command: ScenarioCommand) => Promise<CommandResult>
  candidate?: (root: string) => Promise<Candidate>
  versions?: () => Promise<Record<string, string>>
  cleanup?: (scratch: string) => Promise<void>
  reportDirectory?: typeof reportDirectory
}

export async function runValidation(
  options: ValidationOptions,
  dependencies: ValidationDependencies = {},
) {
  const selected = selectScenarios(options.scenarios)
  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'ted-validation-')))
  const ownedRuns: string[] = []
  const started = Date.now()
  let directory: string
  try {
    directory = await (dependencies.reportDirectory ?? reportDirectory)(
      options.reportDir,
      options.root,
      scratch,
    )
  } catch (error) {
    await rm(scratch, { recursive: true, force: true })
    throw error
  }
  const replay = [
    'node',
    `scripts/validate-execution${options.lab ? '-lab' : ''}.ts`,
    '--report-dir',
    options.reportDir,
    ...(options.lab ? ['--opt-in'] : []),
    ...selected.flatMap((s) => ['--scenario', s.id]),
  ]
  const report: ValidationReport = {
    version: 1,
    manifestVersion: executionManifest.version,
    candidate: null,
    prerequisites: {},
    machine: machineIdentity(),
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    result: 'fail',
    scenarios: [],
    errors: [],
    replay: {
      command: replay,
      candidate: null,
      instruction:
        'Recreate this candidate revision and dirty content identity, install prerequisites, then run the argv above from the repository root. Scratch resources are recreated; no personal home or saved credentials are needed.',
    },
  }
  let publicationError: unknown
  try {
    await publishReport(directory, report)
    report.candidate = await (dependencies.candidate ?? candidateIdentity)(options.root)
    report.replay.candidate = report.candidate
    report.prerequisites = await (dependencies.versions ?? prerequisiteVersions)()
    await publishReport(directory, report)
    for (const scenario of selected) {
      const result = await runScenario(scenario)
      report.scenarios.push(result)
      await publishReport(directory, report)
    }
  } catch (error) {
    report.errors.push(redactSecrets(String(error)))
  } finally {
    try {
      await stopOwnedRuns(ownedRuns)
      await (dependencies.cleanup ?? ((dir) => rm(dir, { recursive: true, force: true })))(scratch)
    } catch (error) {
      report.errors.push(redactSecrets(`cleanup failed: ${error}`))
    }
    report.durationMs = Date.now() - started
    report.result =
      report.errors.length ||
      report.scenarios.length !== selected.length ||
      report.scenarios.some((s) => s.result === 'fail')
        ? 'fail'
        : report.scenarios.every((s) => s.result === 'skipped')
          ? 'skipped'
          : 'pass'
    try {
      await publishReport(directory, report)
    } catch (error) {
      publicationError = error
    }
  }
  if (publicationError)
    throw new Error(redactSecrets(`report publication failed in ${directory}: ${publicationError}`))
  return {
    directory,
    report,
    code: report.result === 'pass' ? 0 : report.result === 'skipped' ? 2 : 1,
  }

  async function runScenario(scenario: ExecutionScenario) {
    const start = Date.now()
    const resultFile = path.join(scratch, `${scenario.id}-vitest.json`)
    const observationsFile = path.join(scratch, `${scenario.id}-observations.jsonl`)
    const argv = [
      'pnpm',
      'vitest',
      'run',
      ...scenario.files,
      '--reporter=json',
      `--outputFile=${resultFile}`,
    ]
    const result: ValidationReport['scenarios'][number] = {
      id: scenario.id,
      evidence: scenario.evidence,
      scope: scenario.scope,
      command: scenario.unavailable ? [] : argv,
      prerequisites: scenario.prerequisites,
      expected: scenario.invariants,
      observed: [],
      result: 'fail',
      durationMs: 0,
      evidencePaths: [],
    }
    if (scenario.unavailable) {
      result.result = 'skipped'
      result.reason = scenario.unavailable
      if (scenario.evidence === 'actual two-Mac execution' && !options.lab)
        result.reason +=
          ' Normal runner never accesses Macs; lab execution requires the separate opt-in runner.'
      return result
    }
    let output: CommandResult | undefined
    let testFailureDetails = 'No readable test report was produced.'
    try {
      await writeFile(observationsFile, '')
      const fixtureRoot = path.join(scratch, `${scenario.id}-fixtures`)
      await mkdir(fixtureRoot)
      const run = randomUUID()
      ownedRuns.push(run)
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        TED_VALIDATION_OBSERVATIONS: observationsFile,
        TED_VALIDATION_DIAGNOSTICS: path.join(scratch, `${scenario.id}-diagnostics.txt`),
        TED_VALIDATION_FIXTURE_ROOT: fixtureRoot,
      }
      for (const name of [
        'TED_RUN',
        'TED_RUN_CAPABILITY',
        'TED_RUN_TOKEN',
        'TED_TASK',
        'TED_PLAN',
        'TED_TEST_SUITE_LOCK_PID',
        'TED_TEST_RUN_ID',
        'TED_TEST_FILE',
        'TED_EXIT_WITH_PID',
      ])
        delete env[name]
      env.TED_TEST_RUN = run
      env.TED_TEST_RUN_ID = run
      output = await (dependencies.execute ?? executeScenario)({
        argv,
        cwd: options.root,
        env,
        timeoutMs: scenario.timeoutMs + 30 * 60_000,
        resultFile,
        observationsFile,
      })
      const { report: testReport, failureDetails } = await readTestReport(resultFile)
      testFailureDetails = failureDetails
      const observations = await readObservations(observationsFile)
      result.observed = observations
      if (output.code !== 0 || !completedTests(testReport))
        throw new Error(`test command failed or incomplete (exit ${output.code})`)
      const missing = scenario.invariants.filter(
        (invariant) => !observations.some((o) => o.invariant === invariant),
      )
      if (missing.length) throw new Error(`missing invariant observations: ${missing.join(', ')}`)
      result.result = 'pass'
    } catch (error) {
      result.reason = redactSecrets(String(error))
      for (const [suffix, text] of [
        ['stdout', output?.stdout ?? ''],
        ['stderr', output?.stderr ?? ''],
        ['failure', result.reason],
        ['tests', testFailureDetails],
        [
          'diagnostics',
          await readFile(path.join(scratch, `${scenario.id}-diagnostics.txt`), 'utf8').catch(
            () => '',
          ),
        ],
      ]) {
        result.evidencePaths.push(
          await saveEvidence(directory, `${scenario.id}-${suffix}.txt`, text ?? ''),
        )
      }
    }
    result.durationMs = Date.now() - start
    return result
  }
}

export async function validationCli(args: string[], lab = false) {
  const { values } = parseArgs({
    args,
    options: {
      scenario: { type: 'string', multiple: true },
      'report-dir': { type: 'string' },
      'opt-in': { type: 'boolean' },
    },
  })
  if (!values['report-dir']) throw new Error('--report-dir is required')
  if (lab && !values['opt-in'])
    throw new Error('lab runs require --opt-in; no machine inventory is read')
  if (!lab && values['opt-in']) throw new Error('use the separate lab runner for --opt-in')
  const result = await runValidation({
    root: fileURLToPath(new URL('..', import.meta.url)),
    reportDir: values['report-dir'],
    scenarios: values.scenario ?? [],
    lab,
  })
  console.log(
    redactSecrets(
      `Validation ${result.report.result}: ${path.join(result.directory, 'summary.md')}`,
    ),
  )
  return result.code
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await validationCli(process.argv.slice(2))
  } catch (error) {
    console.error(redactSecrets(String(error)))
    process.exitCode = 1
  }
}
