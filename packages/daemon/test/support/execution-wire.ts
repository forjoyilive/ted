import type { AssignTaskExecution, ExecutionCommand, TaskAssignment } from '@ted/protocol'
import type { IssueExecution } from '../../src/execution/commands.ts'

export interface FixtureControl {
  executionClockOffsetMs?: number
  freeBytes?: number
  load?: number
  online?: boolean
  signedIn?: boolean
  acknowledgment?: 'hold' | 'drop' | 'release'
}

export interface ExchangeCounts {
  executed: number
  acknowledged: number
  dropped: number
  held: number
}

export type FixtureCommand =
  | { action: 'control'; changes: FixtureControl }
  | { action: 'counts' }
  | { action: 'stop' }
  | { action: 'create' }
  | { action: 'assign'; input: AssignTaskExecution }
  | { action: 'local'; taskId: string }
  | { action: 'require'; assignment: TaskAssignment }
  | { action: 'replay' }
  | { action: 'assign-remote'; taskId: string; machineId: string }
  | { action: 'issue'; input: IssueExecution }
  | { action: 'inject'; command: ExecutionCommand }
  | { action: 'stop-operation'; id: string }
  | { action: 'operation'; id: string }
  | { action: 'operations'; taskId: string }

export interface FixtureReady {
  port: number
  exchangePort: number
  appToken: string
  machineId: string
}
