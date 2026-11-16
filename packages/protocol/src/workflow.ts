import type { StageId } from './task.ts'

export type LayerKind = 'ted' | 'library' | 'factory'

export interface WorkflowProblem {
  severity: 'error' | 'warning'
  file: string
  line: number
  column: number
  message: string
}

export interface LayerUse {
  layer: LayerKind
  status: 'valid' | 'last-valid' | 'skipped' | 'absent'
  version?: string
  problems: WorkflowProblem[]
}

export interface StageEntry {
  taskId: string
  stage: StageId
  stageFile?: { layer: LayerKind; path: string }
  layers: LayerUse[]
  at: string
}

export interface BoardStage {
  id: StageId
  name?: string
  custom?: true
  removed?: true
  enabled: boolean
  gate: boolean
  overnight?: true
}

export interface FactoryBoard {
  stages: BoardStage[]
}
