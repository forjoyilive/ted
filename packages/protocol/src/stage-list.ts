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
  return list.find((s) => s.id === id)?.name ?? stageDisplayName(id, recorded)
}

export function stageIndexIn(list: readonly BoardStage[], id: string): number {
  const at = list.findIndex((s) => s.id === id)
  return at === -1 ? list.length : at
}

export function mergeStageLists(lists: readonly (readonly BoardStage[])[]): BoardStage[] {
  const merged: BoardStage[] = defaultStageList.map((s) => ({ ...s, enabled: false }))
  for (const list of lists) {
    list.forEach((stage, i) => {
      const at = merged.findIndex((s) => s.id === stage.id)
      if (at !== -1) {
        const known = merged[at] as BoardStage
        const next: BoardStage = {
          ...known,
          enabled: known.enabled || stage.enabled,
          gate: known.gate || stage.gate,
        }
        if (!stage.removed) delete next.removed
        merged[at] = next
        return
      }
      const before = list.slice(0, i).findLast((s) => merged.some((m) => m.id === s.id))
      let place = before === undefined ? 0 : merged.findIndex((m) => m.id === before.id) + 1
      while (place < merged.length && !isBuiltInStage(merged[place]?.id ?? '')) place++
      merged.splice(place, 0, { ...stage })
    })
  }
  return merged
}
