import { type Clock, clockWait } from '../clock.ts'
import { RequestError } from '../errors.ts'

export type InFlightKind =
  | 'transition'
  | 'held'
  | 'starting'
  | 'checking'
  | 'deleting'
  | 'hierarchy'
  | 'stoppingForBlockers'
  | 'merging'

export type MarkKind = Exclude<InFlightKind, 'transition' | 'held'>

export interface TaskRef {
  id: string
  displayId: string
}

export interface InFlightOptions {
  clock: Clock
  onHold(taskId: string): void
  onHoldsFreed(taskId: string): void
  onReleased(): void
}

export interface InFlight {
  transition<T>(task: TaskRef, work: () => Promise<T>): Promise<T>
  transitionWhenFree<T>(
    task: TaskRef,
    work: () => Promise<T>,
    waitMs: number,
    current?: () => TaskRef,
  ): Promise<T>
  untilFree(taskId: string, waitMs: number): Promise<void>
  hold(taskId: string): () => void
  held(): string[]
  mark(ids: string | readonly string[], kind: MarkKind): () => void
  unmark(taskId: string, kind: MarkKind): void
  is(taskId: string, kind: InFlightKind): boolean
  busy(taskId: string, kinds: readonly InFlightKind[]): boolean
  inHierarchyWork(taskId: string): boolean
  refuseHierarchyWork(task: TaskRef): void
}

export function hierarchyRefusal(displayId: string): RequestError {
  return new RequestError(409, `${displayId} has a hierarchy operation underway; try again`)
}

export function createInFlight(options: InFlightOptions): InFlight {
  const { clock } = options
  const transitions = new Map<string, Promise<void>>()
  const holds = new Map<string, number>()
  const marks: Record<MarkKind, Set<string>> = {
    starting: new Set(),
    checking: new Set(),
    deleting: new Set(),
    hierarchy: new Set(),
    stoppingForBlockers: new Set(),
    merging: new Set(),
  }

  function is(taskId: string, kind: InFlightKind): boolean {
    if (kind === 'transition') return transitions.has(taskId)
    if (kind === 'held') return holds.has(taskId)
    return marks[kind].has(taskId)
  }

  function inHierarchyWork(taskId: string): boolean {
    return marks.hierarchy.has(taskId) || marks.deleting.has(taskId)
  }

  function refuseHierarchyWork(task: TaskRef): void {
    if (inHierarchyWork(task.id)) throw hierarchyRefusal(task.displayId)
  }

  async function transition<T>(task: TaskRef, work: () => Promise<T>): Promise<T> {
    refuseHierarchyWork(task)
    if (transitions.has(task.id)) {
      throw new RequestError(409, `${task.displayId} is already moving; try again`)
    }
    const done = Promise.withResolvers<void>()
    transitions.set(task.id, done.promise)
    try {
      return await work()
    } finally {
      transitions.delete(task.id)
      done.resolve()
      options.onReleased()
    }
  }

  async function waitFree(taskId: string, waitMs: number): Promise<boolean> {
    const deadline = clock.now() + waitMs
    for (let held = transitions.get(taskId); held; held = transitions.get(taskId)) {
      const left = deadline - clock.now()
      if (left <= 0) return false
      const timer = new AbortController()
      await Promise.race([held, clockWait(clock, left, timer.signal)])
      timer.abort()
    }
    return true
  }

  return {
    transition,
    async transitionWhenFree(task, work, waitMs, current = () => task) {
      if (!(await waitFree(task.id, waitMs))) {
        throw new RequestError(
          409,
          `${task.displayId} is still busy after waiting a minute. No answer was applied; try again when its current operation finishes.`,
        )
      }
      return transition(current(), work)
    },
    async untilFree(taskId, waitMs) {
      await waitFree(taskId, waitMs)
    },
    hold(taskId) {
      holds.set(taskId, (holds.get(taskId) ?? 0) + 1)
      options.onHold(taskId)
      let released = false
      return () => {
        if (released) return
        released = true
        const left = (holds.get(taskId) ?? 1) - 1
        if (left > 0) holds.set(taskId, left)
        else {
          holds.delete(taskId)
          options.onHoldsFreed(taskId)
        }
        options.onReleased()
      }
    },
    held: () => [...holds.keys()],
    mark(ids, kind) {
      const marked = typeof ids === 'string' ? [ids] : [...ids]
      for (const id of marked) marks[kind].add(id)
      let released = false
      return () => {
        if (released) return
        released = true
        for (const id of marked) marks[kind].delete(id)
      }
    },
    unmark(taskId, kind) {
      marks[kind].delete(taskId)
    },
    is,
    busy: (taskId, kinds) => kinds.some((kind) => is(taskId, kind)),
    inHierarchyWork,
    refuseHierarchyWork,
  }
}
