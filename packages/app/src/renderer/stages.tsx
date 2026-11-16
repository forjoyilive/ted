import type { BoardStage } from '@ted/protocol'
import { createContext, type ReactNode, useContext, useMemo, useRef } from 'react'
import { useEventValue } from './data.ts'
import { type Stages, stagesFrom } from './stage-names.ts'
import { type TedEvent, ted } from './ted.ts'

const StagesContext = createContext<Stages>(stagesFrom({}))

export const useStages = () => useContext(StagesContext)

function affects(event: TedEvent, lists: Readonly<Record<string, readonly BoardStage[]>>) {
  if (event.type === 'factory-stages-changed') return event.factoryId in lists
  if (event.type === 'task-deleted')
    return Object.values(lists).some((list) => list.some((s) => s.removed))
  if (event.type !== 'task-created' && event.type !== 'task-updated') return false
  const list = lists[event.task.factoryId]
  if (list === undefined) return false
  return !list.some((s) => s.id === event.task.stage) || list.some((s) => s.removed)
}

export function StagesProvider({
  factoryIds,
  children,
}: {
  factoryIds: readonly string[]
  children: ReactNode
}) {
  const shown = useRef<Record<string, BoardStage[]>>({})
  const key = factoryIds.join()
  const { value } = useEventValue<Record<string, BoardStage[]>>({
    initial: shown.current,
    key,
    load: async () =>
      Object.fromEntries(
        await Promise.all(
          key
            .split(',')
            .filter(Boolean)
            .map(async (id) => [id, (await ted.factoryBoard(id)).stages] as const),
        ),
      ),
    event: (event) => (affects(event, shown.current) ? 'reload' : undefined),
    error: (error) => console.error(error),
  })
  shown.current = value
  const stages = useMemo(() => stagesFrom(value), [value])
  return <StagesContext value={stages}>{children}</StagesContext>
}
