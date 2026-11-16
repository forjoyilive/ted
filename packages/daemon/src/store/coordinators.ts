import { queryDb, type Store } from '@livestore/livestore'
import type {
  CoordinatorConfirmation,
  CoordinatorReceipt,
  RunMessage,
  TaskLead,
} from '@ted/protocol'
import { coordinatorChange, receiptsKept } from './coordinator-change.ts'
import { coordinatorChats, events, type schema } from './schema.ts'

export interface PromptPart {
  id: string
  at: string
  start: number
  end: number
  from?: 'ted'
}

export interface StoredCoordinator {
  id: string
  factoryId: string
  runId: string
  runIds: string[]
  lead: TaskLead
  phase: 'ready' | 'queued' | 'working' | 'failed'
  opening: string
  startedAt?: string
  endedAt?: string
  error?: string | undefined
  receipts: CoordinatorReceipt[]
  confirmations?: CoordinatorConfirmation[]
  taskIds: string[]
  unsentMessages?: RunMessage[]
  launch?:
    | { prompt: string; sourceRunId: string; messages: RunMessage[]; parts?: PromptPart[] }
    | undefined
  prompts?: Record<string, PromptPart[]>
}

export interface CoordinatorStore {
  list(): StoredCoordinator[]
  get(id: string): StoredCoordinator | undefined
  find(id: string): StoredCoordinator | undefined
  chats(factoryId: string): StoredCoordinator[]
  forRun(runId: string): StoredCoordinator | undefined
  endedForRun(runId: string): StoredCoordinator | undefined
  save(value: StoredCoordinator, canceled?: readonly RunMessage[]): void
  reopen(id: string): void
  delete(id: string): void
}

type Row = { id: string; factoryId: string; endedAt: string | null; data: string }

const chatOf = (row: Row): StoredCoordinator => {
  const { endedAt: _ended, ...data } = JSON.parse(row.data) as StoredCoordinator
  return { ...data, id: row.id, ...(row.endedAt !== null && { endedAt: row.endedAt }) }
}

export function createCoordinatorStore(options: {
  store: Store<typeof schema>
  commit: Store<typeof schema>['commit']
  changed: (factoryId: string, chatId: string) => void
}): CoordinatorStore {
  const all = (where?: { factoryId: string } | { id: string }) =>
    options.store
      .query(queryDb(where ? coordinatorChats.where(where) : coordinatorChats))
      .map(chatOf)
  const list = () => all().filter((c) => c.endedAt === undefined)
  const find = (id: string) => all({ id })[0]
  return {
    list,
    get: (id) => {
      const c = find(id)
      return c?.endedAt === undefined ? c : undefined
    },
    find,
    chats: (factoryId) => all({ factoryId }),
    forRun: (id) => list().find((c) => c.runIds.includes(id)),
    endedForRun: (id) => all().find((c) => c.endedAt !== undefined && c.runIds.includes(id)),
    save(value, canceled = []) {
      const { endedAt: _ended, ...kept } = value
      const trimmed = { ...kept, receipts: value.receipts.slice(-receiptsKept) }
      const before = find(value.id)
      const { endedAt: _before, ...old } = before ?? {}
      const change = coordinatorChange(before && (old as Record<string, unknown>), trimmed)
      const writes = [
        ...(change
          ? [
              events.coordinatorChatChanged({
                id: value.id,
                factoryId: value.factoryId,
                ...change,
              }),
            ]
          : []),
        ...canceled.map(({ id, runId }) =>
          events.runMessageDeleted({ id, runId, at: new Date().toISOString() }),
        ),
      ]
      if (writes.length > 0) options.commit(...writes)
      options.changed(value.factoryId, value.id)
    },
    reopen(id) {
      const c = find(id)
      if (!c) return
      options.commit(events.coordinatorChatContinued({ id }))
      options.changed(c.factoryId, id)
    },
    delete(id) {
      const c = find(id)
      if (!c) return
      options.commit(events.coordinatorChatDeleted({ id, runIds: c.runIds }))
      options.changed(c.factoryId, id)
    },
  }
}

export function confirmationHeadline(c: Pick<CoordinatorConfirmation, 'kind' | 'tasks'>): string {
  const verb = c.kind === 'delete' ? 'Delete' : 'Archive'
  const ids = c.tasks.map((t) => t.displayId)
  return ids.length === 1 ? `${verb} ${ids[0]}?` : `${verb} ${ids.length} Tasks? ${ids.join(', ')}`
}
