import type { Effort } from './task.ts'

export type AgentKind = 'claude' | 'codex'

export const agentKinds: readonly AgentKind[] = ['claude', 'codex']

export type RunState = 'working' | 'idle' | 'waiting' | 'finished'

export type RunProblem = 'model-unavailable'

export interface Run {
  id: string
  agent: AgentKind
  sessionId?: string
  model?: string
  effort?: Effort
  usesDefaultModel?: boolean
  problem?: RunProblem
  prompt: string
  cwd: string
  taskId?: string
  parentRunId?: string
  name?: string
  failure?: string
  state: RunState
  startedAt: string
}

export interface ConversationEntry {
  offset: number
  line: string
  at?: string
}

export interface RunWithConversation {
  run: Run
  conversation: ConversationEntry[]
}

export interface StartDevRunRequest {
  prompt: string
  cwd: string
  agent?: AgentKind
}

export interface StartSubAgentRequest {
  agent?: AgentKind
  model?: string
  effort?: Effort
  prompt: string
  name?: string
  ownWorktree?: boolean
}

export type SubAgentState = 'queued' | 'working' | 'waiting' | 'idle' | 'stopped' | 'failed'

export interface SubAgent {
  id: string
  name: string
  agent: AgentKind
  state: SubAgentState
}

export interface SubAgentWait extends SubAgent {
  done: boolean
  message?: string
  error?: string
}

export interface SendSubAgentRequest {
  text: string
}
