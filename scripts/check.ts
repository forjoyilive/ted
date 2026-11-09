import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import {
  acquireSuiteLock,
  heldLockEnv,
  waitingMessage,
} from '../packages/daemon/test/support/suite-lock.ts'

const root = path.resolve(import.meta.dirname, '..')
const cacheDir = path.join(root, 'node_modules', '.cache')
export const timesFile = path.join(cacheDir, 'ted-test-times.json')

const testGroups = [
  { project: 'electron', maxWorkers: 4 },
  { project: 'node', maxWorkers: 8 },
]

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

type Step = { title: string; ok: boolean; output: string }

function run(title: string, args: string[], onLine?: (line: string) => void): Promise<Step> {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
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

function readReport(project: string): JsonReport {
  try {
    return JSON.parse(readFileSync(reportFile(project), 'utf8')) as JsonReport
  } catch {
    return {}
  }
}

function recordTimes(): void {
  const times = fileTimes(testGroups.map((group) => readReport(group.project)))
  const files = Object.entries(times).sort(([, a], [, b]) => b - a)
  if (files.length === 0) return
  writeFileSync(
    timesFile,
    `${JSON.stringify({ at: new Date().toISOString(), files: Object.fromEntries(files) }, null, 2)}\n`,
  )
  console.log(`\n== Slowest test files (all times in ${path.relative(root, timesFile)})`)
  for (const [file, ms] of files.slice(0, 10)) {
    console.log(`${(ms / 1000).toFixed(1).padStart(7)} s  ${file}`)
  }
}

export async function runChecks(): Promise<boolean> {
  console.log('\n== Install')
  if (spawnSync('pnpm', ['install', '--frozen-lockfile'], { cwd: root, stdio: 'inherit' }).status) {
    console.error('check: Install failed')
    return false
  }
  mkdirSync(cacheDir, { recursive: true })
  const unlock = await acquireSuiteLock({ onWait: (pid) => console.log(waitingMessage(pid)) })
  try {
    return await checkInParallel()
  } finally {
    await unlock()
  }
}

async function checkInParallel(): Promise<boolean> {
  for (const group of testGroups) rmSync(reportFile(group.project), { force: true })
  console.log(
    `\n== Typecheck, Lint and Test (${testGroups.map((g) => `${g.project} ×${g.maxWorkers}`).join(', ')})`,
  )
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
        '--outputFile.json',
        reportFile(group.project),
      ],
      (line) => console.log(`${tag} ${line}`),
    )
  })
  const steps = await Promise.all([
    run('Typecheck', ['typecheck']).then(printBlock),
    run('Lint', ['lint']).then(printBlock),
    ...tests,
  ])
  for (const [index, step] of steps.slice(2).entries()) {
    console.log(`\n== ${step.title} ${step.ok ? 'passed' : 'failed'}`)
    console.log(summary(step.output))
    const group = testGroups[index]
    for (const name of group ? failedTests(readReport(group.project)) : [])
      console.log(`  × ${name}`)
  }
  recordTimes()
  const failed = steps.filter((step) => !step.ok).map((step) => step.title)
  if (failed.length > 0) console.error(`\ncheck: ${failed.join(', ')} failed`)
  return failed.length === 0
}

export async function checkAndRecord(): Promise<boolean> {
  const clean = git('status', '--porcelain') === ''
  const commit = git('rev-parse', 'HEAD')
  if (!(await runChecks())) return false
  if (clean && git('status', '--porcelain') === '' && git('rev-parse', 'HEAD') === commit) {
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

if (import.meta.main) process.exit((await checkAndRecord()) ? 0 : 1)
