import type { MemoryUse } from './memory.ts'
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

export type ProcessKind =
  | 'ted-app'
  | 'daemon'
  | 'run-host'
  | 'agent'
  | 'agent-tool'
  | 'check'
  | 'app'
  | 'other'

export type ProcessRunRole =
  | 'task-lead'
  | 'sub-agent'
  | 'coordinator'
  | 'planning'
  | 'side-chat'
  | 'automation'
  | 'run'

export interface ProcessRun {
  runId: string
  agent: AgentKind
  role: ProcessRunRole
  task?: string
}

export interface ProcessInfo {
  pid: number
  ppid: number
  cpuPercent: number
  memoryBytes: number
  command: string
  owner: 'daemon' | 'app' | { runId: string }
  kind: ProcessKind
  run?: ProcessRun
  task?: string
  appName?: string
}

export interface Diagnostics {
  runs: RunDiagnostics[]
  processes: ProcessInfo[]
  memory: { totalBytes: number; availableBytes: number }
}

export interface ProcessUsage {
  cpuPercent: number
  memoryBytes: number
  memory: MemoryUse
}

export interface MachineUsage {
  cpuInUse: number | null
  memoryInUse: number | null
}

export interface DiagnosticsUsage extends ProcessUsage {
  machine: MachineUsage
}

export interface ResourceReading {
  machine: MachineUsage
  memory: MemoryUse
}

export interface LogText {
  text: string
  truncated: boolean
}
