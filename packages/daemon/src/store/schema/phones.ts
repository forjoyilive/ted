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
    pushToken: State.SQLite.text({ nullable: true }),
    relayKey: State.SQLite.text({ nullable: true }),
  },
})

export const phoneRelayResets = State.SQLite.table({
  name: 'phoneRelayResets',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    at: State.SQLite.text(),
  },
})

export const phoneNotifications = State.SQLite.table({
  name: 'phoneNotifications',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    phoneId: State.SQLite.text(),
    requestId: State.SQLite.text(),
    waitingSince: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export function phoneNotificationId(phoneId: string, requestId: string, waitingSince: string) {
  return JSON.stringify([phoneId, requestId, waitingSince])
}

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
  phonePairedV2: Events.synced({
    name: 'v2.PhonePaired',
    schema: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      publicKey: Schema.String,
      relayKey: Schema.String,
      edition: Schema.String,
      pairedAt: Schema.String,
    }),
  }),
  phoneRelayReset: Events.synced({
    name: 'v1.PhoneRelayReset',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  phoneRemoved: Events.synced({
    name: 'v1.PhoneRemoved',
    schema: Schema.Struct({ id: Schema.String, removedAt: Schema.String }),
  }),
  phonePushTokenSet: Events.synced({
    name: 'v1.PhonePushTokenSet',
    schema: Schema.Struct({ phoneId: Schema.String, token: Schema.String }),
  }),
  phonePushTokenCleared: Events.synced({
    name: 'v1.PhonePushTokenCleared',
    schema: Schema.Struct({ phoneId: Schema.String }),
  }),
  phoneNotified: Events.synced({
    name: 'v1.PhoneNotified',
    schema: Schema.Struct({
      phoneId: Schema.String,
      requestId: Schema.String,
      waitingSince: Schema.String,
      at: Schema.String,
    }),
  }),
}

export const phonesMaterializers = State.SQLite.materializers(phonesEvents, {
  'v1.PhonePaired': (row) => phones.insert(row),
  'v2.PhonePaired': (row) => phones.insert(row),
  'v1.PhoneRelayReset': (row) => phoneRelayResets.insert(row),
  'v1.PhoneRemoved': ({ id, removedAt }) => phones.update({ removedAt }).where({ id }),
  'v1.PhonePushTokenSet': ({ phoneId, token }) =>
    phones.update({ pushToken: token }).where({ id: phoneId }),
  'v1.PhonePushTokenCleared': ({ phoneId }) =>
    phones.update({ pushToken: null }).where({ id: phoneId }),
  'v1.PhoneNotified': ({ phoneId, requestId, waitingSince, at }) =>
    phoneNotifications
      .insert({
        id: phoneNotificationId(phoneId, requestId, waitingSince),
        phoneId,
        requestId,
        waitingSince,
        at,
      })
      .onConflict('id', 'ignore'),
})
