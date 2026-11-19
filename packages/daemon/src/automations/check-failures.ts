import type { AutomationCheckState } from '@ted/protocol'
import { redactSecrets } from '../redact.ts'

export const maxTasksPerFiring = 10
export const maxFailingFiles = 200
export const sandboxSkippedMarker = 'TED_SANDBOX_SKIPPED:'
const maxSkippedNotes = 5
const maxNoteLength = 300

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')
const failLine =
  /^\s*(?:FAIL|×|✗)\s+(?:\|[^|\s]+\|\s+)?([^\s>[\]()]+\.(?:test|spec)\.[cm]?[jt]sx?)(?=\s|$)/
const safePath = /^[A-Za-z0-9_@./-]+$/

export interface CheckFailurePlan {
  key: string
  title: string
  files: string[]
}

export function failingTestFiles(output: string): string[] {
  const found = new Set<string>()
  for (const line of output.replace(ansi, '').split('\n')) {
    const file = failLine.exec(line)?.[1]
    if (file !== undefined && safePath.test(file) && !file.includes('..')) found.add(file)
  }
  return [...found].sort().slice(0, maxFailingFiles)
}

const errorLine =
  /\b(?:error|fatal)\b|\berr!|\bERR_[A-Z_]+|\bE(?:PERM|ACCES|NOENT|NOSPC|EXIST|BUSY)\b/i
const logPathLine = /complete log of this run can be found in/i
const emptyErrorLine = /^(?:npm )?(?:error|err!)$/i

export function setupErrorSummary(output: string, max = 300): string {
  const lines = output
    .replace(ansi, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !logPathLine.test(l))
  const isError = (l: string) => errorLine.test(l)
  const last = lines.findLastIndex(isError)
  let picked: string[]
  if (last === -1) {
    picked = lines.slice(-1)
  } else {
    let first = last
    while (first > 0 && isError(lines[first - 1] ?? '')) first--
    picked = lines.slice(first, last + 1).filter((l) => !emptyErrorLine.test(l))
  }
  const text = picked.join(' · ')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function sandboxSkipped(output: string): string[] {
  const found = new Set<string>()
  for (const line of output.replace(ansi, '').split('\n')) {
    const at = line.indexOf(sandboxSkippedMarker)
    if (at === -1) continue
    const note = redactSecrets(line.slice(at + sandboxSkippedMarker.length).trim()).slice(
      0,
      maxNoteLength,
    )
    if (note !== '') found.add(note)
    if (found.size >= maxSkippedNotes) break
  }
  return [...found]
}

export function planCheckFailures(name: string, failing: readonly string[]): CheckFailurePlan[] {
  if (failing.length === 0 || failing.length > maxTasksPerFiring) {
    return [
      {
        key: 'check',
        title: `Fix the scheduled check “${name}”`,
        files: [...failing],
      },
    ]
  }
  return failing.map((file) => ({
    key: `file:${file}`,
    title: `Fix failing tests in ${file}`,
    files: [file],
  }))
}

const stateText: Record<AutomationCheckState, string> = {
  passed: 'passed',
  failed: 'failed',
  'timed-out': 'timed out',
  'setup-failed': 'couldn’t set up its worktree',
}

function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  return '`'.repeat(Math.max(3, longest + 1))
}

export function checkFailureText(input: {
  name: string
  command: string
  state: AutomationCheckState
  exitCode?: number
  commit?: string
  plan: CheckFailurePlan
  failing: readonly string[]
  tail: string
  log: string
  at: string
}): string {
  const how = `${stateText[input.state]}${input.exitCode !== undefined && input.state === 'failed' ? ` with exit code ${input.exitCode}` : ''}`
  const files =
    input.plan.files.length > 0
      ? input.plan.files
      : input.failing.length > 0
        ? input.failing
        : undefined
  return redactSecrets(
    [
      `The scheduled check “${input.name}” ${how} at ${input.at}${input.commit ? ` on commit ${input.commit.slice(0, 12)} of the default branch` : ' on the default branch'}.`,
      `Its command: \`${input.command}\``,
      ...(files ? [`Failing test files:\n${files.map((f) => `- ${f}`).join('\n')}`] : []),
      `Last lines of its output:\n\n${fenceFor(input.tail)}\n${input.tail.trimEnd()}\n${fenceFor(input.tail)}`,
      `Full output: ${input.log}`,
    ].join('\n\n'),
  )
}
