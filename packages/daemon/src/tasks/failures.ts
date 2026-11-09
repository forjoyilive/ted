import type { AgentKind, RunEnding } from '@ted/protocol'
import type { LoggedEvent } from '../store/index.ts'

export const failureWindowMs = 30 * 60_000

export const failedTitle = 'The Task Lead stopped twice in 30 minutes'

export const retryChoice = 'Retry'

const binaries: Record<AgentKind, string> = { claude: 'claude', codex: 'codex' }

export function endingReason(ending: RunEnding | undefined): string {
  if (ending?.how === 'lost') return 'stopped unexpectedly'
  if (ending?.signal !== undefined) return `was killed (${ending.signal})`
  if (ending?.code !== undefined) return `exited with code ${ending.code}`
  if (ending?.error !== undefined) return `couldn’t start: ${ending.error}`
  return 'exited'
}

export function silentReason(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.round(ms / 60_000)
    return `sent no output for ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  }
  const seconds = Math.max(1, Math.round(ms / 1000))
  return `sent no output for ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`
}

export function asksForFreshRun(entry: LoggedEvent): boolean {
  return (
    entry.name === 'v1.TaskResumed' ||
    entry.name === 'v1.TaskRequeuedAfterBlockers' ||
    entry.name === 'v1.TaskRetried' ||
    (entry.name === 'v1.TaskUnarchived' && entry.data.queued === true) ||
    (entry.name === 'v1.TaskLeadFailed' && entry.data.recovery === 'fresh')
  )
}

export function recentFailures(log: readonly LoggedEvent[], now: number): LoggedEvent[] {
  const since = log.findLastIndex((e) => e.name === 'v1.TaskRetried' || e.name === 'v1.TaskResumed')
  return log
    .slice(since + 1)
    .filter(
      (e) =>
        e.name === 'v1.TaskLeadFailed' &&
        e.data.resumeFailed !== true &&
        now - Date.parse(e.at) < failureWindowMs,
    )
}

export function alreadyFailed(log: readonly LoggedEvent[], runId: string, since: string): boolean {
  return log.some((e) => e.name === 'v1.TaskLeadFailed' && e.data.runId === runId && e.at >= since)
}

export function revivedMessage(reason: string): string {
  return `Your process ${reason}, so TED resumed your session. Check where you were, then carry on with this Stage.`
}

export function freshAfterFailure(entry: LoggedEvent): { heading: string; why: string } {
  if (entry.name === 'v1.TaskRetried') {
    return {
      heading: 'Picking up after a failure',
      why: 'The Task Lead stopped twice in 30 minutes, and the human asked TED to try again.',
    }
  }
  const reason = typeof entry.data.reason === 'string' ? entry.data.reason : 'exited'
  return {
    heading: 'Picking up after a crash',
    why:
      entry.data.resumeFailed === true
        ? `The last Task Lead Run ${reason} and TED couldn’t resume its session.`
        : `The last Task Lead Run ${reason}.`,
  }
}

export function failedAsk(
  agent: AgentKind,
  since: readonly LoggedEvent[],
  reason: string,
  ending: RunEnding | undefined,
  now: number,
): { title: string; body: string } {
  const first = since.find((e) => e.name === 'v1.TaskLeadFailed')
  const firstReason = typeof first?.data.reason === 'string' ? first.data.reason : 'exited'
  const resumeFailed = since.some(
    (e) => e.name === 'v1.TaskLeadFailed' && e.data.resumeFailed === true,
  )
  const tried =
    first?.data.recovery === 'resume' && !resumeFailed
      ? 'TED resumed the session'
      : first?.data.recovery === 'resume'
        ? 'TED couldn’t resume the session, so it started a fresh Task Lead Run from the brief'
        : 'TED started a fresh Task Lead Run from the brief'
  const minutes = first ? Math.round((now - Date.parse(first.at)) / 60_000) : 0
  const later =
    minutes === 0 ? 'less than a minute' : minutes === 1 ? 'a minute' : `${minutes} minutes`
  const lines = [...(ending?.errorLines ?? []), `${binaries[agent]} ${reason}`]
  return {
    title: failedTitle,
    body: [
      `The Task Lead Run ${firstReason}. ${tried}, and ${later} later it ${reason}. The worktree and Task brief are kept.`,
      `\`\`\`\n${lines.join('\n')}\n\`\`\``,
    ].join('\n\n'),
  }
}
