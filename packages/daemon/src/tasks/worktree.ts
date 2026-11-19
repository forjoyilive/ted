import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, glob, lstat, mkdir, open, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { CopySkip, NetworkLevel, WorktreeCommandOutcome } from '@ted/protocol'
import { workCommand } from '../priority.ts'
import { redactSecrets } from '../redact.ts'
import type { RepoSettings } from '../workflow/check.ts'
import type { ResolvedWorkflow } from '../workflow/resolve.ts'

export interface WorktreeCommand {
  run: string
  timeoutMs: number
}

export interface RepoWorktree {
  name: string
  baseBranch: string
  setup?: WorktreeCommand
  teardown?: WorktreeCommand
  env: Record<string, string>
  copy: string[]
  network?: NetworkLevel
}

export interface CopyResult {
  copied: string[]
  skipped: CopySkip[]
}

export interface CommandResult {
  outcome: WorktreeCommandOutcome | 'interrupted'
  exitCode?: number
  signal?: NodeJS.Signals
  problem?: string
}

const defaultTimeoutMs = 15 * 60_000
const killGraceMs = 5_000
const outputTailBytes = 16 * 1024

export function primaryRepoWorktree(
  workflow: ResolvedWorkflow,
  factory: { name: string; defaultBranch: string; repos?: readonly { name: string }[] },
): RepoWorktree {
  const repo = workflow.settings.repos?.[0]
  return {
    name: repo?.name ?? factory.repos?.[0]?.name ?? factory.name,
    baseBranch: repo?.base_branch ?? factory.defaultBranch,
    ...worktreeCommands(repo?.worktree),
  }
}

export function worktreeCommands(
  worktree: RepoSettings['worktree'],
): Pick<RepoWorktree, 'setup' | 'teardown' | 'env' | 'copy' | 'network'> {
  const command = (c: { run: string; timeout?: string } | undefined) =>
    c && { run: c.run, timeoutMs: c.timeout ? durationMs(c.timeout) : defaultTimeoutMs }
  const setup = command(worktree?.setup)
  const teardown = command(worktree?.teardown)
  return {
    ...(setup && { setup }),
    ...(teardown && { teardown }),
    env: worktree?.env ?? {},
    copy: worktree?.copy ?? [],
    ...(worktree?.network !== undefined && { network: worktree.network }),
  }
}

export function durationMs(text: string): number {
  const amount = Number.parseInt(text, 10)
  const unit = text.at(-1)
  return amount * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000)
}

export async function copyFiles(
  localFolder: string | undefined,
  worktree: string,
  patterns: string[],
): Promise<CopyResult> {
  const result: CopyResult = { copied: [], skipped: [] }
  if (patterns.length === 0) return result
  if (localFolder === undefined) {
    result.skipped.push(...patterns.map((p) => ({ path: p, reason: 'no-local-folder' as const })))
    return result
  }
  const source = await realpath(localFolder).catch(() => undefined)
  if (source === undefined || !(await stat(source)).isDirectory()) {
    result.skipped.push(
      ...patterns.map((p) => ({ path: p, reason: 'local-folder-missing' as const })),
    )
    return result
  }
  const target = await realpath(worktree)
  for (const pattern of patterns) {
    if (path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) {
      result.skipped.push({ path: pattern, reason: 'outside' })
      continue
    }
    const matches: string[] = []
    for await (const match of glob(pattern, { cwd: source })) matches.push(match)
    if (matches.length === 0) result.skipped.push({ path: pattern, reason: 'missing' })
    for (const match of matches.sort()) {
      const skip = await copyOne(source, target, match)
      if (skip) result.skipped.push({ path: match, reason: skip })
      else result.copied.push(match)
    }
  }
  return result
}

async function copyOne(
  source: string,
  target: string,
  file: string,
): Promise<CopySkip['reason'] | undefined> {
  const from = await realpath(path.join(source, file)).catch(() => undefined)
  if (from === undefined) return 'missing'
  if (!inside(source, from)) return 'outside'
  if (!(await stat(from)).isFile()) return 'not-a-file'
  const to = path.join(target, file)
  if (!inside(target, to) || !(await makePlainFolders(target, path.dirname(to)))) return 'outside'
  const existing = await lstat(to).catch(() => undefined)
  if (existing && !existing.isFile()) return 'outside'
  await copyFile(from, to, existing ? 0 : constants.COPYFILE_EXCL)
  return undefined
}

async function makePlainFolders(root: string, folder: string): Promise<boolean> {
  let current = root
  for (const part of path
    .relative(root, folder)
    .split(path.sep)
    .filter((p) => p !== '')) {
    current = path.join(current, part)
    const found = await lstat(current).catch(() => undefined)
    if (!found) await mkdir(current)
    else if (!found.isDirectory()) return false
  }
  return true
}

function inside(folder: string, file: string): boolean {
  const relative = path.relative(folder, file)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export async function runWorktreeCommand(input: {
  command: WorktreeCommand
  cwd: string
  env: NodeJS.ProcessEnv
  log: string
  signal?: AbortSignal
  shell?: [string, ...string[]]
  fds?: readonly number[]
  onSpawn?: (pid: number | undefined) => void
  lowPriority: boolean
}): Promise<CommandResult> {
  await mkdir(path.dirname(input.log), { recursive: true, mode: 0o700 })
  const log = await open(input.log, 'w', 0o600)
  try {
    const [shell, ...flags] = input.shell ?? ['/bin/sh', '-c']
    const { command, args } = workCommand(shell, [...flags, input.command.run], input.lowPriority)
    const child = spawn(command, args, {
      cwd: input.cwd,
      env: input.env,
      detached: true,
      stdio: ['ignore', log.fd, log.fd, ...(input.fds ?? [])],
    })
    input.onSpawn?.(child.pid)
    let reason: 'timed-out' | 'interrupted' | undefined
    const kill = (why: 'timed-out' | 'interrupted') => {
      reason ??= why
      killGroup(child.pid, 'SIGTERM')
      setTimeout(() => killGroup(child.pid, 'SIGKILL'), killGraceMs).unref()
    }
    const timer = setTimeout(() => kill('timed-out'), input.command.timeoutMs)
    const onAbort = () => kill('interrupted')
    input.signal?.addEventListener('abort', onAbort)
    if (input.signal?.aborted) onAbort()
    const { code, signal } = await new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
    }>((resolve) => {
      child.once('error', () => resolve({ code: null, signal: null }))
      child.once('exit', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }))
    })
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', onAbort)
    if (reason) {
      killGroup(child.pid, 'SIGKILL')
      return { outcome: reason }
    }
    if (code === 0) return { outcome: 'passed', exitCode: 0 }
    return {
      outcome: 'failed',
      ...(code !== null && { exitCode: code }),
      ...(signal !== null && { signal }),
    }
  } finally {
    await log.close()
  }
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  try {
    if (pid !== undefined) process.kill(-pid, signal)
  } catch {}
}

export async function outputTail(log: string): Promise<string> {
  const text = await readFile(log).catch(() => Buffer.alloc(0))
  const tail = text.subarray(Math.max(0, text.length - outputTailBytes)).toString('utf8')
  return redactSecrets(text.length > outputTailBytes ? `…${tail}` : tail)
}
