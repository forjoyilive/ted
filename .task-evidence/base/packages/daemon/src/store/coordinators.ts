import { queryDb, type Store } from '@livestore/livestore'
import type { CoordinatorReceipt, RunMessage, TaskLead } from '@ted/protocol'
import { coordinators, events, type schema } from './schema.ts'

export interface PromptPart {
  id: string
  at: string
  start: number
  end: number
  from?: 'ted'
}

export interface StoredCoordinator {
  factoryId: string
  runId: string
  runIds: string[]
  lead: TaskLead
  phase: 'ready' | 'queued' | 'working' | 'failed'
  opening: string
  error?: string | undefined
  receipts: CoordinatorReceipt[]
  taskIds: string[]
  unsentMessages?: RunMessage[]
  launch?:
    | { prompt: string; sourceRunId: string; messages: RunMessage[]; parts?: PromptPart[] }
    | undefined
  prompts?: Record<string, PromptPart[]>
}

export interface CoordinatorStore {
  list(): StoredCoordinator[]
  get(factoryId: string): StoredCoordinator | undefined
  forRun(runId: string): StoredCoordinator | undefined
  save(value: StoredCoordinator, canceled?: readonly RunMessage[]): void
  remove(factoryId: string): void
}

export function createCoordinatorStore(options: {
  store: Store<typeof schema>
  commit: Store<typeof schema>['commit']
  changed: (factoryId: string) => void
}): CoordinatorStore {
  const list = () =>
    options.store
      .query(queryDb(coordinators))
      .map((row) => JSON.parse(row.data) as StoredCoordinator)
  return {
    list,
    get: (id) => list().find((c) => c.factoryId === id),
    forRun: (id) => list().find((c) => c.runIds.includes(id)),
    save(value, canceled = []) {
      options.commit(
        events.coordinatorChanged({ factoryId: value.factoryId, data: JSON.stringify(value) }),
        ...canceled.map(({ id, runId }) =>
          events.runMessageDeleted({ id, runId, at: new Date().toISOString() }),
        ),
      )
      options.changed(value.factoryId)
    },
    remove(factoryId) {
      const current = list().find((c) => c.factoryId === factoryId)
      options.commit(events.coordinatorRemoved({ factoryId, runIds: current?.runIds ?? [] }))
      options.changed(factoryId)
    },
  }
}
