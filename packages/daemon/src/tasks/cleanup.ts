import type { CleanupStepReport } from '@ted/protocol'
import { isCleanup, mergesHere } from '@ted/protocol/stage'
import { type CleanupCommandStep, type CleanupStep, isCommandStep } from '../workflow/check.ts'
import type { ResolvedWorkflow } from '../workflow/resolve.ts'

export const cleanupNoBack =
  'Cleanup can’t send a Task back: its pull requests have merged. Say what more the code needs in a note; the user can make a Follow-up Task.'

export const cleanupCommandReportRefusal = (step: string): string =>
  `“${step}” is a command step: Ted runs it and records its result. Say what you found about it in your note.`

export const cleanupRestartNote =
  'Ted restarted before it recorded the result of every Cleanup command, so it ran those commands again.'

export const cleanupDoneRefusal = (displayId: string): string =>
  `${displayId}’s pull requests have already merged and its Cleanup is running; it moves to Done when Cleanup ends`

export function cleanupFailureBody(
  failed: readonly { step: CleanupStep; report: CleanupStepReport | undefined }[],
): string {
  const lines = failed.map(({ step, report }) => {
    const what = report?.text.trim() ?? ''
    return `- **${step.name}**${what === '' ? '' : `: ${what.replace(/\s*\n\s*/g, ' ')}`}`
  })
  return [
    `The pull requests have merged. ${failed.length === 1 ? 'This Cleanup step' : 'These Cleanup steps'} failed:`,
    lines.join('\n'),
    'You can ask the Task Lead about it here and fix the step in `.ted/workflow.yaml`. **Try again** reruns only the failed steps, with their current instructions. **Finish anyway** moves the Task to Done and notes what didn’t happen. The worktree and Apps stay until then.',
  ].join('\n\n')
}

export function cleanupMoveTarget<T extends string>(
  from: string,
  to: T,
  stages: readonly string[],
): { next: T | 'merge' | 'cleanup'; why?: 'merge-off' | 'cleanup' } {
  if (mergesHere(from) && (to === 'done' || isCleanup(to)) && stages.some(isCleanup))
    return { next: 'cleanup', why: 'cleanup' }
  if (
    !mergesHere(from) &&
    !isCleanup(from) &&
    (isCleanup(to) || (to === 'done' && !stages.some(mergesHere)))
  )
    return { next: 'merge', why: 'merge-off' }
  return { next: to }
}

export function entersMerge(from: string, to: string, stages: readonly string[]): boolean {
  return !mergesHere(from) && mergesHere(cleanupMoveTarget(from, to, stages).next)
}

export function cleanupSteps(workflow: ResolvedWorkflow): CleanupStep[] {
  return workflow.settings.stages.cleanup?.steps ?? []
}

export interface CleanupStatus {
  reports: ReadonlyMap<string, CleanupStepReport>
  reported: CleanupStep[]
  missing: CleanupStep[]
  pendingCommands: CleanupCommandStep[]
  unreported: CleanupStep[]
  failed: CleanupStep[]
  failedCommands: CleanupCommandStep[]
  left: 'nothing' | 'lead'
}

export function cleanupStatus(
  steps: readonly CleanupStep[],
  reports: readonly CleanupStepReport[],
  failureOpen = false,
): CleanupStatus {
  const results = new Map(reports.map((r) => [r.step, r]))
  const missing = steps.filter((step) => !results.has(step.name))
  const failed = steps.filter((step) => results.get(step.name)?.result === 'failed')
  const unreported = missing.filter((step) => !isCommandStep(step))
  const failedCommands = failed.filter(isCommandStep)
  return {
    reports: results,
    reported: steps.filter((step) => results.has(step.name)),
    missing,
    pendingCommands: missing.filter(isCommandStep),
    unreported,
    failed,
    failedCommands,
    left: failedCommands.length > 0 || unreported.length > 0 || failureOpen ? 'lead' : 'nothing',
  }
}

export function cleanupProgress(
  steps: readonly CleanupStep[],
  reports: readonly CleanupStepReport[],
): string | undefined {
  const status = cleanupStatus(steps, reports)
  if (status.reported.length === 0) return undefined
  const line = (step: CleanupStep) => {
    const report = status.reports.get(step.name)
    return isCommandStep(step)
      ? `- “${step.name}” (a command): ${report?.text ?? ''}`
      : `- “${step.name}”: ${report?.result ?? ''}`
  }
  return [
    '# Cleanup so far',
    `These Cleanup steps already have a result. Don’t do them again:\n${status.reported.map(line).join('\n')}`,
    ...(status.failedCommands.length > 0
      ? [
          'A failed command counts as a failed step. Find out why it failed (you may run it again by hand in the worktree) and say what you found in your note; don’t report it with `ted cleanup report`.',
        ]
      : []),
    status.unreported.length > 0
      ? `Do only these, then report each: ${status.unreported.map((step) => `“${step.name}”`).join(', ')}.`
      : 'Every step has a result. Post your note and run `ted outcome advance`.',
  ].join('\n\n')
}
