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

export type AgentStageId = (typeof agentStageIds)[number]

export type StageId = 'backlog' | AgentStageId | 'done'

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

const builtIn: Record<StageId, StageTraits> = {
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

export const builtInStageOrder: readonly StageId[] = ['backlog', ...agentStageIds, 'done']

export function isBuiltInStage(id: string): id is StageId {
  return Object.hasOwn(builtIn, id)
}

export function stageTraits(id: string): StageTraits {
  return isBuiltInStage(id) ? builtIn[id] : none
}

export function stageWith(trait: StageTrait): AgentStageId {
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

function place(id: string, order: readonly string[]): [number, number] {
  if (isBuiltInStage(id)) return [builtInStageOrder.indexOf(id), 0]
  const at = order.indexOf(id)
  if (at === -1) return [builtInStageOrder.indexOf(stageWith('handOff')) - 1, 1]
  const before = order
    .slice(0, at)
    .findLast((other) => isBuiltInStage(other) && !isHoldingStage(other))
  return [before === undefined ? 0 : builtInStageOrder.indexOf(before as StageId), 1 + at]
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
