import { randomUUID } from 'node:crypto'
import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise, queryDb } from '@livestore/livestore'
import type { Task } from '@ted/protocol'
import { events, schema, tasks } from './schema.ts'

const placeholderFactory = { id: 'dev', key: 'DEV' }

export interface TedStore {
  createTask(input: { title: string }): Promise<Task>
  listTasks(): Task[]
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

  const toTask = (row: typeof tasks.Type): Task => ({
    ...row,
    displayId: `${placeholderFactory.key}-${row.number}`,
  })

  const listTasks = () => store.query(allTasks).map(toTask)

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
      return toTask(row)
    },
    listTasks,
    close: () => store.shutdownPromise(),
  }
}
