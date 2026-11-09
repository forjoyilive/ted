import { Events, makeSchema, Schema, State } from '@livestore/livestore'

export const tasks = State.SQLite.table({
  name: 'tasks',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    number: State.SQLite.integer(),
    title: State.SQLite.text(),
    createdAt: State.SQLite.text(),
  },
})

export const events = {
  taskCreated: Events.synced({
    name: 'v1.TaskCreated',
    schema: Schema.Struct({
      id: Schema.String,
      factoryId: Schema.String,
      number: Schema.Number,
      title: Schema.String,
      createdAt: Schema.String,
    }),
  }),
}

const materializers = State.SQLite.materializers(events, {
  'v1.TaskCreated': (task) => tasks.insert(task),
})

const state = State.SQLite.makeState({ tables: { tasks }, materializers })

export const schema = makeSchema({ events, state })
