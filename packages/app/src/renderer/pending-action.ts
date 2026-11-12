import { useCallback, useRef, useState, useSyncExternalStore } from 'react'

export function isPromise(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  )
}

const actions = new Map<string, Promise<unknown>>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const changed = () => {
  for (const listener of listeners) listener()
}

export function usePendingAction(key?: string) {
  const current = useRef<Promise<unknown> | undefined>(undefined)
  const [pending, setPending] = useState(false)
  const snapshot = useCallback(() => (key === undefined ? undefined : actions.get(key)), [key])
  const shared = useSyncExternalStore(subscribe, snapshot)

  function run(action: () => unknown): Promise<unknown> | undefined {
    const active = key === undefined ? current.current : actions.get(key)
    if (active) return active
    const result = action()
    if (!isPromise(result)) return undefined
    const settled = Promise.resolve(result).finally(() => {
      if (key !== undefined) {
        if (actions.get(key) === settled) {
          actions.delete(key)
          changed()
        }
      } else if (current.current === settled) {
        current.current = undefined
        setPending(false)
      }
    })
    if (key !== undefined) {
      actions.set(key, settled)
      changed()
    } else {
      current.current = settled
      setPending(true)
    }
    return settled
  }

  return { pending: key === undefined ? pending : shared !== undefined, run }
}
