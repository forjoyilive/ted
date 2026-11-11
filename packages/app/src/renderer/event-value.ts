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
  const publish = (next: T) => {
    value = next
    options.changed(next)
  }
  const update = (change: ValueUpdate<T>) => {
    if (!active) return
    pending?.push(change)
    publish(change(value))
  }
  const refresh = async (load = options.load) => {
    if (!active) return undefined
    clearTimeout(timer)
    const request = ++latest
    const changes: ValueUpdate<T>[] = []
    pending = changes
    try {
      const loaded = await load()
      if (!active || request !== latest) return undefined
      pending = undefined
      const baseline = options.reconcile ? options.reconcile(loaded, value) : loaded
      const next = changes.reduce<T>((current, change) => change(current), baseline)
      publish(next)
      options.loaded?.()
      return next
    } catch (error) {
      if (active && request === latest) {
        pending = undefined
        options.error?.(error)
      }
      return undefined
    }
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
      unsubscribe()
    },
  }
}
