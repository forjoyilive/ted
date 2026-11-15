import { queryDb, type Store } from '@livestore/livestore'
import type {
  CoordinatorConfirmation,
  CoordinatorReceipt,
  RunMessage,
  TaskLead,
} from '@ted/protocol'
import { coordinatorChange, receiptsKept } from './coordinator-change.ts'
import { coordinatorConversations, coordinators, events, type schema } from './schema.ts'

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
  startedAt?: string
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

export interface SavedCoordinatorConversation {
  id: string
  startedAt: string
  endedAt: string
  chat: StoredCoordinator
}

export interface CoordinatorStore {
  list(): StoredCoordinator[]
  get(factoryId: string): StoredCoordinator | undefined
  forRun(runId: string): StoredCoordinator | undefined
  save(value: StoredCoordinator, canceled?: readonly RunMessage[]): void
  remove(factoryId: string): void
  conversations(factoryId: string): SavedCoordinatorConversation[]
  conversation(id: string): SavedCoordinatorConversation | undefined
  savedForRun(runId: string): SavedCoordinatorConversation | undefined
  keep(
    saved: SavedCoordinatorConversation,
    canceled: readonly RunMessage[],
    restore?: SavedCoordinatorConversation,
  ): void
  restore(saved: SavedCoordinatorConversation): void
  forget(id: string): void
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
  const saved = (factoryId?: string) =>
    options.store
      .query(
        queryDb(
          factoryId === undefined
            ? coordinatorConversations
            : coordinatorConversations.where({ factoryId }),
        ),
      )
      .map((row) => JSON.parse(row.data) as SavedCoordinatorConversation)
      .sort((a, b) => b.endedAt.localeCompare(a.endedAt))
  const continued = ({ id, chat }: SavedCoordinatorConversation) => [
    events.coordinatorConversationContinued({ id, factoryId: chat.factoryId }),
    events.coordinatorChanged({ factoryId: chat.factoryId, data: JSON.stringify(chat) }),
  ]
  return {
    list,
    get: (id) => list().find((c) => c.factoryId === id),
    forRun: (id) => list().find((c) => c.runIds.includes(id)),
    save(value, canceled = []) {
      const trimmed: StoredCoordinator = { ...value, receipts: value.receipts.slice(-receiptsKept) }
      const before = list().find((c) => c.factoryId === value.factoryId)
      const change = coordinatorChange(
        before as Record<string, unknown> | undefined,
        trimmed as unknown as Record<string, unknown>,
      )
      const writes = [
        ...(change ? [events.coordinatorPatched({ factoryId: value.factoryId, ...change })] : []),
        ...canceled.map(({ id, runId }) =>
          events.runMessageDeleted({ id, runId, at: new Date().toISOString() }),
        ),
      ]
      if (writes.length > 0) options.commit(...writes)
      options.changed(value.factoryId)
    },
    remove(factoryId) {
      const current = list().find((c) => c.factoryId === factoryId)
      options.commit(events.coordinatorRemoved({ factoryId, runIds: current?.runIds ?? [] }))
      options.changed(factoryId)
    },
    conversations: (factoryId) => saved(factoryId),
    conversation: (id) => saved().find((c) => c.id === id),
    savedForRun: (runId) => saved().find((c) => c.chat.runIds.includes(runId)),
    keep(value, canceled, restore) {
      const { factoryId } = value.chat
      options.commit(
        ...canceled.map(({ id, runId }) =>
          events.runMessageDeleted({ id, runId, at: new Date().toISOString() }),
        ),
        events.coordinatorConversationSaved({
          id: value.id,
          factoryId,
          endedAt: value.endedAt,
          data: JSON.stringify(value),
        }),
        ...(restore ? continued(restore) : []),
      )
      options.changed(factoryId)
    },
    restore(value) {
      options.commit(...continued(value))
      options.changed(value.chat.factoryId)
    },
    forget(id) {
      const value = saved().find((c) => c.id === id)
      if (!value) return
      options.commit(events.coordinatorConversationDeleted({ id, runIds: value.chat.runIds }))
      options.changed(value.chat.factoryId)
    },
  }
}

export function confirmationHeadline(c: Pick<CoordinatorConfirmation, 'kind' | 'tasks'>): string {
  const verb = c.kind === 'delete' ? 'Delete' : 'Archive'
  const ids = c.tasks.map((t) => t.displayId)
  return ids.length === 1 ? `${verb} ${ids[0]}?` : `${verb} ${ids.length} Tasks? ${ids.join(', ')}`
}
