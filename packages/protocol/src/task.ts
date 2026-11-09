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

export interface Task {
  id: string
  factoryId: string
  number: number
  displayId: string
  title: string
  stage: StageId
  branch?: string
  leadRunId?: string
  repos: TaskRepo[]
  createdAt: string
}

export type WorktreeCommandOutcome = 'passed' | 'failed' | 'timed-out'

export interface CopySkip {
  path: string
  reason: 'no-local-folder' | 'local-folder-missing' | 'missing' | 'outside' | 'not-a-file'
}

export interface TaskRepo {
  name: string
  repo: string
  branch: string
  worktree: string
  copied: string[]
  skipped: CopySkip[]
  setup?: {
    command: string
    state: 'running' | WorktreeCommandOutcome
    exitCode?: number
  }
  removed?: {
    at: string
    teardown?: { command: string; outcome: WorktreeCommandOutcome }
  }
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
