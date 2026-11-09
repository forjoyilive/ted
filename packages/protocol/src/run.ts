import type { Effort } from './task.ts'

export type AgentKind = 'claude' | 'codex'

export const agentKinds: readonly AgentKind[] = ['claude', 'codex']

export type RunState = 'working' | 'idle' | 'waiting' | 'finished'

export type RunProblem = 'model-unavailable'

export const permissionModes = ['auto', 'bypass'] as const

export type PermissionMode = (typeof permissionModes)[number]

export interface Run {
  id: string
  agent: AgentKind
  sessionId?: string
  model?: string
  effort?: Effort
  usesDefaultModel?: boolean
  problem?: RunProblem
  permissions: PermissionMode
  manualPermissions?: boolean
  prompt: string
  cwd: string
  taskId?: string
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
