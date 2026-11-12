export interface Fetches {
  fresh(clone: string): Promise<void>
  soon(clone: string): Promise<void>
}

export const backgroundFetchEveryMs = 60_000

export function createFetches(options: {
  fetch: (clone: string) => Promise<void>
  now?: () => number
  everyMs?: number
}): Fetches {
  const now = options.now ?? Date.now
  const everyMs = options.everyMs ?? backgroundFetchEveryMs
  const clones = new Map<string, { running?: Promise<void>; next?: Promise<void>; at?: number }>()

  function stateOf(clone: string) {
    let state = clones.get(clone)
    if (!state) {
      state = {}
      clones.set(clone, state)
    }
    return state
  }

  function start(clone: string): Promise<void> {
    const state = stateOf(clone)
    const running = options.fetch(clone).then(() => {
      state.at = now()
    })
    state.running = running
    const settle = () => {
      if (state.running === running) delete state.running
    }
    running.then(settle, settle)
    return running
  }

  return {
    fresh(clone) {
      const state = stateOf(clone)
      if (!state.running) return start(clone)
      if (!state.next) {
        const next = state.running
          .catch(() => undefined)
          .then(() => {
            delete state.next
            return start(clone)
          })
        state.next = next
      }
      return state.next
    },
    soon(clone) {
      const state = stateOf(clone)
      if (state.next) return state.next
      if (state.running) return state.running
      if (state.at !== undefined && now() - state.at < everyMs) return Promise.resolve()
      return start(clone)
    },
  }
}
