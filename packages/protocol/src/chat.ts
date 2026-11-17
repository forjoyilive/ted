import type { AgentKind, RunState } from './run.ts'
import type { Comment, Effort } from './task.ts'

export type ChatToolStatus = 'running' | 'done' | 'failed' | 'stopped'

export interface ChatDiffLine {
  kind: 'context' | 'added' | 'removed'
  text: string
}

export interface ChatDiff {
  path: string
  additions: number
  deletions: number
  lines: ChatDiffLine[]
  truncated?: boolean
}

export type ChatItem =
  | { kind: 'instructions'; id: string; text: string; lines: number; at?: string }
  | { kind: 'prompt'; id: string; text: string; lines: number; at?: string }
  | { kind: 'agent'; id: string; text: string; at?: string; writing?: boolean }
  | {
      kind: 'tool'
      id: string
      tool: string
      title: string
      status: ChatToolStatus
      detail?: string
      output?: string
      diffs?: ChatDiff[]
      at?: string
      endedAt?: string
    }
  | {
      kind: 'human'
      id: string
      text: string
      at: string
      sent: boolean
      queued?: true
      unsent?: true
    }
  | { kind: 'interrupted'; id: string; at: string }
  | { kind: 'ted'; id: string; title: string; text: string; at?: string }
  | { kind: 'permission'; id: string; request: Comment; at: string }
  | {
      kind: 'command'
      id: string
      name: string
      status: 'running' | 'passed' | 'failed' | 'stopped'
      exitCode?: number
      output: string
      at: string
      endedAt?: string
    }

export type RunRole = 'lead' | 'sub-agent' | 'run' | 'side-chat'

export interface RunSummary {
  id: string
  taskId?: string
  parentRunId?: string
  name: string
  role: RunRole
  agent: AgentKind
  model?: string
  effort?: Effort
  credential?: string
  tokens?: number
  cost?: number
  state: RunState
  paused?: string
  onSubAgents?: boolean
  failed?: boolean
  startedAt: string
  current: boolean
}

export interface RunChat {
  run: RunSummary
  items: ChatItem[]
}

export interface ConversationTab {
  runId: string
  name: string
  agent: AgentKind
  state: RunState
}

export interface SendRunMessageRequest {
  text: string
  interrupt?: boolean
}

export interface RunMessage {
  id: string
  runId: string
  text: string
  at: string
  queued?: true
  from?: 'ted'
}
