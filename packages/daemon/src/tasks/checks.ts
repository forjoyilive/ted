import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { type CheckResult, type CheckState, checkFailed, checkLabel } from '@ted/protocol'
import { loginShell, worktreeCommandEnv } from '../command-env.ts'
import * as git from '../git.ts'
import { redactSecrets } from '../redact.ts'
import { type Sandbox, type SandboxScope, SandboxUnavailable } from '../sandbox.ts'
import type { PlannedCheck } from '../store/index.ts'
import { plural } from '../text.ts'
import type { CheckSettings } from '../workflow/check.ts'
import { checkWorkflowPath } from '../workflow/check-path.ts'
import { type CommandResult, durationMs, runWorktreeCommand } from './worktree.ts'

export const defaultCheckTimeout = '10m'
export const tedSettingsCheck = 'TED settings'
export const findingsLines = 200

export interface CheckRepo {
  name: string
  worktree: string
  baseBranch: string
  env: Record<string, string>
}

export interface RunnableCheck {
  check: PlannedCheck
  cwd?: string
  env?: Record<string, string>
}

export interface CheckRunnerResult {
  outcome: 'passed' | 'failed' | 'interrupted'
  failed?: { position: number; check: PlannedCheck; state: CheckState; exitCode?: number }
  notFound: string[]
}

export async function planChecks(input: {
  checks: readonly CheckSettings[]
  repos: readonly CheckRepo[]
  primary: string
  only?: string
}): Promise<RunnableCheck[]> {
  const changes = new Map<string, string[] | undefined>()
  for (const repo of input.repos) {
    changes.set(
      repo.name,
      await git.changedFiles(repo.worktree, `origin/${repo.baseBranch}`).catch(() => undefined),
    )
  }
  const changed = (name: string) => {
    if (!input.repos.some((r) => r.name === name)) return false
    const files = changes.get(name)
    return files === undefined || files.length > 0
  }
  const planned: RunnableCheck[] = input.checks
    .filter((c) => input.only === undefined || c.name === input.only)
    .map((settings) => {
      const name = settings.repo ?? input.primary
      const repo = input.repos.find((r) => r.name === name)
      const check: PlannedCheck = {
        name: settings.name,
        ...(settings.repo !== undefined && { repo: settings.repo }),
        command: settings.run,
        timeout: settings.timeout ?? defaultCheckTimeout,
        state: repo && changed(name) ? 'waiting' : 'skipped',
      }
      return check.state === 'skipped' || !repo
        ? { check }
        : { check, cwd: repo.worktree, env: repo.env }
    })
  const primary = input.repos.find((r) => r.name === input.primary)
  const touchesSettings = changes.get(input.primary)?.some((f) => f.startsWith('.ted/')) === true
  if (primary && touchesSettings && (input.only === undefined || input.only === tedSettingsCheck)) {
    planned.push({
      check: {
        name: tedSettingsCheck,
        command: 'ted workflow check',
        timeout: defaultCheckTimeout,
        state: 'waiting',
        builtIn: 'ted-settings',
      },
      cwd: primary.worktree,
    })
  }
  return planned
}

export async function runChecks(input: {
  checks: readonly RunnableCheck[]
  taskDisplayId: string
  libraryDir: string
  env: NodeJS.ProcessEnv
  logFor: (position: number) => string
  sandbox?: { sandbox: Sandbox; scope: Omit<SandboxScope, 'tmp'>; tmpRoot: string }
  signal?: AbortSignal
  onStart: (position: number) => void
  onFinish: (
    position: number,
    result: { state: CheckState; exitCode?: number; durationMs: number },
  ) => void
}): Promise<CheckRunnerResult> {
  const notFound: string[] = []
  for (const [position, { check, cwd, env }] of input.checks.entries()) {
    if (check.state === 'skipped' || cwd === undefined) continue
    if (input.signal?.aborted) return { outcome: 'interrupted', notFound }
    input.onStart(position)
    const started = Date.now()
    const log = input.logFor(position)
    const result =
      check.builtIn === 'ted-settings'
        ? await checkSettings(cwd, log, input.libraryDir)
        : await runCheck({
            command: { run: check.command, timeoutMs: durationMs(check.timeout) },
            cwd,
            env: checkEnv(input.taskDisplayId, env ?? {}, input.env),
            log,
            shell: [loginShell(input.env), '-lc'],
            ...(input.signal !== undefined && { signal: input.signal }),
            ...(input.sandbox !== undefined && { sandbox: input.sandbox }),
          })
    if (result.outcome === 'interrupted') return { outcome: 'interrupted', notFound }
    const state: CheckState = result.outcome
    const finished = {
      state,
      ...(result.exitCode !== undefined && { exitCode: result.exitCode }),
      durationMs: Date.now() - started,
    }
    input.onFinish(position, finished)
    if (result.exitCode === 127) notFound.push(check.command)
    if (checkFailed(state)) {
      return { outcome: 'failed', failed: { position, check, ...finished }, notFound }
    }
  }
  return { outcome: 'passed', notFound }
}

async function runCheck(
  input: Parameters<typeof runWorktreeCommand>[0] & {
    shell: [string, ...string[]]
    sandbox?: { sandbox: Sandbox; scope: Omit<SandboxScope, 'tmp'>; tmpRoot: string }
  },
): Promise<CommandResult> {
  const { sandbox, ...command } = input
  if (sandbox === undefined) return runWorktreeCommand(command)
  await mkdir(sandbox.tmpRoot, { recursive: true, mode: 0o700 })
  const tmp = await mkdtemp(path.join(sandbox.tmpRoot, 'tmp-'))
  try {
    const wrapped = await sandbox.sandbox.wrap(input.shell, { ...sandbox.scope, tmp })
    return await runWorktreeCommand({
      ...command,
      shell: wrapped.argv,
      env: { ...command.env, ...wrapped.env },
    })
  } catch (error) {
    if (!(error instanceof SandboxUnavailable)) throw error
    await mkdir(path.dirname(input.log), { recursive: true, mode: 0o700 })
    await writeFile(input.log, `TED didn’t run this Check: ${error.message}\n`, { mode: 0o600 })
    return { outcome: 'failed' }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

export function checkEnv(
  taskDisplayId: string,
  repoEnv: Record<string, string>,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return worktreeCommandEnv(repoEnv, { CI: '1', TED_TASK: taskDisplayId }, base)
}

async function checkSettings(
  worktree: string,
  log: string,
  libraryDir: string,
): Promise<{ outcome: 'passed' | 'failed'; exitCode: number }> {
  const target = path.join(worktree, '.ted')
  const lines: string[] = []
  let errors = 0
  try {
    const problems = await checkWorkflowPath(target, { libraryDir })
    for (const p of problems) {
      lines.push(
        `${path.relative(worktree, p.path)}:${p.line}:${p.column}: ${p.severity}: ${p.message}`,
      )
    }
    errors = problems.filter((p) => p.severity === 'error').length
    const warnings = problems.length - errors
    lines.push(
      problems.length === 0
        ? 'No problems in .ted'
        : [errors > 0 && plural(errors, 'error'), warnings > 0 && plural(warnings, 'warning')]
            .filter(Boolean)
            .join(', '),
    )
  } catch (error) {
    errors = 1
    lines.push(error instanceof Error ? error.message : String(error))
  }
  await mkdir(path.dirname(log), { recursive: true, mode: 0o700 })
  await writeFile(log, `${lines.join('\n')}\n`, { mode: 0o600 })
  return errors > 0 ? { outcome: 'failed', exitCode: 1 } : { outcome: 'passed', exitCode: 0 }
}

async function tailOf(log: string, bytes: number): Promise<{ lines: string[]; cut: boolean }> {
  const file = await open(log, 'r').catch(() => undefined)
  if (!file) return { lines: [], cut: false }
  try {
    const { size } = await file.stat()
    const length = Math.min(size, bytes)
    const buffer = Buffer.alloc(length)
    await file.read(buffer, 0, length, size - length)
    const text = buffer.toString('utf8').replace(/\n$/, '')
    const lines = text === '' ? [] : text.split('\n')
    return size > length ? { lines: lines.slice(1), cut: true } : { lines, cut: false }
  } finally {
    await file.close()
  }
}

export async function lastLines(log: string, count: number = findingsLines): Promise<string> {
  const { lines } = await tailOf(log, 256 * 1024)
  return redactSecrets(lines.slice(-count).join('\n'))
}

export async function readOutput(log: string): Promise<string> {
  const { lines, cut } = await tailOf(log, 4 * 1024 * 1024)
  return redactSecrets([...(cut ? ['…'] : []), ...lines].join('\n'))
}

export function describeResult(
  check: Pick<CheckResult, 'name' | 'repo' | 'state' | 'exitCode' | 'timeout'>,
): string {
  const label = checkLabel(check)
  switch (check.state) {
    case 'passed':
      return `✓ ${label}`
    case 'failed':
      return `✗ ${label}${check.exitCode === 127 ? ' · command not found' : check.exitCode !== undefined ? ` · exit code ${check.exitCode}` : ''}`
    case 'timed-out':
      return `✗ ${label} · timed out after ${check.timeout}`
    case 'skipped':
      return `– ${label} · skipped, no changes`
    case 'not-run':
      return `– ${label} · not run`
    case 'running':
      return `… ${label} · running`
    default:
      return `– ${label} · waiting`
  }
}

export function summary(checks: readonly CheckResult[]): string {
  return checks.map(describeResult).join('\n')
}

export function failureFindings(input: {
  check: Pick<CheckResult, 'name' | 'repo' | 'command' | 'state' | 'exitCode' | 'timeout'>
  output: string
  log: string
  checks: readonly CheckResult[]
}): string {
  const { check } = input
  const how =
    check.state === 'timed-out'
      ? `timed out after ${check.timeout}`
      : check.exitCode === 127
        ? 'failed with exit code 127: its command wasn’t found'
        : `failed${check.exitCode !== undefined ? ` with exit code ${check.exitCode}` : ''}`
  return redactSecrets(
    [
      `1. The Check “${checkLabel(check)}” ${how}.`,
      `Its command: \`${check.command}\``,
      `Checks:\n${summary(input.checks)}`,
      `Last ${findingsLines} lines of its output:`,
      `\`\`\`\n${input.output.trimEnd()}\n\`\`\``,
      `Full output: ${input.log}`,
    ].join('\n\n'),
  )
}
