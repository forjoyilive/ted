import type { AgentKind, QueuedForSlot, Run, RunSlots, SlotHolder } from '@ted/protocol'
import type { AgentHealthMonitor } from '../health/agent-health.ts'
import type { RunManager } from '../runs/run-manager.ts'
import type { TedStore } from '../store/index.ts'
import type { QueueEntry, QueueSource } from './queue.ts'

export interface RunQueue {
  addQueueSource(source: QueueSource): () => void
  slots(): Promise<RunSlots>
  publishedSlots?(): RunSlots | undefined
}

export interface StartGuard {
  begin(
    key: string,
    launch: () => Promise<void>,
    after: { failed?: (cause: unknown) => void; done: () => void },
  ): void
  has(key: string): boolean
  keys(): string[]
  get size(): number
  wait(key: string): Promise<void> | undefined
  all(): Promise<void>[]
}

export function startGuard(what: string): StartGuard {
  const starts = new Map<string, Promise<void>>()
  return {
    begin(key, launch, { failed, done }) {
      if (starts.has(key)) return
      starts.set(key, Promise.resolve())
      const work = launch()
        .catch(failed ?? ((cause) => console.error(`couldn’t start ${what} ${key}:`, cause)))
        .finally(() => {
          starts.delete(key)
          done()
        })
      starts.set(key, work)
    },
    has: (key) => starts.has(key),
    keys: () => [...starts.keys()],
    get size() {
      return starts.size
    },
    wait: (key) => starts.get(key),
    all: () => [...starts.values()],
  }
}

type OwnKind = 'planning' | 'automation' | 'automation-draft'
type Slot<K extends OwnKind> = Omit<Extract<SlotHolder, { kind: K }>, 'kind' | 'runs'>

export interface QueuedRunsSpec<K extends OwnKind> {
  kind: K
  what: string
  waiting(): Pick<QueueEntry, 'id' | 'rank' | 'factoryId' | 'priority' | 'skipsBusy' | 'pastLimits'>[]
  runnable(id: string): boolean
  launch(id: string): Promise<void>
  candidates(): string[]
  holds(id: string): boolean
  slot(id: string): Slot<K> | undefined
  isClosed?(): boolean
  done?(id: string): void
  starting?: StartGuard
}

export interface QueuedRuns {
  pump(): void
  starting: StartGuard
}

export function queuedRuns<K extends OwnKind>(
  queue: Pick<RunQueue, 'addQueueSource'>,
  spec: QueuedRunsSpec<K>,
): QueuedRuns {
  const starting = spec.starting ?? startGuard(spec.what)
  const source: QueueSource = {
    starting: () => starting.keys(),
    queued: () =>
      spec
        .waiting()
        .filter((item) => !starting.has(item.id))
        .map((item): QueueEntry => ({ ...item, kind: spec.kind })),
    runnable: (id) => spec.runnable(id),
    begin(id) {
      if (spec.isClosed?.()) return
      starting.begin(id, () => spec.launch(id), {
        done: () => (spec.done ? spec.done(id) : pump()),
      })
    },
    holders: () =>
      spec.candidates().flatMap((id): SlotHolder[] => {
        if (!starting.has(id) && !spec.holds(id)) return []
        const slot = spec.slot(id)
        // SAFETY: Slot<K> is the K member of SlotHolder without kind and runs, so adding both back gives that member.
        return slot ? [{ kind: spec.kind, ...slot, runs: 1 } as SlotHolder] : []
      }),
    describe(id, place) {
      const slot = spec.slot(id)
      // SAFETY: Slot<K> is the K member of QueuedForSlot without kind and place, so adding both back gives that member.
      return slot && ({ kind: spec.kind, place, ...slot } as QueuedForSlot)
    },
  }
  const pump = queue.addQueueSource(source)
  return { pump, starting }
}

export interface RunLimits {
  has(runId: string): boolean
  clear(runId: string): void
  paused(run: Run): boolean
  close(): void
}

export function runLimits(options: {
  store: Pick<TedStore, 'agentPauses' | 'getRun' | 'subscribe'>
  runs: Pick<RunManager, 'observe'>
  health: Pick<AgentHealthMonitor, 'onReady'>
  owns(runId: string): boolean
  isClosed(): boolean
  ready(agent: AgentKind): void
}): RunLimits {
  const { store, owns, isClosed } = options
  const limited = new Set<string>()
  const providerPaused = (agent: AgentKind) => store.agentPauses()[agent] !== undefined
  options.runs.observe({
    usage(run, signal) {
      if (!isClosed() && signal.limited && owns(run.id)) limited.add(run.id)
    },
    authFailed(run) {
      if (!isClosed() && owns(run.id)) limited.add(run.id)
    },
  })
  options.health.onReady((agent) => {
    if (isClosed()) return
    for (const runId of [...limited]) {
      const run = store.getRun(runId)
      if (!run || !providerPaused(run.agent)) limited.delete(runId)
    }
    options.ready(agent)
  })
  const unsubscribe = store.subscribe((event) => {
    if (!isClosed() && event.type === 'run-updated' && event.run.state === 'working')
      limited.delete(event.run.id)
  })
  return {
    has: (runId) => limited.has(runId),
    clear: (runId) => void limited.delete(runId),
    paused: (run) => limited.has(run.id) || providerPaused(run.agent),
    close: unsubscribe,
  }
}

export const processEndedText = 'The agent’s process ended before it finished its turn.'

export function afterProcessEnded(input: {
  stopped: boolean
  run: Pick<Run, 'sessionId'> | undefined
  resumedBefore: boolean
  lastLines: readonly string[]
}): { stopped: true } | { resume: string } | { fail: string } {
  if (input.stopped) return { stopped: true }
  const error = input.lastLines.findLast((l) => l.trim() !== '') ?? processEndedText
  return !input.resumedBefore && input.run?.sessionId !== undefined
    ? { resume: error }
    : { fail: error }
}

export function queuedRunStatus(
  run: Run | undefined,
  { waiting, limits }: { waiting: boolean; limits: RunLimits },
): 'queued' | 'ended' | 'waiting' | 'paused' | undefined {
  if (!run) return 'queued'
  if (run.state === 'finished') return 'ended'
  if (waiting || run.state === 'waiting') return 'waiting'
  if (limits.paused(run)) return 'paused'
  return undefined
}
