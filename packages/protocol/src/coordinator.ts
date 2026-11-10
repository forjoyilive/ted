import type { RunMessage } from './chat.ts'
import type {
  Comment,
  DescriptionVersion,
  MoveTaskRequest,
  RoundAnswerInput,
  RoundQuestion,
  Task,
  TaskBrief,
  TaskLead,
} from './task.ts'

export type CoordinatorTaskState = Pick<Task, 'stage' | 'priority' | 'rank' | 'status' | 'archived'>

export type CoordinatorOperation = 'start' | 'move' | 'tell' | 'answer' | 'resume'

export interface CoordinatorReceipt {
  id: string
  operation: CoordinatorOperation
  taskId: string
  text: string
  at: string
  before?: CoordinatorTaskState
  after?: CoordinatorTaskState
  fingerprint: string
}

export interface Coordinator {
  factoryId: string
  runId: string
  runIds: string[]
  started: boolean
  opening: string
  lead: TaskLead
  status: 'ready' | 'queued' | 'working' | 'paused' | 'failed'
  error?: string
  unsentMessages: RunMessage[]
  receipts: CoordinatorReceipt[]
  tasks: Task[]
}

export interface CoordinatorStatus {
  factoryId: string
  status: Coordinator['status']
}

export interface CoordinatorMessage {
  text: string
  agent?: TaskLead['agent']
  model?: string
  effort?: TaskLead['effort']
}

export interface CoordinatorRequest {
  id: string
  kind: Comment['kind']
  askedBy: Comment['author']['kind']
  stage?: Comment['stage']
  title?: string
  text: string
  choices?: string[]
  questions?: RoundQuestion[]
  createdAt: string
  coordinatorMayAnswer:
    | 'yes'
    | 'with a choice'
    | 'approve or request changes'
    | 'round answers'
    | 'no'
}

export type CoordinatorTaskSummary = Pick<
  Task,
  'id' | 'displayId' | 'title' | 'stage' | 'priority' | 'rank' | 'status' | 'blockedBy' | 'archived'
> & { openRequests?: CoordinatorRequest[]; moreOpenRequests?: number }

export interface CoordinatorTask {
  descriptions: DescriptionVersion[]
  task: Task
  brief?: TaskBrief
  comments: Comment[]
  openRequests: CoordinatorRequest[]
  moreOpenRequests?: number
  now: string
  nextOffset?: number
  version: string
}

export interface CoordinatorAction extends MoveTaskRequest {
  operation: string
  version: string
  neighbours?: Record<string, string>
  message?: string
  request?: string
  choice?: string
  decision?: 'approve' | 'request-changes'
  answers?: RoundAnswerInput[]
  recommended?: boolean
  skipRows?: number[]
  startUnblocked?: boolean
}
