import type {
  Comment,
  DescriptionVersion,
  MoveTaskRequest,
  Task,
  TaskBrief,
  TaskLead,
} from './task.ts'

export type CoordinatorTaskState = Pick<Task, 'stage' | 'priority' | 'rank' | 'status' | 'archived'>

export interface CoordinatorReceipt {
  id: string
  operation: string
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
  receipts: CoordinatorReceipt[]
  tasks: Task[]
}

export interface CoordinatorMessage {
  text: string
  agent?: TaskLead['agent']
  model?: string
  effort?: TaskLead['effort']
}

export type CoordinatorTaskSummary = Pick<
  Task,
  'id' | 'displayId' | 'title' | 'stage' | 'priority' | 'rank' | 'status' | 'blockedBy' | 'archived'
>

export interface CoordinatorTask {
  descriptions: DescriptionVersion[]
  task: Task
  brief?: TaskBrief
  comments: Comment[]
  nextOffset?: number
  version: string
}

export interface CoordinatorAction extends MoveTaskRequest {
  operation: string
  version: string
  neighbours?: Record<string, string>
}
