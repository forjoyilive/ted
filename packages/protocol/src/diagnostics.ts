import type { AgentKind, RunState } from './run.ts'

export interface TokenUse {
  input: number
  output: number
}

export interface RunDiagnostics {
  runId: string
  agent: AgentKind
  state: RunState
  taskId?: string
  startedAt: string
  cpuPercent: number
  memoryBytes: number
  tokens: TokenUse
}

export interface ProcessInfo {
  pid: number
  ppid: number
  cpuPercent: number
  memoryBytes: number
  command: string
  owner: 'daemon' | { runId: string }
}

export interface Diagnostics {
  runs: RunDiagnostics[]
  processes: ProcessInfo[]
  memory: { totalBytes: number; availableBytes: number }
}

export interface ProcessUsage {
  cpuPercent: number
  memoryBytes: number
}

export interface LogText {
  text: string
  truncated: boolean
}
