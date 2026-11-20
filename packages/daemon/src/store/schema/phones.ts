import { Events, Schema, State } from '@livestore/livestore'

export const phones = State.SQLite.table({
  name: 'phones',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    name: State.SQLite.text(),
    publicKey: State.SQLite.text(),
    edition: State.SQLite.text(),
    pairedAt: State.SQLite.text(),
    removedAt: State.SQLite.text({ nullable: true }),
  },
})

export const phonesEvents = {
  phonePaired: Events.synced({
    name: 'v1.PhonePaired',
    schema: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      publicKey: Schema.String,
      edition: Schema.String,
      pairedAt: Schema.String,
    }),
  }),
  phoneRemoved: Events.synced({
    name: 'v1.PhoneRemoved',
    schema: Schema.Struct({ id: Schema.String, removedAt: Schema.String }),
  }),
}

export const phonesMaterializers = State.SQLite.materializers(phonesEvents, {
  'v1.PhonePaired': (row) => phones.insert(row),
  'v1.PhoneRemoved': ({ id, removedAt }) => phones.update({ removedAt }).where({ id }),
})
