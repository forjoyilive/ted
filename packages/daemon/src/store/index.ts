import { randomUUID } from 'node:crypto'
import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, queryDb } from '@livestore/livestore'
import type { AgentKind, ConversationEntry, DaemonEvent, Run, RunState, Task } from '@ted/protocol'
import { conversationEntries, events, runs, schema, tasks } from './schema.ts'

const placeholderFactory = { id: 'dev', key: 'DEV' }

export interface RunOutput {
  toOffset: number
  entries: ConversationEntry[]
  state?: RunState
}

export interface TedStore {
  createTask(input: { title: string }): Promise<Task>
  listTasks(): Task[]
  subscribe(listener: (event: DaemonEvent) => void): () => void
  startRun(input: {
    id: string
    agent: AgentKind
    sessionId: string
    prompt: string
    cwd: string
  }): Run
  recordRunOutput(runId: string, output: RunOutput): void
  getRun(id: string): Run | undefined
  listRuns(): Run[]
  runReadOffset(id: string): number
  conversation(runId: string): ConversationEntry[]
  close(): Promise<void>
}

export async function openStore({ directory }: { directory: string }): Promise<TedStore> {
  const store = await createStorePromise({
    schema,
    storeId: 'ted',
    adapter: makeAdapter({ storage: { type: 'fs', baseDirectory: directory } }),
    disableDevtools: true,
  })

  const allTasks = queryDb(tasks.orderBy('number', 'asc'))
  const allRuns = queryDb(runs.orderBy('startedAt', 'asc'))

  const toTask = (row: typeof tasks.Type): Task => ({
    ...row,
    displayId: `${placeholderFactory.key}-${row.number}`,
  })

  const toRun = ({ readOffset: _, ...row }: typeof runs.Type): Run => ({
    ...row,
    agent: row.agent as AgentKind,
    state: row.state as RunState,
  })

  const listTasks = () => store.query(allTasks).map(toTask)
  const runRow = (id: string) => store.query(queryDb(runs.where({ id }))).at(0)

  const listeners = new Set<(event: DaemonEvent) => void>()
  const emit = (event: DaemonEvent) => {
    for (const listener of listeners) listener(event)
  }

  return {
    async createTask({ title }) {
      const number = Math.max(0, ...listTasks().map((t) => t.number)) + 1
      const row = {
        id: randomUUID(),
        factoryId: placeholderFactory.id,
        number,
        title,
        createdAt: new Date().toISOString(),
      }
      store.commit(events.taskCreated(row))
      const task = toTask(row)
      emit({ type: 'task-created', task })
      return task
    },
    listTasks,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    startRun(input) {
      const row = { ...input, startedAt: new Date().toISOString() }
      store.commit(events.runStarted(row))
      return { ...row, state: 'working' }
    },
    recordRunOutput(runId, { toOffset, entries, state }) {
      const current = runRow(runId)
      if (!current) throw new Error(`no Run ${runId}`)
      store.commit(
        events.runOutputRead({ runId, toOffset, entries }),
        ...(state && state !== current.state
          ? [events.runStateChanged({ runId, state, at: new Date().toISOString() })]
          : []),
      )
    },
    getRun(id) {
      const row = runRow(id)
      return row && toRun(row)
    },
    listRuns: () => store.query(allRuns).map(toRun),
    runReadOffset: (id) => runRow(id)?.readOffset ?? 0,
    conversation: (runId) =>
      store
        .query(queryDb(conversationEntries.where({ runId }).orderBy('offset', 'asc')))
        .map(({ offset, line }) => ({ offset, line })),
    close: () => store.shutdownPromise(),
  }
}
