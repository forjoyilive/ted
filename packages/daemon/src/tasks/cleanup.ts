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
