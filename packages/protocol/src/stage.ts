export const agentStageIds = [
  'intake',
  'clarify',
  'design',
  'work',
  'validate',
  'review',
  'merge',
  'cleanup',
] as const

export type BuiltInAgentStageId = (typeof agentStageIds)[number]

export type BuiltInStageId = 'backlog' | BuiltInAgentStageId | 'done'

export type AgentStageId = BuiltInAgentStageId | (string & {})

export type StageId = BuiltInStageId | (string & {})

export const maxCustomStageId = 40

export const maxStageName = 60

export function isCustomStageId(id: string): boolean {
  return id.length <= maxCustomStageId && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) && !isBuiltInStage(id)
}

export function isStageId(id: unknown): id is StageId {
  return typeof id === 'string' && (isBuiltInStage(id) || isCustomStageId(id))
}

export function stageFileId(file: string): AgentStageId | undefined {
  const match = /^stages\/(.+)\.md$/.exec(file)
  const id = match?.[1]
  if (id === undefined) return undefined
  return isCustomStageId(id) || agentStageIds.some((s) => s === id) ? id : undefined
}

export function stageDisplayName(id: string, names: Readonly<Record<string, string>> = {}): string {
  const named = Object.hasOwn(names, id) ? names[id] : undefined
  return named ?? id.charAt(0).toUpperCase() + id.slice(1)
}

export interface StageTraits {
  holding: boolean
  working: boolean
  entry: boolean
  clarifyRounds: boolean
  skippable: boolean
  designReview: boolean
  setupGate: boolean
  handOff: boolean
  validates: boolean
  signsOffCode: boolean
  bindsApproval: boolean
  merges: boolean
  cleanup: boolean
}

export type StageTrait = Exclude<keyof StageTraits, 'holding' | 'working'>

export type StagePhase = 'before' | 'at' | 'after'

const none: StageTraits = {
  holding: false,
  working: true,
  entry: false,
  clarifyRounds: false,
  skippable: false,
  designReview: false,
  setupGate: false,
  handOff: false,
  validates: false,
  signsOffCode: false,
  bindsApproval: false,
  merges: false,
  cleanup: false,
}

const holding: StageTraits = { ...none, holding: true, working: false }

const builtIn: Record<BuiltInStageId, StageTraits> = {
  backlog: holding,
  intake: { ...none, entry: true },
  clarify: { ...none, clarifyRounds: true, skippable: true },
  design: { ...none, skippable: true, designReview: true, setupGate: true },
  work: { ...none, handOff: true },
  validate: { ...none, validates: true },
  review: { ...none, setupGate: true, signsOffCode: true, bindsApproval: true },
  merge: { ...none, bindsApproval: true, merges: true },
  cleanup: { ...none, cleanup: true },
  done: holding,
}

export const builtInStageOrder: readonly BuiltInStageId[] = ['backlog', ...agentStageIds, 'done']

export function isBuiltInStage(id: string): id is BuiltInStageId {
  return Object.hasOwn(builtIn, id)
}

export function stageTraits(id: string): StageTraits {
  return isBuiltInStage(id) ? builtIn[id] : none
}

export function stageWith(trait: StageTrait): BuiltInAgentStageId {
  const found = agentStageIds.find((id) => builtIn[id][trait])
  if (found === undefined) throw new Error(`no Stage has ${trait}`)
  return found
}

export const isHoldingStage = (id: string): boolean => stageTraits(id).holding
export const isWorkingStage = (id: string): boolean => stageTraits(id).working
export const isEntryStage = (id: string): boolean => stageTraits(id).entry
export const hasClarifyRounds = (id: string): boolean => stageTraits(id).clarifyRounds
export const maySkip = (id: string): boolean => stageTraits(id).skippable
export const postsDesignReview = (id: string): boolean => stageTraits(id).designReview
export const setupGateStage = (id: string): boolean => stageTraits(id).setupGate
export const handsOff = (id: string): boolean => stageTraits(id).handOff
export const validates = (id: string): boolean => stageTraits(id).validates
export const signsOffCode = (id: string): boolean => stageTraits(id).signsOffCode
export const bindsApproval = (id: string): boolean => stageTraits(id).bindsApproval
export const mergesHere = (id: string): boolean => stageTraits(id).merges
export const isCleanup = (id: string): boolean => stageTraits(id).cleanup

export function defaultStagePriority(id: string): number {
  if (isCleanup(id)) return 2
  return mergesHere(id) ? 1 : 0
}

export const skipsBusyHoldByDefault = (id: string): boolean => isCleanup(id)

function place(id: string, order: readonly string[]): [number, number] {
  if (isBuiltInStage(id)) return [builtInStageOrder.indexOf(id), 0]
  const at = order.indexOf(id)
  if (at === -1) return [builtInStageOrder.indexOf(stageWith('handOff')) - 1, 1]
  const before = order
    .slice(0, at)
    .findLast((other) => isBuiltInStage(other) && !isHoldingStage(other))
  return [before === undefined ? 0 : builtInStageOrder.indexOf(before as BuiltInStageId), 1 + at]
}

export function compareStages(a: string, b: string, order: readonly string[] = []): number {
  const [aBase, aStep] = place(a, order)
  const [bBase, bStep] = place(b, order)
  return aBase - bBase || aStep - bStep
}

export function isPast(id: string, anchor: string, order: readonly string[] = []): boolean {
  return compareStages(id, anchor, order) > 0
}

export function stagePhase(id: string, order: readonly string[] = []): StagePhase {
  const step = compareStages(id, stageWith('handOff'), order)
  return step < 0 ? 'before' : step === 0 ? 'at' : 'after'
}

export function clarifyIsOver(id: string, order: readonly string[] = []): boolean {
  return isPast(id, stageWith('clarifyRounds'), order)
}

export function settingsStageOrder(order: readonly string[]): StageId[] {
  const rows: StageId[] = ['backlog', ...order.filter((id) => !isHoldingStage(id)), 'done']
  for (const id of builtInStageOrder) {
    if (rows.includes(id)) continue
    const at = rows.findIndex((other) => compareStages(other, id, order) > 0)
    rows.splice(at === -1 ? rows.length : at, 0, id)
  }
  return rows
}

export function stageEnabled(id: string, inOrder: boolean, enabled: boolean | undefined): boolean {
  if (isCleanup(id)) return enabled === true
  return inOrder && (isHoldingStage(id) || enabled !== false)
}
