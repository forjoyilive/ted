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
}
