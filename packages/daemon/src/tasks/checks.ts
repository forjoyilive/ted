import { mkdir, open, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type CheckResult,
  type CheckState,
  checkFailed,
  checkLabel,
  defaultInstructionCheckTimeout,
  type SandboxGroup,
} from '@ted/protocol'
import { loginShell, worktreeCommandEnv } from '../command-env.ts'
import { type MemoryWatch, memoryKill } from '../memory-kills.ts'
import { redactSecrets } from '../redact.ts'
import type { PlannedCheck } from '../store/index.ts'
import { plural } from '../text.ts'
import { type CheckSettings, isInstructionCheck } from '../workflow/check.ts'
import { checkWorkflowPath } from '../workflow/check-path.ts'
import { checkCpusEnv } from './check-slots.ts'
import { type CommandLaunch, runTaskCommand } from './command.ts'
import { durationMs } from './worktree.ts'
import { readChanges, type WorktreeReads } from './worktree-reads.ts'

export const defaultCheckTimeout = '10m'
export const tedSettingsCheck = 'Ted settings'
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
  groups?: readonly SandboxGroup[]
}

export interface CheckRunnerResult {
  outcome: 'passed' | 'failed' | 'interrupted' | 'memory' | 'no-report'
  failed?: { position: number; check: PlannedCheck; state: CheckState; exitCode?: number }
  killed?: { position: number; check: PlannedCheck; lowestMemory: number; durationMs: number }
  missing?: { position: number; check: PlannedCheck; reason: string; durationMs: number }
  notFound: string[]
}

export type InstructionStep =
  | { kind: 'finished'; state: 'passed' | 'failed'; durationMs: number }
  | { kind: 'missing'; reason: string; durationMs: number }
  | { kind: 'interrupted' }

export const notRerunNote = 'not rerun: the Task’s changes are the same as when it passed'

export function isInstructionPlanned(
  check: PlannedCheck,
): check is PlannedCheck & { instruction: string } {
  return check.instruction !== undefined
}

export function touchesSettings(files: readonly string[] | undefined): boolean {
  return files?.some((f) => f.startsWith('.ted/')) === true
}

export async function planChecks(input: {
  checks: readonly CheckSettings[]
  repos: readonly CheckRepo[]
  primary: string
  only?: string
  reads?: WorktreeReads
  commandsOnly?: boolean
  changeKey?: (check: PlannedCheck) => Promise<string | undefined>
  passedKey?: (name: string) => string | undefined
}): Promise<RunnableCheck[]> {
  const changes = new Map<string, string[] | undefined>()
  for (const repo of input.repos) {
    changes.set(
      repo.name,
      await readChanges(input.reads, repo.worktree, `origin/${repo.baseBranch}`).then(
        (changes) => changes.files.map((f) => f.path),
        () => undefined,
      ),
    )
  }
  const changed = (name: string) => {
    if (!input.repos.some((r) => r.name === name)) return false
    const files = changes.get(name)
    return files === undefined || files.length > 0
  }
  const primary = input.repos.find((r) => r.name === input.primary)
  const wanted = input.checks.filter((c) => input.only === undefined || c.name === input.only)
  const commands: RunnableCheck[] = []
  const fixing: RunnableCheck[] = []
  const reporting: RunnableCheck[] = []
  for (const settings of wanted) {
    if (isInstructionCheck(settings)) {
      if (input.commandsOnly) continue
      const check: PlannedCheck = {
        name: settings.name,
        instruction: settings.instruction,
        ...(settings.fix === true && { fix: true }),
        ...(settings.agent !== undefined && { agent: settings.agent }),
        ...(settings.model !== undefined && { model: settings.model }),
        ...(settings.effort !== undefined && { effort: settings.effort }),
        timeout: settings.timeout ?? defaultInstructionCheckTimeout,
        state: primary && input.repos.some((r) => changed(r.name)) ? 'waiting' : 'skipped',
      }
      const passed = check.state === 'waiting' ? input.passedKey?.(check.name) : undefined
      const key = passed === undefined ? undefined : await input.changeKey?.(check)
      if (passed !== undefined && key === passed) {
        check.state = 'passed'
        check.notRerun = true
      }
      ;(settings.fix === true ? fixing : reporting).push(
        check.state === 'skipped' || !primary ? { check } : { check, cwd: primary.worktree },
      )
      continue
    }
    const name = settings.repo ?? input.primary
    const repo = input.repos.find((r) => r.name === name)
    const check: PlannedCheck = {
      name: settings.name,
      ...(settings.repo !== undefined && { repo: settings.repo }),
      command: settings.run,
      timeout: settings.timeout ?? defaultCheckTimeout,
      state: repo && changed(name) ? 'waiting' : 'skipped',
    }
    commands.push(
      check.state === 'skipped' || !repo
        ? { check }
        : {
            check,
            cwd: repo.worktree,
            env: repo.env,
            ...(settings.sandbox_access !== undefined && { groups: settings.sandbox_access }),
          },
    )
  }
  if (
    primary &&
    touchesSettings(changes.get(input.primary)) &&
    (input.only === undefined || input.only === tedSettingsCheck)
  ) {
    commands.push({
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
  return [...fixing, ...commands, ...reporting]
}

export function supportsTestReporting(command: string): boolean {
  const words = command.trim().split(/[ \t]+/)
  if (!words.every((word) => /^[A-Za-z0-9_./:@=+-]+$/.test(word))) return false
  if (words.shift() !== 'pnpm') return false
  const exec = words[0] === 'exec'
  if (exec) words.shift()
  return (!exec && words[0] === 'check') || (words[0] === 'vitest' && words[1] === 'run')
}

export async function runChecks(input: {
  checks: readonly RunnableCheck[]
  taskDisplayId?: string
  libraryDir: string
  env: NodeJS.ProcessEnv
  logFor: (position: number) => string
  prepareLaunch: () => Promise<CommandLaunch>
  signal?: AbortSignal
  lowPriority: boolean
  cpus?: () => number
  memory?: MemoryWatch
  from?: number
  to?: number
  onInterrupted?: (position: number) => void
  reportingEnv?: (position: number, supported: boolean) => Promise<Record<string, string>>
  beforeCommand?: () => Promise<boolean>
  beforeInstruction?: () => void
  runInstruction?: (
    position: number,
    check: PlannedCheck & { instruction: string },
  ) => Promise<InstructionStep>
  onStart: (position: number) => void
  onFinish: (
    position: number,
    result: { state: CheckState; exitCode?: number; durationMs: number },
  ) => void
}): Promise<CheckRunnerResult> {
  const notFound: string[] = []
  for (const [position, { check, cwd, env, groups }] of input.checks.entries()) {
    if (position < (input.from ?? 0)) continue
    if (input.to !== undefined && position >= input.to) break
    if (check.state === 'skipped' || check.notRerun || cwd === undefined) continue
    if (input.signal?.aborted) return { outcome: 'interrupted', notFound }
    if (isInstructionPlanned(check)) {
      if (!input.runInstruction) continue
      input.beforeInstruction?.()
      input.onStart(position)
      const step = await input.runInstruction(position, check)
      if (step.kind === 'interrupted') {
        input.onInterrupted?.(position)
        return { outcome: 'interrupted', notFound }
      }
      if (step.kind === 'missing') {
        return {
          outcome: 'no-report',
          missing: { position, check, reason: step.reason, durationMs: step.durationMs },
          notFound,
        }
      }
      const finished = { state: step.state, durationMs: step.durationMs }
      input.onFinish(position, finished)
      if (checkFailed(step.state))
        return { outcome: 'failed', failed: { position, check, ...finished }, notFound }
      continue
    }
    const command = check.command ?? ''
    if (input.beforeCommand && !(await input.beforeCommand()))
      return { outcome: 'interrupted', notFound }
    input.onStart(position)
    const started = Date.now()
    const log = input.logFor(position)
    const reporting =
      (await input.reportingEnv?.(position, supportsTestReporting(command)).catch(() => ({}))) ?? {}
    const watching = check.builtIn === 'ted-settings' ? undefined : input.memory?.watch()
    const ran =
      check.builtIn === 'ted-settings'
        ? checkSettings(cwd, log, input.libraryDir)
        : runTaskCommand({
            label: 'this check',
            owner: `the Check “${check.name}”`,
            command: { run: command, timeoutMs: durationMs(check.timeout) },
            cwd,
            env: {
              ...checkEnv(input.taskDisplayId, env ?? {}, input.env),
              ...(input.cpus && checkCpusEnv(input.cpus())),
              ...reporting,
            },
            log,
            shell: [loginShell(input.env), '-lc'],
            lowPriority: input.lowPriority,
            ...(input.signal !== undefined && { signal: input.signal }),
            prepareLaunch: input.prepareLaunch,
            ...(groups !== undefined && { groups }),
            root: {
              kind: 'check',
              ...(input.taskDisplayId !== undefined && { task: input.taskDisplayId }),
            },
          })
    const result = await ran.finally(() => watching?.finish())
    const lowestMemory = await watching?.finish()
    if (result.outcome === 'interrupted') {
      input.onInterrupted?.(position)
      return { outcome: 'interrupted', notFound }
    }
    if (
      result.outcome === 'failed' &&
      lowestMemory !== undefined &&
      memoryKill(
        { signal: 'signal' in result ? result.signal : undefined, exitCode: result.exitCode },
        lowestMemory,
      )
    ) {
      return {
        outcome: 'memory',
        killed: { position, check, lowestMemory, durationMs: Date.now() - started },
        notFound,
      }
    }
    const state: CheckState = result.outcome
    const finished = {
      state,
      ...(result.exitCode !== undefined && { exitCode: result.exitCode }),
      durationMs: Date.now() - started,
    }
    input.onFinish(position, finished)
    if (result.exitCode === 127) notFound.push(command)
    if (checkFailed(state)) {
      return { outcome: 'failed', failed: { position, check, ...finished }, notFound }
    }
  }
  return { outcome: 'passed', notFound }
}

export function checkEnv(
  taskDisplayId: string | undefined,
  repoEnv: Record<string, string>,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return worktreeCommandEnv(
    repoEnv,
    { CI: '1', ...(taskDisplayId !== undefined && { TED_TASK: taskDisplayId }) },
    base,
  )
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
  check: Pick<
    CheckResult,
    'name' | 'repo' | 'state' | 'exitCode' | 'timeout' | 'instruction' | 'notRerun' | 'noReport'
  >,
): string {
  const label = check.instruction === undefined ? checkLabel(check) : `${check.name} (instruction)`
  switch (check.state) {
    case 'passed':
      return `✓ ${label}${check.notRerun ? ` · ${notRerunNote}` : ''}`
    case 'failed':
      if (check.noReport !== undefined) return `✗ ${label} · no report: ${check.noReport}`
      return `✗ ${label}${check.exitCode === 127 ? ' · command not found' : check.exitCode !== undefined ? ` · exit code ${check.exitCode}` : ''}`
    case 'timed-out':
      return `✗ ${label} · timed out after ${check.timeout}`
    case 'skipped':
      return `– ${label} · skipped, no changes`
    case 'not-run':
      return `– ${label} · not run`
    case 'running':
      return `… ${label} · running`
    case 'out-of-memory':
      return `! ${label} · stopped: out of memory`
    default:
      return `– ${label} · waiting`
  }
}

export function summary(checks: readonly CheckResult[]): string {
  return checks.map(describeResult).join('\n')
}

export function failureFindings(input: {
  check: Pick<
    CheckResult,
    'name' | 'repo' | 'command' | 'state' | 'exitCode' | 'timeout' | 'instruction' | 'noReport'
  >
  output: string
  log: string
  checks: readonly CheckResult[]
}): string {
  const { check } = input
  if (check.instruction !== undefined) {
    return redactSecrets(
      [
        `1. The instruction check “${check.name}” failed${check.noReport !== undefined ? ` with no report (${check.noReport}), and the human counted it as failed` : ''}.`,
        `Its instruction, from the Factory:\n\n\`\`\`\n${check.instruction.trim()}\n\`\`\``,
        `Checks:\n${summary(input.checks)}`,
        'The agent’s report:',
        `\`\`\`\n${input.output.trimEnd()}\n\`\`\``,
        `Full report: ${input.log}`,
      ].join('\n\n'),
    )
  }
  const how =
    check.state === 'timed-out'
      ? `timed out after ${check.timeout}`
      : check.exitCode === 127
        ? 'failed with exit code 127: its command wasn’t found'
        : `failed${check.exitCode !== undefined ? ` with exit code ${check.exitCode}` : ''}`
  return redactSecrets(
    [
      `1. The check “${checkLabel(check)}” ${how}.`,
      `Its command: \`${check.command}\``,
      `Checks:\n${summary(input.checks)}`,
      `Last ${findingsLines} lines of its output:`,
      `\`\`\`\n${input.output.trimEnd()}\n\`\`\``,
      `Full output: ${input.log}`,
    ].join('\n\n'),
  )
}
