import type { Comment, Task } from '@ted/protocol'

export function ordinaryAutopilotRequest(comment: Comment): boolean {
  if (
    comment.answer ||
    comment.talk ||
    comment.permission ||
    comment.simulator ||
    comment.linearTeam ||
    comment.sizeCheck ||
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
