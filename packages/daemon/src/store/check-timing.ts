import type { CheckRun, CheckRunTiming, CheckTimingInterval } from '@ted/protocol'

interface Boundary {
  kind: string
  position: number | null
  at: string
}

export function checkRunTiming(run: CheckRun, boundaries: Boundary[]): CheckRunTiming {
  const at = (kind: string) => boundaries.find((b) => b.kind === kind)?.at
  const interval = (
    startedAt: string | undefined,
    endedAt: string | undefined,
    status: 'complete' | 'canceled' | 'interrupted',
    durationMs?: number,
  ): CheckTimingInterval => {
    if (startedAt === undefined) return { status: 'unavailable' }
    if (endedAt !== undefined)
      return {
        status,
        startedAt,
        endedAt,
        durationMs: durationMs ?? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
      }
    const detectedAt = at('recovered') ?? run.finishedAt
    if (detectedAt !== undefined) return { status: 'interrupted', startedAt, detectedAt }
    return { status: 'ongoing', startedAt }
  }
  const canceled = at('canceled')
  const interrupted = at('interrupted')
  return {
    checkRunId: run.id,
    taskId: run.taskId,
    trigger: run.trigger,
    stage: run.stage,
    queue: interval(
      at('entered'),
      at('acquired') ?? canceled ?? interrupted,
      canceled ? 'canceled' : interrupted ? 'interrupted' : 'complete',
    ),
    execution: run.checks.map((check, position) => ({
      position,
      ...interval(
        boundaries.find((b) => b.kind === 'start' && b.position === position)?.at,
        boundaries.find(
          (b) => (b.kind === 'end' || b.kind === 'interrupted-end') && b.position === position,
        )?.at,
        boundaries.some((b) => b.kind === 'interrupted-end' && b.position === position)
          ? 'interrupted'
          : 'complete',
        check.durationMs,
      ),
    })),
  }
}
