import {
  type AgentStageId,
  agentStageIds,
  type BoardStage,
  type LayerKind,
  type StageId,
} from '@ted/protocol'
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

export type OvernightGuard = 'settings' | 'unreadable' | 'automation' | 'outsider'

export const overnightGuardTexts: Readonly<Record<OvernightGuard, string>> = {
  settings: 'this Task changes .ted/',
  unreadable: 'TED couldn’t read this Task’s changes',
  automation: 'an Automation created this Task',
  outsider: 'its GitHub issue has text from outsiders',
}

export interface ResolvedWorkflow {
  stages: StageId[]
  order: AgentStageId[]
  settings: WorkflowSettings
  overnightGates?: readonly AgentStageId[]
  overnightKept?: { reason: OvernightGuard; stages: readonly AgentStageId[]; unseen?: boolean }
  notes?: string
  stageFile(id: AgentStageId): ResolvedStageFile | undefined
  next(current: StageId): StageId
}

const builtInOrder: readonly StageId[] = ['backlog', ...agentStageIds, 'done']
const agentKeys = ['lead', 'reviewer', 'planner'] as const
const lastWins = [
  'version',
  'permissions',
  'max_working_runs',
  'sandbox_sockets',
  'repos',
  'order',
] as const

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

  return built(settings, (id) => stageFiles.get(id), notes)
}

export function cleanupOn(settings: WorkflowSettings): boolean {
  const cleanup = settings.stages.cleanup
  return cleanup?.enabled === true && (cleanup.steps?.length ?? 0) > 0
}

function built(
  settings: WorkflowSettings,
  stageFile: (id: AgentStageId) => ResolvedStageFile | undefined,
  notes: string | undefined,
): ResolvedWorkflow {
  const enabled = (id: StageId) => settings.stages[id]?.enabled !== false
  const order: AgentStageId[] = [
    ...(settings.order ?? ['intake', 'work']).filter((id) => id !== 'cleanup'),
    ...(cleanupOn(settings) ? (['cleanup'] as const) : []),
  ]
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
    stageFile,
    next(current) {
      if (current === 'done') return 'done'
      const index = stages.indexOf(current)
      if (index !== -1) return stages[index + 1] ?? 'done'
      const rank = builtInOrder.indexOf(current)
      return stages.find((id) => id !== 'backlog' && builtInOrder.indexOf(id) > rank) ?? 'done'
    },
  }
}

export function withTaskGates(
  workflow: ResolvedWorkflow,
  overrides: import('@ted/protocol').TaskGateOverrides = {},
): ResolvedWorkflow {
  const stages = { ...workflow.settings.stages }
  for (const id of agentStageIds) {
    if (overrides[id] !== undefined && workflow.stages.includes(id)) {
      stages[id] = { ...stages[id], gate: overrides[id] }
    }
  }
  return { ...workflow, settings: { ...workflow.settings, stages } }
}

export function withoutGates(workflow: ResolvedWorkflow): {
  workflow: ResolvedWorkflow
  off: AgentStageId[]
} {
  const stages = { ...workflow.settings.stages }
  const off = agentStageIds.filter(
    (id) => workflow.stages.includes(id) && stages[id]?.gate === true,
  )
  for (const id of off) stages[id] = { ...stages[id], gate: false }
  return { workflow: { ...workflow, settings: { ...workflow.settings, stages } }, off }
}

export function withForcedGates(
  workflow: ResolvedWorkflow,
  forced: readonly AgentStageId[],
): ResolvedWorkflow {
  if (forced.length === 0) return workflow
  const rank = (id: StageId) => builtInOrder.indexOf(id)
  const stages = { ...workflow.settings.stages }
  const order = [...workflow.order]
  for (const id of forced) {
    stages[id] = { ...stages[id], enabled: true, gate: true }
    if (order.includes(id)) continue
    const before = order.findIndex((other) => other !== 'intake' && rank(other) > rank(id))
    if (before === -1) order.push(id)
    else order.splice(before, 0, id)
  }
  const included: StageId[] = [
    ...(workflow.stages.includes('backlog') ? (['backlog'] as const) : []),
    ...order.filter((id) => stages[id]?.enabled !== false),
    'done',
  ]
  return {
    ...workflow,
    stages: included,
    order,
    settings: { ...workflow.settings, stages, order },
    next(current) {
      if (current === 'done') return 'done'
      const index = included.indexOf(current)
      if (index !== -1) return included[index + 1] ?? 'done'
      return included.find((id) => id !== 'backlog' && rank(id) > rank(current)) ?? 'done'
    },
  }
}

export function onDefaultBranch(workflow: ResolvedWorkflow): ResolvedWorkflow {
  const [primary, ...rest] = workflow.settings.repos ?? []
  if (primary?.base_branch === undefined) return workflow
  const { base_branch: _, ...kept } = primary
  return { ...workflow, settings: { ...workflow.settings, repos: [kept, ...rest] } }
}

const setupForced: Partial<Record<AgentStageId, StageSettings>> = {
  clarify: { enabled: true, depth: 'grilling' },
  design: { enabled: true, gate: true },
  review: { enabled: true, gate: true },
}

export function setupWorkflow(
  workflow: ResolvedWorkflow,
  instructions?: (stage: AgentStageId) => string,
): ResolvedWorkflow {
  const order = [...workflow.order]
  for (const id of Object.keys(setupForced) as AgentStageId[]) {
    if (order.includes(id)) continue
    const rank = builtInOrder.indexOf(id)
    const before = order.findIndex((other) => builtInOrder.indexOf(other) > rank)
    order.splice(before === -1 ? order.length : before, 0, id)
  }
  const stages = { ...workflow.settings.stages }
  for (const [id, forced] of Object.entries(setupForced) as [AgentStageId, StageSettings][]) {
    stages[id] = { ...stages[id], ...forced }
  }
  const stageFile = (id: AgentStageId) => {
    const file = workflow.stageFile(id)
    const more = instructions?.(id)
    return file && more ? { ...file, text: `${file.text.trim()}\n\n${more}` } : file
  }
  const repos = workflow.settings.repos?.map((repo, i) => {
    if (i > 0) return repo
    const { base_branch: _, ...primary } = repo
    return primary
  })
  return built(
    { ...workflow.settings, order, stages, ...(repos && { repos }) },
    stageFile,
    workflow.notes,
  )
}

export function boardStages(workflow: ResolvedWorkflow, overnightMode = false): BoardStage[] {
  const { stages } = workflow.settings
  return (['backlog', ...workflow.order, 'done'] as StageId[]).map((id) => {
    const gate = id !== 'backlog' && id !== 'done' && stages[id]?.gate === true
    return {
      id,
      enabled: id === 'done' || stages[id]?.enabled !== false,
      gate,
      ...(gate && overnightMode && { overnight: true as const }),
    }
  })
}
