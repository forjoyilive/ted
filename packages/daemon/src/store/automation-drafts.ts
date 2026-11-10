import { randomUUID } from 'node:crypto'
import { queryDb, type Store } from '@livestore/livestore'
import type { AutomationPromptDraft, DraftAutomationPromptRequest } from '@ted/protocol'
import { automationPromptDrafts, events, type schema } from './schema.ts'

export interface StoredAutomationDraft extends AutomationPromptDraft {
  input: DraftAutomationPromptRequest
  createdAt: string
  updatedAt: string
}

export interface AutomationDraftStore {
  list(): StoredAutomationDraft[]
  get(id: string): StoredAutomationDraft | undefined
  create(factoryId: string, input: DraftAutomationPromptRequest): StoredAutomationDraft
  change(
    id: string,
    state: AutomationPromptDraft['state'],
    result?: { prompt?: string; error?: string },
  ): void
  remove(id: string): void
}

export function createAutomationDraftStore({
  store,
  commit,
}: {
  store: Store<typeof schema>
  commit: Store<typeof schema>['commit']
}): AutomationDraftStore {
  const read = (row: typeof automationPromptDrafts.Type): StoredAutomationDraft => ({
    id: row.id,
    factoryId: row.factoryId,
    state: row.state as AutomationPromptDraft['state'],
    input: JSON.parse(row.input) as DraftAutomationPromptRequest,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.prompt !== null && { prompt: row.prompt }),
    ...(row.error !== null && { error: row.error }),
  })
  const get = (id: string) => {
    const row = store.query(queryDb(automationPromptDrafts.where({ id })))[0]
    return row && read(row)
  }
  return {
    get,
    list: () => store.query(queryDb(automationPromptDrafts)).map(read),
    create(factoryId, input) {
      const id = randomUUID()
      commit(
        events.automationPromptDraftRequested({
          id,
          factoryId,
          input: JSON.stringify(input),
          at: new Date().toISOString(),
        }),
      )
      return get(id) as StoredAutomationDraft
    },
    change(id, state, result = {}) {
      commit(
        events.automationPromptDraftChanged({
          id,
          state,
          prompt: result.prompt ?? null,
          error: result.error ?? null,
          at: new Date().toISOString(),
        }),
      )
    },
    remove(id) {
      commit(events.automationPromptDraftRemoved({ id, at: new Date().toISOString() }))
    },
  }
}
