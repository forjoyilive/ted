export type StageId = 'backlog' | 'work' | 'done'

export interface Task {
  id: string
  factoryId: string
  number: number
  displayId: string
  title: string
  stage: StageId
  branch?: string
  leadRunId?: string
  createdAt: string
}

export interface CreateTaskRequest {
  title: string
  factory?: string
}

export type Outcome = 'advance'

export interface Comment {
  id: string
  taskId: string
  kind: 'note'
  body: string
  author: { kind: 'run'; runId: string }
  createdAt: string
}

export interface PostCommentRequest {
  body: string
}

export interface ReportOutcomeRequest {
  outcome: Outcome
}
