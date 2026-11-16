import { builtInStageOrder, isBuiltInStage, isCleanup, stageDisplayName } from './stage.ts'
import type { BoardStage } from './workflow.ts'

export const defaultStageList: readonly BoardStage[] = builtInStageOrder.map((id) => ({
  id,
  name: stageDisplayName(id),
  enabled: !isCleanup(id),
  gate: false,
}))

export function stageNameIn(
  list: readonly BoardStage[],
  id: string,
  recorded: Readonly<Record<string, string>> = {},
): string {
  if (Object.hasOwn(recorded, id)) return stageDisplayName(id, recorded)
  return list.find((s) => s.id === id)?.name ?? stageDisplayName(id)
}

export function stageIndexIn(list: readonly BoardStage[], id: string): number {
  const at = list.findIndex((s) => s.id === id)
  return at === -1 ? list.length : at
}

function insertAfter(
  merged: BoardStage[],
  at: number,
  stage: BoardStage,
  own: ReadonlySet<string>,
): number {
  let place = at + 1
  while (place < merged.length) {
    const next = merged[place]?.id ?? ''
    if (isBuiltInStage(next) || own.has(next)) break
    place++
  }
  merged.splice(place, 0, stage)
  return place
}

export function mergeStageLists(lists: readonly (readonly BoardStage[])[]): BoardStage[] {
  const merged: BoardStage[] = []
  for (const list of lists) {
    const own = new Set(list.map((s) => s.id))
    let after = -1
    for (const stage of list) {
      const at = merged.findIndex((s) => s.id === stage.id)
      if (at === -1) {
        after = insertAfter(merged, after, { ...stage }, own)
        continue
      }
      const known = merged[at] as BoardStage
      const next: BoardStage = {
        ...known,
        enabled: known.enabled || stage.enabled,
        gate: known.gate || stage.gate,
      }
      if (!stage.removed) delete next.removed
      merged[at] = next
      after = at
    }
  }
  for (const stage of defaultStageList) {
    if (merged.some((s) => s.id === stage.id)) continue
    const rank = builtInStageOrder.indexOf(stage.id as (typeof builtInStageOrder)[number])
    const before = merged.findLastIndex(
      (s) => isBuiltInStage(s.id) && builtInStageOrder.indexOf(s.id) < rank,
    )
    insertAfter(merged, before, { ...stage, enabled: false }, new Set())
  }
  return merged
}
