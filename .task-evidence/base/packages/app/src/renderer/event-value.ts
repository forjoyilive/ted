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
  let running = false
  let again = false
  let pending: ValueUpdate<T>[] | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let due = Number.POSITIVE_INFINITY
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
    const next = change(value)
    if (!Object.is(next, value)) publish(next)
  }
  const unschedule = () => {
    clearTimeout(timer)
    timer = undefined
    due = Number.POSITIVE_INFINITY
  }
  const refresh = (load = options.load): Promise<T | undefined> => {
    if (!active) return Promise.resolve(undefined)
    const result = new Promise<T | undefined>((resolve) => waiting.add(resolve))
    unschedule()
    again = false
    running = true
    const request = ++latest
    const changes: ValueUpdate<T>[] = []
    pending = changes
    void (async () => {
      try {
        const loaded = await load()
        if (!active || request !== latest) return
        running = false
        pending = undefined
        const baseline = options.reconcile ? options.reconcile(loaded, value) : loaded
        const next = changes.reduce<T>((current, change) => change(current), baseline)
        publish(next)
        options.loaded?.()
        settle(next)
      } catch (error) {
        if (!active || request !== latest) return
        running = false
        pending = undefined
        options.error?.(error)
        settle(undefined)
      }
      if (again) void refresh()
    })()
    return result
  }
  const reload = () => {
    if (running) again = true
    else void refresh()
  }
  const unsubscribe = options.subscribe((event) => {
    if (!active) return
    const change = options.event(event)
    if (typeof change === 'function') update(change)
    else if (change === 'reload') reload()
    else if (typeof change === 'number') {
      const at = Date.now() + change
      if (at >= due) return
      clearTimeout(timer)
      due = at
      timer = setTimeout(() => {
        unschedule()
        reload()
      }, change)
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
      unschedule()
      settle(undefined)
      unsubscribe()
    },
  }
}
