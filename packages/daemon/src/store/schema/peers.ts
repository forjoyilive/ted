import { Events, Schema, State } from '@livestore/livestore'

export const peerMessages = State.SQLite.table({
  name: 'peerMessages',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    senderTaskId: State.SQLite.text(),
    senderRunId: State.SQLite.text(),
    recipientTaskId: State.SQLite.text(),
    operation: State.SQLite.text(),
    text: State.SQLite.text(),
    createdAt: State.SQLite.text(),
  },
})

export const peersEvents = {
  peerMessageSent: Events.synced({
    name: 'v1.PeerMessageSent',
    schema: Schema.Struct({
      id: Schema.String,
      factoryId: Schema.String,
      senderTaskId: Schema.String,
      senderRunId: Schema.String,
      recipientTaskId: Schema.String,
      operation: Schema.String,
      text: Schema.String,
      createdAt: Schema.String,
    }),
  }),
}

export const peersMaterializers = State.SQLite.materializers(peersEvents, {
  'v1.PeerMessageSent': (row) => peerMessages.insert(row),
})
