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
        title: `Fix the Scheduled Check “${name}”`,
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
      `The scheduled Check “${input.name}” ${how} at ${input.at}${input.commit ? ` on commit ${input.commit.slice(0, 12)} of the default branch` : ' on the default branch'}.`,
      `Its command: \`${input.command}\``,
      ...(files ? [`Failing test files:\n${files.map((f) => `- ${f}`).join('\n')}`] : []),
      `Last lines of its output:\n\n${fenceFor(input.tail)}\n${input.tail.trimEnd()}\n${fenceFor(input.tail)}`,
      `Full output: ${input.log}`,
    ].join('\n\n'),
  )
}
