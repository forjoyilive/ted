export type AgentKind = 'claude'

export type RunState = 'working' | 'idle' | 'waiting' | 'finished'

export interface Run {
  id: string
  agent: AgentKind
  sessionId: string
  prompt: string
  cwd: string
  taskId?: string
  state: RunState
  startedAt: string
}

export interface ConversationEntry {
  offset: number
  line: string
}

export interface RunWithConversation {
  run: Run
  conversation: ConversationEntry[]
}

export interface StartDevRunRequest {
  prompt: string
  cwd: string
}
