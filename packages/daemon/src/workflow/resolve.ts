import { type AgentStageId, agentStageIds, type LayerKind, type StageId } from '@ted/protocol'
import {
  type AgentChoice,
  type CheckedLayer,
  displayPath,
  type StageSettings,
  type WorkflowSettings,
} from './check.ts'

export interface ResolvedStageFile {
  layer: LayerKind
  path: string
  text: string
}

export interface ResolvedWorkflow {
  stages: StageId[]
  order: AgentStageId[]
  settings: WorkflowSettings
  notes?: string
  stageFile(id: AgentStageId): ResolvedStageFile | undefined
  next(current: StageId): StageId
}

const builtInOrder: readonly StageId[] = ['backlog', ...agentStageIds, 'done']
const agentKeys = ['lead', 'reviewer', 'planner'] as const
const lastWins = ['version', 'permissions', 'max_working_runs', 'repos', 'order'] as const

export function resolveWorkflow(layers: CheckedLayer[]): ResolvedWorkflow {
  const settings: WorkflowSettings = { stages: {} }
  const stageFiles = new Map<AgentStageId, ResolvedStageFile>()
  let notes: string | undefined

  for (const layer of layers) {
    const own = layer.settings
    for (const key of lastWins) {
      if (own[key] !== undefined) Object.assign(settings, { [key]: own[key] })
    }
    for (const key of agentKeys) {
      if (own[key] !== undefined) settings[key] = { ...settings[key], ...own[key] } as AgentChoice
    }
    for (const [id, stage] of Object.entries(own.stages) as [StageId, StageSettings][]) {
      settings.stages[id] = { ...settings.stages[id], ...stage }
    }
    for (const [id, text] of Object.entries(layer.stageFiles) as [AgentStageId, string][]) {
      stageFiles.set(id, {
        layer: layer.kind,
        path: displayPath(layer.kind, `stages/${id}.md`),
        text,
      })
    }
    if (layer.notes !== undefined) notes = layer.notes
  }

  const enabled = (id: StageId) => settings.stages[id]?.enabled !== false
  const order: AgentStageId[] = settings.order ?? ['intake', 'work']
  const stages: StageId[] = [
    ...(enabled('backlog') ? (['backlog'] as const) : []),
    ...order.filter(enabled),
    'done',
  ]

  return {
    stages,
    order,
    settings,
    ...(notes !== undefined && { notes }),
    stageFile: (id) => stageFiles.get(id),
    next(current) {
      if (current === 'done') return 'done'
      const index = stages.indexOf(current)
      if (index !== -1) return stages[index + 1] ?? 'done'
      const rank = builtInOrder.indexOf(current)
      return stages.find((id) => id !== 'backlog' && builtInOrder.indexOf(id) > rank) ?? 'done'
    },
  }
}
