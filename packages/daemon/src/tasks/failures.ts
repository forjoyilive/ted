import type { AgentKind, RunEnding } from '@ted/protocol'
import type { FailureHistory, FreshRunRequest } from '../store/task-history.ts'

export const failedTitle = 'The Task Lead stopped twice in 30 minutes'

export const retryChoice = 'Retry'

const binaries: Record<AgentKind, string> = { claude: 'claude', codex: 'codex', antigravity: 'agy' }

export const memoryReason = 'was stopped because this computer ran out of memory'

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

export function revivedMessage(reason: string): string {
  return `Your process ${reason}, so TED resumed your session. Check where you were, then carry on with this Stage.`
}

export function freshAfterFailure(
  entry: Extract<FreshRunRequest, { kind: 'failure' }> | { kind: 'retried' },
): { heading: string; why: string } {
  if (entry.kind === 'retried') {
    return {
      heading: 'Picking up after a failure',
      why: 'The Task Lead stopped twice in 30 minutes, and the human asked TED to try again.',
    }
  }
  const reason = entry.failure.reason
  return {
    heading: 'Picking up after a crash',
    why:
      entry.failure.resumeFailed === true
        ? `The last Task Lead Run ${reason} and TED couldn’t resume its session.`
        : `The last Task Lead Run ${reason}.`,
  }
}

export function failedAsk(
  agent: AgentKind,
  since: readonly FailureHistory[],
  reason: string,
  ending: RunEnding | undefined,
  now: number,
): { title: string; body: string } {
  const first = since[0]
  const firstReason = first?.reason ?? 'exited'
  const resumeFailed = since.some((e) => e.resumeFailed)
  const tried =
    first?.recovery === 'resume' && !resumeFailed
      ? 'TED resumed the session'
      : first?.recovery === 'resume'
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
