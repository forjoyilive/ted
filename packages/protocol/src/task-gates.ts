import type { AgentStageId } from './task.ts'

export type TaskGateOverrides = Partial<Record<AgentStageId, boolean>>

export interface TaskGateRow {
  stage: AgentStageId
  inherited: boolean
  effective: boolean
  required: boolean
  override?: boolean
  overnight?: true
  locked?: string
}

export interface TaskGates {
  overrides: TaskGateOverrides
  rows: TaskGateRow[]
  revision: string
}

export interface SetTaskGatesRequest {
  overrides: TaskGateOverrides
  revision: string
}
