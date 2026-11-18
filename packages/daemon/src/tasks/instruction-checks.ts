import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SubAgentWait } from '@ted/protocol'
import * as git from '../git.ts'
import { redactSecrets } from '../redact.ts'
import type { PlannedCheck, StoredTask, TedStore } from '../store/index.ts'
import { oneLine, reviewCommand } from './review-rounds.ts'
import type { ReviewerChoice, SubAgents } from './sub-agents.ts'
import { durationMs } from './worktree.ts'

export interface InstructionRepo {
  name: string
  worktree: string
  baseBranch: string
}

export type InstructionCheck = PlannedCheck & { instruction: string }

export type InstructionOutcome =
  | { kind: 'finished'; state: 'passed' | 'failed'; durationMs: number; changed: boolean }
  | { kind: 'missing'; reason: string; durationMs: number; changed: boolean }
  | { kind: 'interrupted' }

interface RepoState {
  name: string
  head: string
  tree: string
  mergeBase: string
  uncommitted: string[]
}

export const resultLine = /^\s*\**\s*Result:\s*(pass|fail)\s*\**\s*\.?\s*$/i

export function reportResult(message: string): 'passed' | 'failed' | undefined {
  const last = message
    .trimEnd()
    .split('\n')
    .findLast((line) => line.trim() !== '')
  const match = last === undefined ? null : resultLine.exec(last)
  if (!match) return undefined
  return match[1]?.toLowerCase() === 'pass' ? 'passed' : 'failed'
}

export function instructionCheckPrompt(input: {
  name: string
  instruction: string
  displayId: string
  title: string
  repos: readonly { name: string; mergeBase: string; folder?: string }[]
  fix: boolean
}): string {
  const fence = `<<<INSTRUCTION ${randomUUID()}>>>`
  const repos = input.repos.map((repo) => {
    const where = repo.folder === undefined ? '' : ` in the \`${repo.folder}\` folder`
    return `- ${repo.name}${where}: \`${reviewCommand('diff', `${repo.mergeBase} HEAD`)}\``
  })
  const may = input.fix
    ? [
        'You may fix what you find. Edit files and commit each fix in the repo it belongs to. Don’t push, don’t rebase, and don’t amend or rewrite commits that were there before you started.',
        'Commit everything you change: Ted fails this check if you leave uncommitted changes. Ted lists your commits in the report.',
        'Pass when everything you found is fixed. Fail when you found something you couldn’t fix, and say what is left.',
      ]
    : [
        'Only read and report. Don’t edit, create or delete files, don’t commit, and don’t run commands that change the worktree. Ted compares the worktree before and after: any change fails this check.',
        'Pass when the instruction finds nothing wrong. Fail when it finds a problem, and say what it is.',
      ]
  return [
    `# Instruction check: ${oneLine(input.name)}`,
    `Ted is running the Factory’s instruction check “${oneLine(input.name)}” on Task ${input.displayId}: ${oneLine(input.title)}. Ted started you for this check alone. You aren’t the Task Lead, and nobody answers questions while you work.`,
    [
      '## The Task’s changes',
      'Each repo’s changes are its diff from the merge-base with its base branch to `HEAD`:',
      ...repos,
    ].join('\n'),
    ['## What you may do', ...may].join('\n\n'),
    [
      '## The instruction',
      `The Factory wrote this instruction. It sits between the two ${fence} lines. Carry it out as the check to run.`,
      `${fence}\n${input.instruction.trim()}\n${fence}`,
    ].join('\n\n'),
    [
      '## Your report',
      'Your final message is the report. Say what you checked and what you found, naming files and lines.',
      'End it with a line that is exactly `Result: pass` or `Result: fail`. A report without that line counts as no report.',
    ].join('\n\n'),
  ].join('\n\n')
}

export function changeKeyOf(
  check: Pick<PlannedCheck, 'instruction' | 'fix' | 'agent' | 'model' | 'effort'>,
  patches: readonly { name: string; patchId: string }[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        repos: [...patches].sort((a, b) => a.name.localeCompare(b.name)),
        instruction: check.instruction,
        fix: check.fix === true,
        agent: check.agent ?? null,
        model: check.model ?? null,
        effort: check.effort ?? null,
      }),
    )
    .digest('hex')
}

async function repoState(repo: InstructionRepo): Promise<RepoState> {
  const changes = await git.workingChanges(repo.worktree, `origin/${repo.baseBranch}`)
  return {
    name: repo.name,
    head: changes.head,
    tree: changes.tree,
    mergeBase: changes.mergeBase,
    uncommitted: changes.files.filter((f) => f.uncommitted).map((f) => f.path),
  }
}

export async function changeKey(
  repos: readonly InstructionRepo[],
  check: Pick<PlannedCheck, 'instruction' | 'fix' | 'agent' | 'model' | 'effort'>,
): Promise<string | undefined> {
  try {
    const patches = []
    for (const repo of repos) {
      const state = await repoState(repo)
      if (state.uncommitted.length > 0) return undefined
      patches.push({
        name: repo.name,
        patchId: await git.patchId(repo.worktree, state.mergeBase, state.head),
      })
    }
    return changeKeyOf(check, patches)
  } catch {
    return undefined
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i])
}

export interface InstructionCheckDeps {
  store: Pick<TedStore, 'getRun' | 'subscribe'>
  subAgents: Pick<SubAgents, 'requestForCheck' | 'result' | 'cancelForCheck'>
  choose(task: StoredTask, check: InstructionCheck): Promise<ReviewerChoice>
}

export function createInstructionChecks(deps: InstructionCheckDeps) {
  const { store, subAgents } = deps

  function started(runId: string, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const settle = (value: boolean) => {
        unsubscribe()
        signal.removeEventListener('abort', aborted)
        resolve(value)
      }
      const aborted = () => settle(false)
      const unsubscribe = store.subscribe((event) => {
        if (event.type === 'run-updated' && event.run.id === runId) settle(true)
      })
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) settle(false)
      else if (store.getRun(runId) !== undefined) settle(true)
    })
  }

  async function awaitReport(
    runId: string,
    timeout: string,
    signal: AbortSignal,
  ): Promise<{ result?: SubAgentWait; timedOut: boolean; interrupted: boolean }> {
    const queued = new AbortController()
    const resulting = subAgents.result(runId)
    void resulting.then(() => queued.abort())
    const running = await started(runId, AbortSignal.any([signal, queued.signal]))
    if (signal.aborted) return { timedOut: false, interrupted: true }
    if (!running) return { result: await resulting, timedOut: false, interrupted: false }
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), durationMs(timeout))
    })
    const stopped = new Promise<'stopped'>((resolve) => {
      if (signal.aborted) resolve('stopped')
      else signal.addEventListener('abort', () => resolve('stopped'), { once: true })
    })
    try {
      const first = await Promise.race([resulting, late, stopped])
      if (first === 'late') return { timedOut: true, interrupted: false }
      if (first === 'stopped') return { timedOut: false, interrupted: true }
      return { result: first, timedOut: false, interrupted: false }
    } finally {
      clearTimeout(timer)
    }
  }

  async function run(input: {
    task: StoredTask
    check: InstructionCheck
    repos: readonly InstructionRepo[]
    folders: boolean
    mayFix: boolean
    log: string
    signal: AbortSignal
    runNow?: boolean
    onRun?: (runId: string) => void
  }): Promise<InstructionOutcome> {
    const { task, check, repos, mayFix, log, signal } = input
    const begun = Date.now()
    const elapsed = () => Date.now() - begun
    const before = await Promise.all(repos.map(repoState))
    const prompt = instructionCheckPrompt({
      name: check.name,
      instruction: check.instruction,
      displayId: task.displayId,
      title: task.title,
      repos: before.map((state, i) => ({
        name: state.name,
        mergeBase: state.mergeBase,
        ...(input.folders && { folder: path.basename(repos[i]?.worktree ?? '') }),
      })),
      fix: mayFix,
    })
    const runId = subAgents.requestForCheck(task, {
      name: `Check · ${check.name}`.slice(0, 60),
      prompt,
      choice: await deps.choose(task, check),
      ...(input.runNow === true && { runNow: true }),
    })
    if (runId === undefined) {
      await writeReport(
        log,
        'Ted couldn’t start an agent for this check: the Task has no Task Lead Run.',
      )
      return {
        kind: 'missing',
        reason: 'Ted couldn’t start its agent',
        durationMs: elapsed(),
        changed: false,
      }
    }
    input.onRun?.(runId)
    const waited = await awaitReport(runId, check.timeout, signal)
    await subAgents.cancelForCheck(runId).catch(() => undefined)
    if (waited.interrupted) return { kind: 'interrupted' }
    const after = await Promise.all(repos.map(repoState))
    const changed = after.some(
      (state, i) => state.head !== before[i]?.head || state.tree !== before[i]?.tree,
    )
    const message = waited.result?.message?.trim() ?? ''
    const ended =
      waited.result === undefined ||
      waited.result.error !== undefined ||
      waited.result.state === 'stopped' ||
      waited.result.state === 'failed'
    const result = waited.timedOut || ended ? undefined : reportResult(message)
    const commits: string[] = []
    if (mayFix) {
      for (const [i, state] of after.entries()) {
        const old = before[i]
        if (!old || old.head === state.head) continue
        const lines = await git.commitSubjects(repos[i]?.worktree ?? '', old.head, state.head)
        commits.push(...lines.map((line) => `- ${state.name}: ${oneLine(line)}`))
      }
    }
    const leftUncommitted = after.some((state, i) => {
      const old = before[i]
      if (!old) return false
      return (
        (state.uncommitted.length > 0 && !sameList(state.uncommitted, old.uncommitted)) ||
        (state.head === old.head && state.tree !== old.tree)
      )
    })
    const notes = [
      ...(commits.length > 0 ? [`The agent committed:\n${commits.join('\n')}`] : []),
      ...(!mayFix && changed ? ['The agent changed files.'] : []),
      ...(mayFix && leftUncommitted ? ['The agent left uncommitted changes.'] : []),
    ]
    const missing = waited.timedOut
      ? `timed out after ${check.timeout}`
      : ended
        ? 'its Run failed or was stopped before it reported'
        : result === undefined
          ? 'it ended without a result line'
          : undefined
    await writeReport(
      log,
      [
        ...notes,
        ...(missing === undefined ? [] : [`No report: ${missing}.`]),
        message === '' ? '(The agent sent no final message.)' : message,
      ].join('\n\n'),
    )
    if (missing !== undefined)
      return { kind: 'missing', reason: missing, durationMs: elapsed(), changed }
    const failed = result === 'failed' || (!mayFix && changed) || (mayFix && leftUncommitted)
    return {
      kind: 'finished',
      state: failed ? 'failed' : 'passed',
      durationMs: elapsed(),
      changed,
    }
  }

  return { run }
}

async function writeReport(log: string, text: string): Promise<void> {
  await mkdir(path.dirname(log), { recursive: true, mode: 0o700 })
  await writeFile(log, `${redactSecrets(text).trimEnd()}\n`, { mode: 0o600 })
}
