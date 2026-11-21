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
    channel: State.SQLite.text(),
  },
})

export const phoneRelaySent = State.SQLite.table({
  name: 'phoneRelaySent',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    rev: State.SQLite.integer(),
    keys: State.SQLite.json({ schema: Schema.Array(Schema.String) }),
    base: State.SQLite.text({ nullable: true }),
  },
})

export const phoneRelayAck = State.SQLite.table({
  name: 'phoneRelayAck',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    rev: State.SQLite.integer(),
    hash: State.SQLite.text(),
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

export const phoneTaskCreates = State.SQLite.table({
  name: 'phoneTaskCreates',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    phoneId: State.SQLite.text(),
    createId: State.SQLite.text(),
    taskId: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const phoneChatSends = State.SQLite.table({
  name: 'phoneChatSends',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    phoneId: State.SQLite.text(),
    createId: State.SQLite.text(),
    action: State.SQLite.text(),
    chatKind: State.SQLite.text(),
    chatId: State.SQLite.text(),
    queued: State.SQLite.boolean(),
    at: State.SQLite.text(),
  },
})

export function phoneTaskCreateId(phoneId: string, createId: string) {
  return JSON.stringify([phoneId, createId])
}

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
    schema: Schema.Struct({ id: Schema.String, at: Schema.String, channel: Schema.String }),
  }),
  phoneRelayListSent: Events.synced({
    name: 'v1.PhoneRelayListSent',
    schema: Schema.Struct({
      rev: Schema.Number,
      keys: Schema.Array(Schema.String),
      base: Schema.NullOr(Schema.String),
    }),
  }),
  phoneRelayListAcked: Events.synced({
    name: 'v1.PhoneRelayListAcked',
    schema: Schema.Struct({ rev: Schema.Number, hash: Schema.String }),
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
  phoneTaskCreated: Events.synced({
    name: 'v1.PhoneTaskCreated',
    schema: Schema.Struct({
      phoneId: Schema.String,
      createId: Schema.String,
      taskId: Schema.String,
      at: Schema.String,
    }),
  }),
  phoneChatSent: Events.synced({
    name: 'v1.PhoneChatSent',
    schema: Schema.Struct({
      phoneId: Schema.String,
      createId: Schema.String,
      action: Schema.String,
      chatKind: Schema.String,
      chatId: Schema.String,
      queued: Schema.Boolean,
      at: Schema.String,
    }),
  }),
}

export const phonesMaterializers = State.SQLite.materializers(phonesEvents, {
  'v1.PhonePaired': (row) => phones.insert(row),
  'v2.PhonePaired': (row) => phones.insert(row),
  'v1.PhoneRelayReset': (row) => [
    phoneRelayResets.insert(row),
    phoneRelaySent.delete().where({ id: 'relay' }),
    phoneRelayAck.delete().where({ id: 'relay' }),
  ],
  'v1.PhoneRelayListSent': ({ rev, keys, base }) =>
    phoneRelaySent.insert({ id: 'relay', rev, keys, base }).onConflict('id', 'replace'),
  'v1.PhoneRelayListAcked': ({ rev, hash }) =>
    phoneRelayAck.insert({ id: 'relay', rev, hash }).onConflict('id', 'replace'),
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
  'v1.PhoneTaskCreated': ({ phoneId, createId, taskId, at }) =>
    phoneTaskCreates
      .insert({ id: phoneTaskCreateId(phoneId, createId), phoneId, createId, taskId, at })
      .onConflict('id', 'ignore'),
  'v1.PhoneChatSent': (row) =>
    phoneChatSends
      .insert({ id: phoneTaskCreateId(row.phoneId, row.createId), ...row })
      .onConflict('id', 'ignore'),
})
