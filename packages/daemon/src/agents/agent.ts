import type {
  AgentKind,
  ChatDiff,
  ChatToolStatus,
  ConversationEntry,
  Effort,
  RunProblem,
  RunState,
} from '@ted/protocol'

export interface AgentLaunch {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  input: string
  files: Record<string, string>
  driver?: string
  sessionId?: string
}

export interface TokenCount {
  input: number
  output: number
  total: boolean
}

export interface AuthCheck {
  signedIn: boolean
  account?: string
}

export interface AgentHealthSpec {
  minimumVersion: string
  versionArgs: string[]
  authArgs: string[]
  auth(result: { code: number | null; stdout: string; stderr: string }): AuthCheck
  signIn: string
  update: string
  install: string
}

export type AgentChatEntry =
  | { kind: 'user'; key: string; text: string; at?: string }
  | { kind: 'agent'; key: string; text: string; done: boolean; at?: string }
  | {
      kind: 'tool'
      key: string
      tool: string
      title: string
      status: ChatToolStatus
      detail?: string
      output?: string
      diffs?: ChatDiff[]
      at?: string
      endedAt?: string
    }

export interface Agent {
  kind: AgentKind
  binary: string
  launch(run: {
    prompt: string
    runDir: string
    env: NodeJS.ProcessEnv
    resume?: string
    model?: string
    effort?: Effort
  }): AgentLaunch
  message(text: string): string
  stateFrom(line: string): RunState | undefined
  chat(entries: readonly ConversationEntry[], cwd: string): AgentChatEntry[]
  acceptedTextFrom(line: string): string | undefined
  agentTextFrom(line: string): string | undefined
  sessionIdFrom(line: string): string | undefined
  problemFrom(line: string): RunProblem | undefined
  tokensFrom(line: string): TokenCount | undefined
  authErrorFrom(line: string): boolean
  environment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  health: AgentHealthSpec
}
