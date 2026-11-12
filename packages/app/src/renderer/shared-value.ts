import { type EventChange, eventValue, type ValueUpdate } from './event-value.ts'

export interface Shared<T> {
  value: T | undefined
  loaded: boolean
  error: string | undefined
}

export interface SharedRequest<T, E> {
  load: () => Promise<T>
  event: (event: E) => EventChange<T | undefined>
}

interface Entry<T, E> {
  snapshot: Shared<T>
  users: Set<() => void>
  generation: number
  request: SharedRequest<T, E>
  source: ReturnType<typeof eventValue<T | undefined, E>> | undefined
}

const empty: Shared<never> = { value: undefined, loaded: false, error: undefined }

export function sharedValues<E>(options: {
  subscribe: (listener: (event: E) => void) => () => void
  describe: (error: unknown) => string
}) {
  const entries = new Map<string, Entry<unknown, E>>()
  const set = <T>(entry: Entry<T, E>, snapshot: Shared<T>) => {
    entry.snapshot = snapshot
    for (const notify of entry.users) notify()
  }
  const start = <T>(entry: Entry<T, E>) =>
    eventValue<T | undefined, E>({
      initial: entry.snapshot.value,
      load: entry.request.load,
      event: entry.request.event,
      subscribe: options.subscribe,
      changed: (value) => set(entry, { value, loaded: entry.snapshot.loaded, error: undefined }),
      loaded: () => set(entry, { ...entry.snapshot, loaded: true }),
      error: (error) => set(entry, { ...entry.snapshot, error: options.describe(error) }),
    })
  const find = <T>(key: string) => entries.get(key) as Entry<T, E> | undefined
  return {
    read<T>(key: string): Shared<T> {
      return find<T>(key)?.snapshot ?? empty
    },
    use<T>(
      key: string,
      generation: number,
      request: SharedRequest<T, E>,
      notify: () => void,
    ): () => void {
      let entry = find<T>(key)
      if (!entry) {
        entry = { snapshot: empty, users: new Set(), generation, request, source: undefined }
        entry.source = start(entry)
        entries.set(key, entry as Entry<unknown, E>)
      }
      const used = entry
      used.users.add(notify)
      return () => {
        used.users.delete(notify)
        if (used.users.size > 0) return
        used.source?.dispose()
        if (entries.get(key) === used) entries.delete(key)
      }
    },
    renew(key: string, generation: number): void {
      const entry = entries.get(key)
      if (!entry || entry.generation === generation) return
      entry.generation = generation
      entry.source?.dispose()
      if (entry.snapshot.error !== undefined) set(entry, { ...entry.snapshot, error: undefined })
      entry.source = start(entry)
    },
    refresh<T>(key: string): Promise<T | undefined> {
      return find<T>(key)?.source?.refresh() ?? Promise.resolve(undefined)
    },
    update<T>(key: string, change: ValueUpdate<T | undefined>): void {
      find<T>(key)?.source?.update(change)
    },
  }
}
