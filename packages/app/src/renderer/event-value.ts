export type ValueUpdate<T> = (current: T) => T
export type EventChange<T> = ValueUpdate<T> | 'reload' | number | undefined

export interface EventValueOptions<T, E> {
  initial: T
  load: () => Promise<T>
  subscribe: (listener: (event: E) => void) => () => void
  event: (event: E) => EventChange<T>
  reconcile?: (loaded: T, current: T) => T
  changed: (value: T) => void
  loaded?: () => void
  error?: (error: unknown) => void
}

export function eventValue<T, E>(options: EventValueOptions<T, E>) {
  let value = options.initial
  let active = true
  let latest = 0
  let pending: ValueUpdate<T>[] | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const waiting = new Set<(value: T | undefined) => void>()
  const settle = (next: T | undefined) => {
    for (const resolve of waiting) resolve(next)
    waiting.clear()
  }
  const publish = (next: T) => {
    value = next
    options.changed(next)
  }
  const update = (change: ValueUpdate<T>) => {
    if (!active) return
    pending?.push(change)
    publish(change(value))
  }
  const refresh = (load = options.load): Promise<T | undefined> => {
    if (!active) return Promise.resolve(undefined)
    const result = new Promise<T | undefined>((resolve) => waiting.add(resolve))
    clearTimeout(timer)
    const request = ++latest
    const changes: ValueUpdate<T>[] = []
    pending = changes
    void (async () => {
      try {
        const loaded = await load()
        if (!active || request !== latest) return
        pending = undefined
        const baseline = options.reconcile ? options.reconcile(loaded, value) : loaded
        const next = changes.reduce<T>((current, change) => change(current), baseline)
        publish(next)
        options.loaded?.()
        settle(next)
      } catch (error) {
        if (active && request === latest) {
          pending = undefined
          options.error?.(error)
          settle(undefined)
        }
      }
    })()
    return result
  }
  const unsubscribe = options.subscribe((event) => {
    if (!active) return
    const change = options.event(event)
    if (typeof change === 'function') update(change)
    else if (change === 'reload') void refresh()
    else if (typeof change === 'number') {
      clearTimeout(timer)
      latest++
      pending = undefined
      timer = setTimeout(() => void refresh(), change)
    }
  })
  void refresh()
  return {
    refresh,
    update,
    dispose() {
      active = false
      latest++
      pending = undefined
      clearTimeout(timer)
      settle(undefined)
      unsubscribe()
    },
  }
}
