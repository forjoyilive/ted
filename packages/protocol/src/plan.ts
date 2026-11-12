import type { AgentKind } from './run.ts'
import type { CommentAnswer, Effort, Proposal, Round, StageId, TaskStatus } from './task.ts'

export const planTitleLength = 60

export type PlanStatus =
  | 'queued'
  | 'working'
  | 'waiting'
  | 'idle'
  | 'paused'
  | 'failed'
  | 'finished'
  | 'stopped'

export type PlanRequestKind = 'round' | 'proposal' | 'note'

export interface PlanRequest {
  id: string
  planId: string
  runId: string
  kind: PlanRequestKind
  author: 'run' | 'ted'
  title?: string
  body: string
  round?: Round
  proposal?: Proposal
  answer?: CommentAnswer
  createdAt: string
}

export interface PlanTask {
  row: number
  id: string
  displayId: string
  title: string
  stage: StageId
  blockedBy: string[]
}

export type PlanTaskGone = 'archived' | 'deleted' | 'reset'

export interface PlanFromTask {
  id: string
  displayId: string
  title: string
  stage?: StageId
  status?: TaskStatus
  activity?: string
  gone?: PlanTaskGone
}

export interface Plan {
  id: string
  factoryId: string
  factoryKey: string
  title: string
  message: string
  agent: AgentKind
  model?: string
  effort?: Effort
  status: PlanStatus
  queuePlace?: number
  paused?: string
  error?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  runId?: string
  proposedTasks?: number
  createdTasks: number
  waitingOn?: string
  fromPlan?: { id: string; title: string; deleted?: boolean }
  fromTask?: PlanFromTask
}

export interface PlanDetail {
  plan: Plan
  requests: PlanRequest[]
  tasks: PlanTask[]
}

export interface PlanInboxItem {
  request: PlanRequest
  plan: Plan
}

export interface StartPlanRequest {
  factory: string
  message: string
  agent?: AgentKind
  model?: string
  effort?: Effort
  from?: string
}

export function planTitle(message: string): string {
  const line = message.split('\n').find((l) => l.trim() !== '') ?? ''
  const chars = [...line.trim().replace(/\s+/g, ' ')]
  return chars.slice(0, planTitleLength).join('')
}

export function planRequestLabel(request: PlanRequest): string {
  if (request.kind === 'round') {
    const count = request.round?.questions.length ?? 0
    return `Round ${request.round?.number ?? ''} · ${count} ${count === 1 ? 'question' : 'questions'}`
  }
  if (request.kind === 'proposal') {
    const count = request.proposal?.rows.length ?? 0
    return `Proposal · ${count} ${count === 1 ? 'Task' : 'Tasks'}`
  }
  return 'Note'
}

export function openPlanRequest(requests: readonly PlanRequest[]): PlanRequest | undefined {
  return requests.findLast((r) => r.kind !== 'note' && r.answer === undefined)
}

export interface RenamePlanRequest {
  title: string
}
export interface PostPlanRequest {
  round?: import('./task.ts').RoundInput
  proposal?: import('./task.ts').ProposalInput
  supersedes?: string
}
