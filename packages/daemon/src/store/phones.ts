import { randomUUID } from 'node:crypto'
import { queryDb } from '@livestore/livestore'
import { type Edition, relayListHash } from '@ted/protocol'
import type { StoreContext } from './context.ts'
import {
  events,
  phoneNotificationId,
  phoneNotifications,
  phoneRelayAck,
  phoneRelayResets,
  phoneRelaySent,
  phones,
  requestReturns,
} from './schema.ts'

export interface StoredPhone {
  id: string
  name: string
  publicKey: string
  edition: Edition
  pairedAt: string
  relayKey?: string
}

export interface RelayPhoneList {
  rev: number
  keys: string[]
}

export interface RelayListAck {
  rev: number
  hash: string
}

export interface RelaySentList {
  rev: number
  keys: string[]
  base: string | null
}

export interface RelayReset {
  at: string
  channel: string
}

export interface PhoneStore {
  list(): StoredPhone[]
  everPaired(): boolean
  get(id: string): StoredPhone | undefined
  byKey(publicKey: string): StoredPhone | undefined
  byRelayKey(relayKey: string): StoredPhone | undefined
  pair(input: {
    name: string
    publicKey: string
    relayKey: string
    edition: Edition
    pairedAt: string
  }): StoredPhone
  remove(id: string, removedAt: string): boolean
  relayList(): RelayPhoneList
  relayAcked(): RelayListAck | undefined
  markRelayAcked(ack: RelayListAck): void
  relayPending(): RelaySentList | undefined
  markRelaySent(list: RelaySentList): void
  resetRelay(reset: RelayReset): void
  latestReset(): RelayReset | undefined
  pairAgain(): boolean
  setPushToken(id: string, token: string): boolean
  clearPushToken(id: string): void
  pushToken(id: string): string | undefined
  notified(phoneId: string, requestId: string, waitingSince: string): boolean
  everNotified(phoneId: string, requestId: string): boolean
  markNotified(input: {
    phoneId: string
    requestId: string
    waitingSince: string
    at: string
  }): boolean
  waitingSince(request: { id: string; createdAt: string }): string
}

export interface PhonesArea {
  phones: PhoneStore
}

export function phonesArea(ctx: StoreContext): PhonesArea {
  const { store, commit, emit } = ctx
  const rows = () => store.query(queryDb(phones.orderBy('pairedAt', 'asc')))
  const live = () => rows().filter((row) => row.removedAt === null)
  const resets = () => store.query(queryDb(phoneRelayResets.orderBy('at', 'asc')))
  const list = (): StoredPhone[] =>
    live().map(({ removedAt: _, pushToken: __, relayKey, ...row }) => ({
      ...row,
      edition: row.edition === 'release' ? 'release' : 'dev',
      ...(relayKey !== null && { relayKey }),
    }))
  const pushToken = (id: string) => live().find((row) => row.id === id)?.pushToken ?? undefined
  const removals = (ids: string[], removedAt: string) =>
    ids.flatMap((id) => [
      events.phoneRemoved({ id, removedAt }),
      ...(pushToken(id) === undefined ? [] : [events.phonePushTokenCleared({ phoneId: id })]),
    ])
  const notified = (phoneId: string, requestId: string, waitingSince: string) =>
    store.query(
      queryDb(
        phoneNotifications.where({ id: phoneNotificationId(phoneId, requestId, waitingSince) }),
      ),
    ).length > 0
  return {
    phones: {
      list,
      everPaired: () => rows().length > 0,
      get: (id) => list().find((phone) => phone.id === id),
      byKey: (publicKey) => list().find((phone) => phone.publicKey === publicKey),
      byRelayKey: (relayKey) => list().find((phone) => phone.relayKey === relayKey),
      pair(input) {
        const phone = { id: randomUUID(), ...input }
        commit(events.phonePairedV2(phone))
        emit({ type: 'phones-changed' })
        return phone
      },
      remove(id, removedAt) {
        if (!list().some((phone) => phone.id === id)) return false
        commit(...removals([id], removedAt))
        emit({ type: 'phones-changed' })
        return true
      },
      relayList() {
        const all = rows()
        const removed = all.filter((row) => row.removedAt !== null).length
        return {
          rev: all.length + removed + resets().length,
          keys: list().flatMap((phone) => (phone.relayKey === undefined ? [] : [phone.relayKey])),
        }
      },
      relayAcked() {
        const row = store.query(queryDb(phoneRelayAck.where({ id: 'relay' })))[0]
        return row && { rev: row.rev, hash: row.hash }
      },
      markRelayAcked({ rev, hash }) {
        const row = store.query(queryDb(phoneRelayAck.where({ id: 'relay' })))[0]
        if (row?.rev === rev && row.hash === hash) return
        commit(events.phoneRelayListAcked({ rev, hash }))
      },
      relayPending() {
        const sent = store.query(queryDb(phoneRelaySent.where({ id: 'relay' })))[0]
        if (!sent) return undefined
        const acked = store.query(queryDb(phoneRelayAck.where({ id: 'relay' })))[0]
        if (acked?.rev === sent.rev && acked.hash === relayListHash(sent.rev, sent.keys)) {
          return undefined
        }
        return { rev: sent.rev, keys: [...sent.keys], base: sent.base }
      },
      markRelaySent(list) {
        commit(events.phoneRelayListSent({ ...list, keys: [...list.keys] }))
      },
      resetRelay({ at, channel }) {
        const ids = list().map((phone) => phone.id)
        commit(...removals(ids, at), events.phoneRelayReset({ id: randomUUID(), at, channel }))
        emit({ type: 'phones-changed' })
      },
      latestReset() {
        const row = resets().at(-1)
        return row && { at: row.at, channel: row.channel }
      },
      pairAgain() {
        const reset = resets().at(-1)
        const paired = rows().at(-1)
        return reset !== undefined && (paired === undefined || reset.at > paired.pairedAt)
      },
      setPushToken(id, token) {
        const phones = live()
        if (!phones.some((row) => row.id === id)) return false
        const changes = [
          ...phones
            .filter((row) => row.id !== id && row.pushToken === token)
            .map((row) => events.phonePushTokenCleared({ phoneId: row.id })),
          ...(pushToken(id) === token ? [] : [events.phonePushTokenSet({ phoneId: id, token })]),
        ]
        if (changes.length === 0) return true
        commit(...changes)
        emit({ type: 'phones-changed' })
        return true
      },
      clearPushToken(id) {
        if (pushToken(id) === undefined) return
        commit(events.phonePushTokenCleared({ phoneId: id }))
        emit({ type: 'phones-changed' })
      },
      pushToken,
      notified,
      everNotified: (phoneId, requestId) =>
        store.query(queryDb(phoneNotifications.where({ phoneId, requestId }))).length > 0,
      markNotified(input) {
        if (notified(input.phoneId, input.requestId, input.waitingSince)) return false
        commit(events.phoneNotified(input))
        return true
      },
      waitingSince(request) {
        const returned = store.query(queryDb(requestReturns.where({ requestId: request.id })))[0]
        return returned !== undefined && returned.at > request.createdAt
          ? returned.at
          : request.createdAt
      },
    },
  }
}
