import type { AgentKind, RunState } from '@ted/protocol'

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

export interface Agent {
  kind: AgentKind
  binary: string
  launch(run: {
    prompt: string
    runDir: string
    env: NodeJS.ProcessEnv
    resume?: string
  }): AgentLaunch
  message(text: string): string
  stateFrom(line: string): RunState | undefined
  sessionIdFrom(line: string): string | undefined
  tokensFrom(line: string): TokenCount | undefined
  authErrorFrom(line: string): boolean
  environment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv
  health: AgentHealthSpec
}
