import type {
  AgentStageId,
  BoardStage,
  BuiltInAgentStageId,
  LayerKind,
  StageId,
} from '@ted/protocol'
import {
  compareStages,
  isBuiltInStage,
  isCleanup,
  isEntryStage,
  isPast,
  stageDisplayName,
  stageWith,
} from '@ted/protocol/stage'
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
  names: Readonly<Record<string, string>>
  missing?: readonly string[]
  recorded?: readonly string[]
  stageFile(id: AgentStageId): ResolvedStageFile | undefined
  name(id: StageId): string
  next(current: StageId, recorded?: readonly string[]): StageId
}

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
  const stageFiles = new Map<string, ResolvedStageFile>()
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

export const customMaxBack = 3

function built(
  given: WorkflowSettings,
  stageFile: (id: AgentStageId) => ResolvedStageFile | undefined,
  notes: string | undefined,
): ResolvedWorkflow {
  const order: AgentStageId[] = [
    ...(given.order ?? ['intake', 'work']).filter((id) => !isCleanup(id)),
    ...(cleanupOn(given) ? [stageWith('cleanup')] : []),
  ]
  const custom = order.filter((id) => !isBuiltInStage(id))
  const stageSettings = { ...given.stages }
  for (const id of custom) stageSettings[id] = { max_back: customMaxBack, ...stageSettings[id] }
  const settings = custom.length > 0 ? { ...given, stages: stageSettings } : given
  const missing = custom.filter((id) => stageFile(id) === undefined)
  const enabled = (id: StageId) => settings.stages[id]?.enabled !== false && !missing.includes(id)
  const stages: StageId[] = ['backlog', ...order.filter(enabled), 'done']
  const names = stageNames(settings, order)

  return {
    stages,
    order,
    settings,
    ...(notes !== undefined && { notes }),
    names,
    ...(missing.length > 0 && { missing }),
    stageFile,
    name: (id) => stageDisplayName(id, names),
    next: (current, recorded) => nextStage(stages, order, current, recorded),
  }
}

function stageNames(settings: WorkflowSettings, order: readonly string[]): Record<string, string> {
  const names: Record<string, string> = {}
  for (const id of order) {
    if (isBuiltInStage(id)) continue
    names[id] = settings.stages[id]?.name ?? stageDisplayName(id)
  }
  return names
}

export function nextStage(
  stages: readonly StageId[],
  order: readonly string[],
  current: StageId,
  recorded?: readonly string[],
): StageId {
  if (current === 'done') return 'done'
  const index = stages.indexOf(current)
  if (index !== -1) return stages[index + 1] ?? 'done'
  const at = recorded?.indexOf(current) ?? -1
  if (recorded && at !== -1) {
    const later = recorded.slice(at + 1).find((id) => id !== 'backlog' && stages.includes(id))
    if (later !== undefined) return later
  }
  const ranked = recorded && at !== -1 ? recorded : order
  return stages.find((id) => id !== 'backlog' && isPast(id, current, ranked)) ?? 'done'
}

export function withTaskGates(
  workflow: ResolvedWorkflow,
  overrides: import('@ted/protocol').TaskGateOverrides = {},
): ResolvedWorkflow {
  const stages = { ...workflow.settings.stages }
  for (const [id, gate] of Object.entries(overrides)) {
    if (gate !== undefined && workflow.stages.includes(id)) {
      stages[id] = { ...stages[id], gate }
    }
  }
  return { ...workflow, settings: { ...workflow.settings, stages } }
}

export function withoutGates(workflow: ResolvedWorkflow): {
  workflow: ResolvedWorkflow
  off: AgentStageId[]
} {
  const stages = { ...workflow.settings.stages }
  const off = workflow.order.filter(
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
  const stages = { ...workflow.settings.stages }
  const order = [...workflow.order]
  for (const id of forced) {
    if (!order.includes(id) && !isBuiltInStage(id)) continue
    stages[id] = { ...stages[id], enabled: true, gate: true }
    if (order.includes(id)) continue
    const before = order.findIndex(
      (other) => !isEntryStage(other) && isPast(other, id, workflow.order),
    )
    if (before === -1) order.push(id)
    else order.splice(before, 0, id)
  }
  const missing = workflow.missing ?? []
  const included: StageId[] = [
    'backlog',
    ...order.filter((id) => stages[id]?.enabled !== false && !missing.includes(id)),
    'done',
  ]
  return {
    ...workflow,
    stages: included,
    order,
    settings: { ...workflow.settings, stages, order },
    next: (current, recorded) => nextStage(included, order, current, recorded),
  }
}

export function isEarlierStage(workflow: ResolvedWorkflow, id: string, than: string): boolean {
  const { order } = workflow
  if (order.includes(id) && order.includes(than)) return order.indexOf(id) < order.indexOf(than)
  return isPast(than, id, workflow.recorded ?? order)
}

export function withRecorded(
  workflow: ResolvedWorkflow,
  recorded: readonly { stage: string; name?: string }[] | undefined,
): ResolvedWorkflow {
  if (!recorded) return workflow
  const ids = recorded.map((planned) => planned.stage)
  const earlier = Object.fromEntries(
    recorded.flatMap((planned) =>
      planned.name === undefined ? [] : [[planned.stage, planned.name]],
    ),
  )
  return {
    ...workflow,
    recorded: ids,
    name: (id) =>
      Object.hasOwn(workflow.names, id) || !Object.hasOwn(earlier, id)
        ? workflow.name(id)
        : stageDisplayName(id, earlier),
    next: (current, given) => workflow.next(current, given ?? ids),
  }
}

export function onDefaultBranch(workflow: ResolvedWorkflow): ResolvedWorkflow {
  const [primary, ...rest] = workflow.settings.repos ?? []
  if (primary?.base_branch === undefined) return workflow
  const { base_branch: _, ...kept } = primary
  return { ...workflow, settings: { ...workflow.settings, repos: [kept, ...rest] } }
}

const setupForced: Partial<Record<BuiltInAgentStageId, StageSettings>> = {
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
    const before = order.findIndex((other) => isPast(other, id, workflow.order))
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
  const cleanup = stageWith('cleanup')
  const listed = workflow.order.includes(cleanup) ? workflow.order : [...workflow.order, cleanup]
  return (['backlog', ...listed, 'done'] as StageId[]).map((id) => {
    const gate = id !== 'backlog' && id !== 'done' && stages[id]?.gate === true
    return {
      id,
      name: workflow.name(id),
      enabled: id === 'backlog' || id === 'done' || workflow.stages.includes(id),
      gate,
      ...(gate && overnightMode && { overnight: true as const }),
      ...(!isBuiltInStage(id) && { custom: true as const }),
    }
  })
}

export interface StageInUse {
  stage: StageId
  recorded: readonly { stage: string; name?: string }[] | undefined
}

export function withStagesInUse(
  stages: readonly BoardStage[],
  inUse: readonly StageInUse[],
): BoardStage[] {
  const list = [...stages]
  for (const { stage, recorded } of inUse) {
    if (list.some((s) => s.id === stage)) continue
    const order = recorded?.map((r) => r.stage) ?? list.map((s) => s.id)
    const at = list.findIndex((s) => compareStages(s.id, stage, order) > 0)
    const name = recorded?.find((r) => r.stage === stage)?.name
    const entry: BoardStage = {
      id: stage,
      name: isBuiltInStage(stage) ? stageDisplayName(stage) : (name ?? stageDisplayName(stage)),
      ...(!isBuiltInStage(stage) && { custom: true as const }),
      removed: true,
      enabled: false,
      gate: false,
    }
    list.splice(at === -1 ? list.length : at, 0, entry)
  }
  return list
}
