import type { AgentKind } from './run.ts'

export const agentStageIds = [
  'intake',
  'clarify',
  'design',
  'work',
  'validate',
  'review',
  'merge',
] as const

export type AgentStageId = (typeof agentStageIds)[number]

export type StageId = 'backlog' | AgentStageId | 'done'

export const priorities = ['urgent', 'high', 'medium', 'low', 'none'] as const

export type Priority = (typeof priorities)[number]

export const clarifyDepths = ['auto', 'none', 'few', 'grilling'] as const

export type ClarifyDepth = (typeof clarifyDepths)[number]

export const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

export type Effort = (typeof efforts)[number]

export interface TaskLead {
  agent: AgentKind
  model?: string
  effort?: Effort
}

export interface Attachment {
  hash: string
  name: string
  size: number
  mediaType: string
}

export interface TaskDefaults {
  lead: TaskLead
  clarifyDepth: ClarifyDepth
}

export interface Task {
  id: string
  factoryId: string
  number: number
  displayId: string
  title: string
  description: string
  priority: Priority
  clarifyDepth: ClarifyDepth
  lead?: TaskLead
  blockedBy: string[]
  attachments: Attachment[]
  stage: StageId
  branch?: string
  leadRunId?: string
  createdAt: string
}

export interface CreateTaskRequest {
  title?: string
  description?: string
  factory?: string
  priority?: Priority
  clarifyDepth?: ClarifyDepth
  lead?: TaskLead
  blockedBy?: string[]
  attachments?: Pick<Attachment, 'hash' | 'name' | 'mediaType'>[]
  start?: boolean
}

export type Outcome = 'advance'

export interface Comment {
  id: string
  taskId: string
  kind: 'note' | 'question'
  body: string
  author: { kind: 'run'; runId: string } | { kind: 'ted' }
  createdAt: string
}

export interface PostCommentRequest {
  body: string
}

export interface ReportOutcomeRequest {
  outcome: Outcome
}

export type SetTaskLeadRequest = TaskLead
