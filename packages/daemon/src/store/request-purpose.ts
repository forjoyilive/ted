import type { Comment, RequestPurpose } from '@ted/protocol'

export function structuralPurpose(
  comment: Pick<
    Comment,
    | 'kind'
    | 'gate'
    | 'simulator'
    | 'sizeCheck'
    | 'linearTeam'
    | 'asanaMissing'
    | 'asanaUnfinished'
    | 'archive'
    | 'cleanupFailure'
    | 'memoryKill'
    | 'failed'
  >,
): RequestPurpose | undefined {
  if (comment.kind === 'note') return undefined
  if (comment.simulator) return { kind: 'simulator' }
  if (comment.kind === 'permission') return { kind: 'permission' }
  if (comment.gate) return { kind: 'gate' }
  if (comment.sizeCheck) return { kind: 'size-check' }
  if (comment.linearTeam) return { kind: 'linear-team' }
  if (comment.asanaMissing) return { kind: 'asana-missing' }
  if (comment.asanaUnfinished) return { kind: 'asana-unfinished' }
  if (comment.archive) return { kind: 'archive' }
  if (comment.cleanupFailure) return { kind: 'cleanup-failure' }
  if (comment.memoryKill) return { kind: 'memory-kill' }
  if (comment.failed) return { kind: 'failed-run' }
  if (comment.kind === 'round' || comment.kind === 'proposal') return { kind: comment.kind }
  return { kind: 'question' }
}

export function legacyPurpose(
  comment: Comment,
  modelRunId: () => string | undefined,
): RequestPurpose | undefined {
  const structural = structuralPurpose(comment)
  if (structural?.kind !== 'question' || comment.author.kind !== 'ted') return structural
  if (comment.stage === 'merge' && comment.choices?.includes('Keep waiting'))
    return { kind: 'ci-stuck' }
  if (
    comment.title?.endsWith(' in Linear') &&
    comment.choices?.includes('Archive') &&
    comment.choices.includes('Keep going')
  )
    return { kind: 'linear-closed' }
  if (comment.title === 'The Task Lead stopped without saying why') return { kind: 'idle-run' }
  if (
    comment.title?.endsWith(' isn’t in your plan') &&
    comment.choices?.includes('Use the default model')
  ) {
    const runId = modelRunId()
    if (runId !== undefined) return { kind: 'model', runId }
  }
  return structural
}
