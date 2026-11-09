import type { AgentKind, Effort, RunProblem, RunState } from '@ted/protocol'

export interface AgentLaunch {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  input: string
  files: Record<string, string>
  driver?: string
  sessionId?: string
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
  sessionIdFrom(line: string): string | undefined
  problemFrom(line: string): RunProblem | undefined
}
