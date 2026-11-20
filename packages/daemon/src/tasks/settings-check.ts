import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { WorkflowProblem } from '@ted/protocol'
import { type Fail, isObject, isString, parseJson, reader, type Untyped } from '@ted/protocol/parse'
import { plural } from '../text.ts'
import { checkWorkflowPath } from '../workflow/check-path.ts'
import { readLayerDirectory } from '../workflow/layers.ts'
import type { CommandResult } from './worktree.ts'

export const settingsCheckEntry = 'packages/daemon/src/workflow/check-entry.ts'

export interface SettingsProblem extends WorkflowProblem {
  path: string
}

export type RunBranchChecker = (command: string) => Promise<CommandResult>

export interface SettingsCheckResult {
  outcome: 'passed' | 'failed' | 'interrupted'
  exitCode?: number
}

class BadResult extends Error {}

export function parseSettingsResult(value: Untyped): SettingsProblem[] {
  const fail: Fail = (message) => {
    throw new BadResult(message)
  }
  const read = reader(fail)
  const result = read.object(value, 'result')
  return read.list(result, 'problems').map((item, i) => {
    const p = read.object(item, `problems[${i}]`)
    return {
      severity: read.oneOf(p, 'severity', ['error', 'warning'] as const),
      file: read.string(p, 'file'),
      line: read.integer(p, 'line'),
      column: read.integer(p, 'column'),
      message: read.string(p, 'message'),
      path: read.string(p, 'path'),
    }
  })
}

export async function isTedSource(worktree: string): Promise<boolean> {
  const manifest = await readFile(path.join(worktree, 'package.json'), 'utf8').catch(() => '')
  const parsed = parseJson(manifest)
  if (!isObject(parsed) || !isString(parsed.name) || parsed.name !== 'ted') return false
  return readFile(path.join(worktree, settingsCheckEntry)).then(
    () => true,
    () => false,
  )
}

export async function checkSettings(input: {
  worktree: string
  log: string
  libraryDir: string
  runBranchChecker?: RunBranchChecker
}): Promise<SettingsCheckResult> {
  const { worktree, log, libraryDir } = input
  const lines: string[] = []
  const installed = await checkWorkflowPath(path.join(worktree, '.ted'), { libraryDir }).then(
    (problems) => ({ problems }),
    (error: Error) => ({ error: error.message }),
  )
  const branch =
    input.runBranchChecker && (await isTedSource(worktree))
      ? await runBranch(worktree, libraryDir, log, input.runBranchChecker)
      : undefined
  if (branch?.kind === 'interrupted') return { outcome: 'interrupted' }

  let errors: number
  if (branch?.kind === 'checked') {
    lines.push('Checked with this branch’s own Ted settings checker.')
    errors = describe(branch.problems, worktree, lines)
    const missed =
      'problems' in installed ? installed.problems.filter((p) => p.severity === 'error') : []
    if (errors === 0 && (missed.length > 0 || 'error' in installed)) {
      lines.push(
        '',
        'The installed Ted can’t read these settings yet. Until the new build is installed, the Factory uses its last valid settings:',
      )
      if ('error' in installed) lines.push(`warning: ${installed.error}`)
      for (const p of missed) lines.push(`${location(p, worktree)}: warning: ${p.message}`)
    }
  } else {
    if (branch?.kind === 'unavailable') {
      lines.push(
        `This branch’s own Ted settings checker gave no result (${branch.reason}), so the installed checker was used.`,
        ...branch.output,
        '',
      )
    }
    if ('error' in installed) {
      errors = 1
      lines.push(installed.error)
    } else errors = describe(installed.problems, worktree, lines)
  }
  await mkdir(path.dirname(log), { recursive: true, mode: 0o700 })
  await writeFile(log, `${lines.join('\n')}\n`, { mode: 0o600 })
  return errors > 0 ? { outcome: 'failed', exitCode: 1 } : { outcome: 'passed', exitCode: 0 }
}

function location(p: SettingsProblem, worktree: string): string {
  return `${path.relative(worktree, p.path)}:${p.line}:${p.column}`
}

function describe(problems: readonly SettingsProblem[], worktree: string, lines: string[]): number {
  for (const p of problems) lines.push(`${location(p, worktree)}: ${p.severity}: ${p.message}`)
  const errors = problems.filter((p) => p.severity === 'error').length
  const warnings = problems.length - errors
  lines.push(
    problems.length === 0
      ? 'No problems in .ted'
      : [errors > 0 && plural(errors, 'error'), warnings > 0 && plural(warnings, 'warning')]
          .filter(Boolean)
          .join(', '),
  )
  return errors
}

const outputLines = 20

type BranchOutcome =
  | { kind: 'checked'; problems: SettingsProblem[] }
  | { kind: 'unavailable'; reason: string; output: string[] }
  | { kind: 'interrupted' }

async function runBranch(
  worktree: string,
  libraryDir: string,
  log: string,
  run: RunBranchChecker,
): Promise<BranchOutcome> {
  const cache = path.join(worktree, 'node_modules', '.cache')
  await mkdir(cache, { recursive: true })
  const scratch = await mkdtemp(path.join(cache, 'ted-settings-'))
  try {
    const library = path.join(scratch, 'library')
    await copyLayer(libraryDir, library)
    const out = path.join(scratch, 'result.json')
    const rel = (file: string) => path.relative(worktree, file)
    const command = `node ${settingsCheckEntry} --target .ted --library ${rel(library)} --out ${rel(out)}`
    const result = await run(command)
    if (result.outcome === 'interrupted') return { kind: 'interrupted' }
    const output = async () => {
      const text = await readFile(log, 'utf8').catch(() => '')
      return text.trimEnd().split('\n').filter(Boolean).slice(-outputLines)
    }
    const text = await readFile(out, 'utf8').catch(() => undefined)
    if (text === undefined) {
      const reason =
        result.problem ??
        (result.exitCode !== undefined
          ? `it exited with code ${result.exitCode}`
          : 'no result file')
      return { kind: 'unavailable', reason, output: await output() }
    }
    try {
      const problems = parseSettingsResult(parseJson(text))
      return {
        kind: 'checked',
        problems: problems.map((p) => ({ ...p, path: path.join(worktree, p.path) })),
      }
    } catch (error) {
      const reason =
        error instanceof BadResult
          ? `its result wasn’t readable: ${error.message}`
          : 'its result wasn’t readable'
      return { kind: 'unavailable', reason, output: [] }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function copyLayer(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true, mode: 0o700 })
  const files = (await readLayerDirectory(from).catch(() => undefined)) ?? {}
  for (const [name, text] of Object.entries(files)) {
    if (text === null) continue
    const file = path.join(to, name)
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, text, { mode: 0o600 })
  }
}
