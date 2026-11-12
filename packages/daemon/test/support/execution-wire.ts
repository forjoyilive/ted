import type { AssignTaskExecution, TaskAssignment } from '@ted/protocol'

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

export interface FixtureReady {
  port: number
  exchangePort: number
  appToken: string
  machineId: string
}
