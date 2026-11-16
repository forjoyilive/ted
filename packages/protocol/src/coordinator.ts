import type { RunMessage } from './chat.ts'
import type {
  BlockedChoice,
  ClarifyDepth,
  Comment,
  DescriptionVersion,
  MoveTaskRequest,
  Priority,
  RoundAnswerInput,
  RoundQuestion,
  StageId,
  Task,
  TaskBrief,
  TaskHierarchy,
  TaskLead,
  TaskStatusKind,
} from './task.ts'

export type CoordinatorTaskState = Pick<
  Task,
  'stage' | 'priority' | 'rank' | 'status' | 'archived' | 'parentId' | 'childIds'
>

export type CoordinatorOperation =
  | 'start'
  | 'move'
  | 'tell'
  | 'answer'
  | 'resume'
  | 'parent'
  | 'done'
  | 'create'
  | CoordinatorRemovalKind

export type CoordinatorRemovalKind = 'archive' | 'unarchive' | 'delete'

export interface CoordinatorReceipt {
  id: string
  operation: CoordinatorOperation
  taskId?: string
  text: string
  at: string
  before?: CoordinatorTaskState
  after?: CoordinatorTaskState
  fingerprint: string
}

export interface Coordinator {
  id: string
  factoryId: string
  runId: string
  runIds: string[]
  started: boolean
  opening: string
  startedAt: string
  endedAt?: string
  lead: TaskLead
  status: 'ready' | 'queued' | 'working' | 'paused' | 'failed'
  error?: string
  unsentMessages: RunMessage[]
  receipts: CoordinatorReceipt[]
  confirmations: CoordinatorConfirmation[]
  tasks: Task[]
}

export interface CoordinatorChatSummary {
  id: string
  factoryId: string
  title: string
  status: Coordinator['status']
  startedAt: string
  lastAt: string
  endedAt?: string
  taskCount: number
  waiting: boolean
}

export interface CoordinatorRemoval {
  operation: string
  tasks: { id: string; version: string }[]
  children?: 'archive' | 'detach' | 'delete' | 'unparent'
  blocked?: BlockedChoice
  closePullRequests?: boolean
}

export interface CoordinatorRemovalResult {
  receipts: CoordinatorReceipt[]
  confirmation?: { id: string; waiting: boolean }
}

export interface ConfirmationTaskRef {
  id: string
  displayId: string
  title: string
}

export interface ConfirmationChoices {
  children?: 'archive' | 'detach' | 'delete' | 'unparent'
  blocked?: BlockedChoice
  closePullRequests?: boolean
}

export interface CoordinatorConfirmationTask extends ConfirmationTaskRef, ConfirmationChoices {
  stage: StageId
  descendants: ConfirmationTaskRef[]
  blockedTasks: ConfirmationTaskRef[]
  pullRequests: { repo: string; number: number }[]
  working: boolean
  result?: { done: boolean; text: string }
}

export interface CoordinatorConfirmation {
  id: string
  kind: 'archive' | 'delete'
  operation: string
  fingerprint: string
  askedAt: string
  tasks: CoordinatorConfirmationTask[]
  answer?: { decision: 'confirm' | 'cancel'; at: string }
}

export interface CoordinatorConfirmationAnswer {
  decision: 'confirm' | 'cancel'
  choices?: Record<string, ConfirmationChoices>
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
  multiple?: true
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
  | 'id'
  | 'displayId'
  | 'title'
  | 'stage'
  | 'priority'
  | 'rank'
  | 'status'
  | 'blockedBy'
  | 'parentId'
  | 'childIds'
  | 'archived'
> & { openRequests?: CoordinatorRequest[]; moreOpenRequests?: number }

export interface CoordinatorTaskQuery {
  offset?: number
  all?: true
  stages?: StageId[]
  statuses?: TaskStatusKind[]
  waiting?: true
  search?: string
}

export interface CoordinatorTaskList {
  now: string
  tasks: CoordinatorTaskSummary[]
  matching: number
  stageCounts: Partial<Record<StageId, number>>
  archived?: number
  nextOffset?: number
}

export interface CoordinatorTask {
  hierarchy: TaskHierarchy
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
  parentId?: string | null
  hierarchyRevision?: string
  operation: string
  version: string
  neighbours?: Record<string, string>
  message?: string
  request?: string
  choice?: string
  choices?: string[]
  decision?: 'approve' | 'request-changes'
  answers?: RoundAnswerInput[]
  recommended?: boolean
  skipRows?: number[]
  startUnblocked?: boolean
  closePullRequests?: boolean
}

export interface CoordinatorCreate extends MoveTaskRequest {
  operation: string
  title: string
  description?: string
  parentId?: string
  blockedBy?: string[]
  source?: string
  priority?: Priority
  clarifyDepth?: ClarifyDepth
  lead?: TaskLead
  start?: boolean
  neighbours?: Record<string, string>
}
