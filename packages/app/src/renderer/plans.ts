import type { ChatItem, ChatRequest, Plan, PlanRequest, PlanStatus } from '@ted/protocol'
import type { StatusGlyph, StatusTone } from './components/StatusChip.tsx'
import { clockTime } from './requests.ts'
import { formatDate } from './time.ts'

function ordinal(n: number): string {
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th')
  return `${n}${suffix}`
}

const day = {
  format: (at: Date) => formatDate(at, { weekday: 'short', day: 'numeric', month: 'short' }),
}
export function when(iso: string): string {
  return `${day.format(new Date(iso)).replace(',', '')} ${clockTime(iso)}`
}

export const endedStatuses: readonly PlanStatus[] = ['finished', 'stopped', 'failed']

export function planEnded(plan: Pick<Plan, 'status'>): boolean {
  return endedStatuses.includes(plan.status)
}

export function planStatusChip(plan: Pick<Plan, 'status' | 'queuePlace' | 'paused'>): {
  tone: StatusTone
  glyph?: StatusGlyph
  label: string
} {
  switch (plan.status) {
    case 'waiting':
      return { tone: 'waiting', glyph: 'waiting', label: 'Waiting on you' }
    case 'working':
      return { tone: 'working', glyph: 'working', label: 'Working' }
    case 'idle':
      return { tone: 'neutral', label: 'Idle' }
    case 'queued':
      return {
        tone: 'neutral',
        glyph: 'queued',
        label: plan.queuePlace === undefined ? 'Queued' : `Queued · ${ordinal(plan.queuePlace)}`,
      }
    case 'paused':
      return { tone: 'neutral', glyph: 'paused', label: `Paused · ${plan.paused ?? 'usage limit'}` }
    case 'failed':
      return { tone: 'failed', glyph: 'failed', label: 'Failed' }
    case 'finished':
      return { tone: 'success', label: 'Finished' }
    case 'stopped':
      return { tone: 'neutral', glyph: 'stopped', label: 'Stopped' }
  }
}

export function planStartedLine(plan: Pick<Plan, 'status' | 'createdAt' | 'finishedAt'>): string {
  if (plan.status === 'finished' && plan.finishedAt !== undefined) {
    return `Planning chat · finished ${when(plan.finishedAt)}`
  }
  if (plan.status === 'stopped' && plan.finishedAt !== undefined) {
    return `Planning chat · stopped ${when(plan.finishedAt)}`
  }
  return `Planning chat · started by you ${when(plan.createdAt)}`
}

export function planGroups(plans: readonly Plan[]): { open: Plan[]; past: Plan[] } {
  const newest = [...plans].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return {
    open: newest.filter((p) => p.status !== 'finished'),
    past: newest.filter((p) => p.status === 'finished'),
  }
}

export function planTasksLabel(
  plan: Pick<Plan, 'status' | 'proposedTasks' | 'createdTasks'>,
): string {
  if (plan.createdTasks > 0) {
    return `Created ${plan.createdTasks} ${plan.createdTasks === 1 ? 'Task' : 'Tasks'}`
  }
  if (plan.status === 'finished') return 'No Tasks'
  if (plan.proposedTasks !== undefined) return `${plan.proposedTasks} proposed`
  return '—'
}

export function planDetailLine(plan: Pick<Plan, 'status' | 'waitingOn'>): string | undefined {
  if (plan.status === 'waiting') return plan.waitingOn
  if (plan.status === 'idle') return 'Your turn to write'
  return undefined
}

export function startedDay(iso: string): string {
  return day.format(new Date(iso)).replace(',', '')
}

export function plansFailedByFactory(
  plans: readonly Pick<Plan, 'factoryId' | 'status' | 'archivedAt'>[],
): Set<string> {
  return new Set(
    plans
      .filter((p) => p.status === 'failed' && p.archivedAt === undefined)
      .map((p) => p.factoryId),
  )
}

export type AskedRequest = Pick<PlanRequest, 'round' | 'proposal' | 'answer'> & {
  kind: PlanRequest['kind'] | ChatRequest['kind']
}

export interface RequestHeading {
  kind: string
  detail?: string
}

export function requestHeading(request: AskedRequest): RequestHeading {
  if (request.kind === 'question') return { kind: 'Question' }
  if (request.kind === 'round') return { kind: `Round ${request.round?.number ?? ''}` }
  if (request.kind === 'agent') return { kind: 'Agent draft' }
  if (request.kind === 'outside-command') return { kind: 'Outside command' }
  const count = request.proposal?.rows.length ?? 0
  return { kind: 'Proposal', detail: `${count} ${count === 1 ? 'Task' : 'Tasks'}` }
}

export function requestState(request: AskedRequest, latest: boolean): string {
  const { answer } = request
  if (!answer) return 'waiting for you'
  if (answer.kind === 'answered') return `answered by you at ${clockTime(answer.at)}`
  if (request.kind === 'agent' && answer.kind === 'approved')
    return `saved by you at ${clockTime(answer.at)}`
  if (request.kind === 'agent' && answer.kind === 'denied') return 'dismissed'
  if (request.kind === 'outside-command' && answer.kind === 'approved')
    return `run by you at ${clockTime(answer.at)}`
  if (request.kind === 'outside-command' && answer.kind === 'denied') return 'not run'
  if (answer.kind === 'approved') return `approved by you at ${clockTime(answer.at)}`
  if (answer.kind === 'superseded') return 'Superseded'
  if (answer.kind === 'changes-requested') return latest ? 'changes requested' : 'Superseded'
  if (answer.kind === 'withdrawn') return 'Withdrawn'
  return 'Answered'
}

export function inboxLabel(request: PlanRequest): string {
  const { kind, detail } = requestHeading(request)
  return dotted('Plan', kind, detail)
}

export function dotted(...parts: (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined && part !== '').join(' · ')
}

export function chatActivity(items: readonly ChatItem[]): string | undefined {
  for (const item of [...items].reverse()) {
    if (item.kind === 'tool') return item.title
    if (item.kind === 'agent') {
      return item.text
        .split('\n')
        .find((line) => line.trim() !== '')
        ?.trim()
    }
  }
  return undefined
}
