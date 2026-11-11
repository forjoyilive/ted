import { queryDb, type Store } from '@livestore/livestore'
import type { SideChat, TaskLead } from '@ted/protocol'
import { events, type schema, sideChats } from './schema.ts'

export interface StoredSideChat extends Omit<SideChat, 'chat' | 'available' | 'paused' | 'error'> {
  taskId: string
  factoryId: string
  lead: TaskLead
  digest: string
  contextSent: boolean
  outputAfter: number
  messageId?: string | undefined
  error?: string | undefined
}

export function createSideChatStore(options: {
  store: Store<typeof schema>
  commit: Store<typeof schema>['commit']
  changed: (sourceRunId: string) => void
}) {
  const list = () =>
    options.store.query(queryDb(sideChats)).map((row) => JSON.parse(row.data) as StoredSideChat)
  return {
    list,
    get: (id: string) => list().find((c) => c.sourceRunId === id),
    forRun: (id: string) => list().find((c) => c.id === id),
    save(value: StoredSideChat) {
      options.commit(
        events.sideChatChanged({ sourceRunId: value.sourceRunId, data: JSON.stringify(value) }),
      )
      options.changed(value.sourceRunId)
    },
    remove(sourceRunId: string) {
      const current = list().find((c) => c.sourceRunId === sourceRunId)
      if (!current) return
      options.commit(events.sideChatRemoved({ sourceRunId, runId: current.id }))
      options.changed(sourceRunId)
    },
  }
}
export type SideChatStore = ReturnType<typeof createSideChatStore>
