import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, cpus, hostname, loadavg, platform, release, totalmem } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadWorkerCount } from './check-load.ts'
import { evidenceFiles } from './check-measurement.ts'

export function assertHuman(env: NodeJS.ProcessEnv) {
  if (
    [
      'TED_RUN',
      'TED_RUN_TOKEN',
      'TED_RUN_CAPABILITY',
      'TED_TASK',
      'TED_PLAN',
      'CODEX_SANDBOX',
    ].some((name) => env[name])
  )
    throw new Error('Full measurements must be launched by the human outside an agent Run.')
}

export function measurementArgs(args: string[]) {
  const [mode, label] = args
  if (
    args.length !== 2 ||
    !['quiet', 'loaded'].includes(mode ?? '') ||
    !/^[a-z0-9][a-z0-9-]*$/.test(label ?? '')
  ) {
    throw new Error('Usage: node scripts/measure-check.ts quiet|loaded <unique-run-label>')
  }
  return { mode: mode as 'quiet' | 'loaded', label: label as string }
}

export async function collect(args: string[]) {
  assertHuman(process.env)
  const { mode, label } = measurementArgs(args)
  const root = path.resolve(import.meta.dirname, '..')
  const git = (...argv: string[]) =>
    execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim()
  if (git('status', '--porcelain')) throw new Error('Commit all changes before measuring.')
  const folder = path.join(root, '.suite-measurements', label)
  mkdirSync(path.dirname(folder), { recursive: true })
  mkdirSync(folder)
  const logicalCpus = cpus().length
  const workers = mode === 'loaded' ? loadWorkerCount(logicalCpus) : 0
  const samples: { at: string; load: number[] }[] = []
  const sample = () => samples.push({ at: new Date().toISOString(), load: loadavg() })
  const startedAt = new Date().toISOString()
  const origin = performance.now()
  const commit = git('rev-parse', 'HEAD')
  const pnpm = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim()
  const log = createWriteStream(path.join(folder, 'console.log'), { flags: 'wx' })
  const workloadCommand = workers
    ? [
        process.execPath,
        fileURLToPath(new URL('./check-load.ts', import.meta.url)),
        String(workers),
      ]
    : null
  let workload: ReturnType<typeof spawn> | undefined
  let check: ReturnType<typeof spawn> | undefined
  let interrupted: string | undefined
  let workloadFailed = false
  let workloadExit: { code: number | null; signal: NodeJS.Signals | null } | undefined
  let checkSignal: NodeJS.Signals | null = null
  let exitCode: number | null = null
  let error: string | undefined
  const stopCheck = () => {
    if (!check?.pid) return
    try {
      process.kill(-check.pid, 'SIGTERM')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  const stop = (signal: string) => {
    interrupted = signal
    stopCheck()
    workload?.kill('SIGTERM')
  }
  const onInt = () => stop('SIGINT')
  const onTerm = () => stop('SIGTERM')
  process.once('SIGINT', onInt)
  process.once('SIGTERM', onTerm)
  sample()
  const timer = setInterval(sample, 1_000)
  try {
    if (workloadCommand) {
      workload = spawn(process.execPath, workloadCommand.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      workload.stderr?.on('data', (chunk) => log.write(chunk))
      workload.once('exit', (code, signal) => {
        workloadExit = { code, signal }
      })
      await new Promise<void>((resolve, reject) => {
        workload?.once('error', reject)
        workload?.once('exit', () => reject(new Error('CPU workload exited before ready')))
        workload?.stdout?.once('data', (chunk: Buffer) => {
          if (chunk.toString().trim() === 'READY') resolve()
          else reject(new Error('Invalid CPU workload readiness response'))
        })
      })
      workload.once('exit', () => {
        workloadFailed = true
        stopCheck()
      })
    }
    if (interrupted) throw new Error(`Interrupted: ${interrupted}`)
    check = spawn('pnpm', ['check'], {
      cwd: root,
      detached: true,
      env: { ...process.env, CI: 'true', TED_CHECK_EVIDENCE_DIR: folder, TED_TEST_LOAD: 'off' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const stream of [check.stdout, check.stderr]) {
      stream?.on('data', (chunk) => {
        log.write(chunk)
        process.stdout.write(chunk)
      })
    }
    exitCode = await new Promise<number | null>((resolve, reject) => {
      check?.once('error', reject)
      check?.once('close', (code, signal) => {
        checkSignal = signal
        resolve(code)
      })
    })
  } catch (thrown) {
    error = String(thrown)
  } finally {
    clearInterval(timer)
    sample()
    const loadWasAlive = !workload || (workload.exitCode === null && workload.signalCode === null)
    const unexpectedWorkloadExit = workloadExit
    workload?.removeAllListeners('exit')
    if (workload?.pid && workload.exitCode === null && workload.signalCode === null) {
      const closed = new Promise<void>((resolve) => workload?.once('close', () => resolve()))
      workload.kill('SIGTERM')
      await closed
    }
    await new Promise<void>((resolve) => log.end(resolve))
    process.removeListener('SIGINT', onInt)
    process.removeListener('SIGTERM', onTerm)
    writeFileSync(
      path.join(folder, 'run.json'),
      `${JSON.stringify(
        {
          mode,
          label,
          commit,
          endCommit: git('rev-parse', 'HEAD'),
          dirtyAtEnd: Boolean(git('status', '--porcelain')),
          startedAt,
          endedAt: new Date().toISOString(),
          collectorMs: performance.now() - origin,
          machine: {
            hostname: hostname(),
            platform: platform(),
            release: release(),
            arch: arch(),
            logicalCpus,
            cpuModel: cpus()[0]?.model,
            memoryBytes: totalmem(),
          },
          node: process.version,
          pnpm,
          command: ['pnpm', 'check'],
          commandEnvironment: { CI: 'true', TED_TEST_LOAD: 'off' },
          workloadCommand,
          workers,
          workloadFailed: workloadFailed || !loadWasAlive,
          unexpectedWorkloadExit,
          checkSignal,
          interrupted,
          error,
          exitCode,
          samples,
        },
        null,
        2,
      )}\n`,
      { flag: 'wx' },
    )
  }
  const result = assessEvidence(folder)
  writeFileSync(path.join(folder, 'assessment.json'), `${JSON.stringify(result, null, 2)}\n`, {
    flag: 'wx',
  })
  console.log(`Evidence: ${folder}`)
  console.log(JSON.stringify(result, null, 2))
  return result.reliablePass ? 0 : 1
}

export function assessEvidence(folder: string) {
  const problems: string[] = []
  let workMs: number | null = null
  try {
    const run = JSON.parse(readFileSync(path.join(folder, 'run.json'), 'utf8'))
    if (run.exitCode !== 0 || run.error || run.interrupted)
      problems.push('Check did not finish successfully')
    if (run.commit !== run.endCommit || run.dirtyAtEnd)
      problems.push('Checkout changed during measurement')
    if (run.workloadFailed) problems.push('CPU workload did not stay alive throughout the Check')
    const measured = JSON.parse(readFileSync(path.join(folder, 'check-measurement.json'), 'utf8'))
    if (!measured.ok || measured.testProcessEnvelopeMs === null)
      problems.push('Check timing is incomplete or failed')
    workMs =
      typeof measured.workMs === 'number' && Number.isFinite(measured.workMs)
        ? measured.workMs
        : null
    if (workMs === null) problems.push('Missing Check work duration')
    for (const file of evidenceFiles) {
      if (!measured.artifacts?.[file]) problems.push(`Missing fresh artifact: ${file}`)
      else {
        const hash = createHash('sha256')
          .update(readFileSync(path.join(folder, file)))
          .digest('hex')
        if (hash !== measured.artifacts[file]) problems.push(`Artifact changed: ${file}`)
      }
    }
    for (const project of ['electron', 'node']) {
      const retries = JSON.parse(
        readFileSync(path.join(folder, `ted-test-retries-${project}.json`), 'utf8'),
      )
      if (!Array.isArray(retries.passedOnRetry)) problems.push(`${project}: invalid retry report`)
      else if (retries.passedOnRetry.length)
        problems.push(`${project}: passed on retry: ${retries.passedOnRetry.join('; ')}`)
    }
  } catch (error) {
    problems.push(`Incomplete evidence: ${String(error)}`)
  }
  return {
    reliablePass: problems.length === 0,
    withinTarget: workMs !== null && workMs <= 180_000,
    workMs,
    problems,
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await collect(process.argv.slice(2))
  } catch (error) {
    console.error(String(error))
    process.exitCode = 1
  }
}
