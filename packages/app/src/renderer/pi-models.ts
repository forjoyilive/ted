import { useEffect, useSyncExternalStore } from 'react'
import { ted } from './ted.ts'

let models: readonly string[] = []
let asking: Promise<void> | undefined
const listeners = new Set<() => void>()

export function refreshPiModels(): Promise<void> {
  asking ??= ted
    .agentModels('pi')
    .then(
      (found) => found.models,
      () => [],
    )
    .then((found) => {
      models = found
      for (const listener of listeners) listener()
    })
    .finally(() => {
      asking = undefined
    })
  return asking
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePiModels(active: boolean): readonly string[] {
  const listed = useSyncExternalStore(subscribe, () => models)
  useEffect(() => {
    if (active) void refreshPiModels()
  }, [active])
  return active ? listed : []
}
