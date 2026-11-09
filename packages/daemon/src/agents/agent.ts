import type { AgentKind, RunState } from '@ted/protocol'

export interface AgentLaunch {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  input: string
  files: Record<string, string>
}

export interface Agent {
  kind: AgentKind
  launch(run: {
    sessionId: string
    prompt: string
    runDir: string
    env: NodeJS.ProcessEnv
  }): AgentLaunch
  message(text: string): string
  stateFrom(line: string): RunState | undefined
}
