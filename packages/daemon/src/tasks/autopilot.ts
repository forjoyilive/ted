import { type Comment, isTrackerGroupAsk, type MachineSettings, type Task } from '@ted/protocol'

export function ordinaryAutopilotRequest(comment: Comment): boolean {
  if (
    comment.answer ||
    comment.talk ||
    comment.permission ||
    comment.simulator ||
    isTrackerGroupAsk(comment) ||
    comment.sizeCheck ||
    comment.asanaMissing ||
    comment.asanaUnfinished ||
    comment.move ||
    comment.failed
  )
    return false
  if (comment.archive) return comment.kind === 'question' && comment.author.kind === 'run'
  if (comment.kind === 'round') return comment.purpose?.kind === 'round'
  if (comment.gate) return comment.purpose?.kind === 'gate'
  return (
    comment.kind === 'question' &&
    comment.author.kind === 'run' &&
    comment.purpose?.kind === 'question'
  )
}

export function taskAutopilot(task: Task): boolean {
  return task.autopilot?.enabled === true
}

export function unvettedReason(
  task: { fromAutomation: boolean; source?: Task['source'] },
  settings: Pick<MachineSettings, 'reviewUnvettedTasks'>,
): 'automation' | 'outsider' | undefined {
  if (!settings.reviewUnvettedTasks) return undefined
  if (task.fromAutomation) return 'automation'
  if (task.source?.github?.outsiderText === true) return 'outsider'
  return undefined
}
