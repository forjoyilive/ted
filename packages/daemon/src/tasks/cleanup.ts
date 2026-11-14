import type { CleanupStepReport } from '@ted/protocol'
import type { CleanupStep } from '../workflow/check.ts'

export const cleanupNoBack =
  'Cleanup can’t send a Task back: its pull requests have merged. Say what more the code needs in a note; the user can make a Follow-up Task.'

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
  if (from === 'merge' && (to === 'done' || to === 'cleanup') && stages.includes('cleanup'))
    return { next: 'cleanup', why: 'cleanup' }
  if (
    from !== 'merge' &&
    from !== 'cleanup' &&
    (to === 'cleanup' || (to === 'done' && !stages.includes('merge')))
  )
    return { next: 'merge', why: 'merge-off' }
  return { next: to }
}

export function cleanupProgress(
  steps: readonly CleanupStep[],
  reports: readonly CleanupStepReport[],
): string | undefined {
  const results = new Map(reports.map((r) => [r.step, r.result]))
  const reported = steps.filter((step) => results.has(step.name))
  if (reported.length === 0) return undefined
  const left = steps.filter((step) => !results.has(step.name))
  return [
    '# Cleanup so far',
    `These Cleanup steps already have a result. Don’t do them again:\n${reported.map((step) => `- “${step.name}”: ${results.get(step.name)}`).join('\n')}`,
    left.length > 0
      ? `Do only these, then report each: ${left.map((step) => `“${step.name}”`).join(', ')}.`
      : 'Every step has a result. Post your note and run `ted outcome advance`.',
  ].join('\n\n')
}
