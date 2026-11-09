import type { AgentKind, Effort, PermissionMode, RunProblem, RunState } from '@ted/protocol'

export interface AgentLaunch {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  input: string
  files: Record<string, string>
  driver?: string
  sessionId?: string
}

export interface PermissionPrompt {
  requestId: string
  title: string
  command: string
  details?: string
  reason?: string
  input?: unknown
  refuse?: boolean
}

export interface PermissionReply {
  requestId: string
  approved: boolean
  input?: unknown
  text?: string
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
    permissions: PermissionMode
  }): AgentLaunch
  message(text: string): string
  stateFrom(line: string): RunState | undefined
  permissionPromptFrom(line: string): PermissionPrompt | undefined
  permissionClosedFrom(line: string): string | undefined
  autoModeUnavailableFrom(line: string): boolean
  permissionReply(reply: PermissionReply): string[]
  acceptedTextFrom(line: string): string | undefined
  sessionIdFrom(line: string): string | undefined
  problemFrom(line: string): RunProblem | undefined
  tokensFrom(line: string): TokenCount | undefined
  authErrorFrom(line: string): boolean
  environment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  health: AgentHealthSpec
}
