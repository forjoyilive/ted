import type { BoardStage } from '@ted/protocol'
import {
  defaultStageList,
  mergeStageLists,
  stageIndexIn,
  stageNameIn,
} from '@ted/protocol/stage-list'

export interface Stages {
  of: (factoryId: string | undefined) => readonly BoardStage[]
  loaded: (factoryId: string) => boolean
  merged: readonly BoardStage[]
  name: (stage: string, factoryId?: string, recorded?: Readonly<Record<string, string>>) => string
  index: (stage: string, factoryId?: string) => number
  within: (factoryIds: readonly string[]) => Stages
}

export function stagesFrom(lists: Readonly<Record<string, readonly BoardStage[]>>): Stages {
  const all = Object.values(lists)
  const merged = all.length === 0 ? defaultStageList : mergeStageLists(all)
  const of = (factoryId: string | undefined) =>
    (factoryId !== undefined ? lists[factoryId] : undefined) ?? merged
  return {
    of,
    loaded: (factoryId) => Object.hasOwn(lists, factoryId),
    merged,
    name: (stage, factoryId, recorded) => {
      const own = of(factoryId)
      return stageNameIn(own.some((s) => s.id === stage) ? own : merged, stage, recorded)
    },
    index: (stage, factoryId) => stageIndexIn(of(factoryId), stage),
    within: (factoryIds) => {
      const some = Object.fromEntries(
        Object.entries(lists).filter(([id]) => factoryIds.includes(id)),
      )
      return Object.keys(some).length === 0 ? stagesFrom(lists) : stagesFrom(some)
    },
  }
}

export const defaultStages: Stages = stagesFrom({})
