import { randomUUID } from 'node:crypto'
import { queryDb } from '@livestore/livestore'
import type { Edition } from '@ted/protocol'
import type { StoreContext } from './context.ts'
import { events, phoneNotificationId, phoneNotifications, phones, requestReturns } from './schema.ts'

export interface StoredPhone {
  id: string
  name: string
  publicKey: string
  edition: Edition
  pairedAt: string
}

export interface PhoneStore {
  list(): StoredPhone[]
  everPaired(): boolean
  get(id: string): StoredPhone | undefined
  byKey(publicKey: string): StoredPhone | undefined
  pair(input: { name: string; publicKey: string; edition: Edition; pairedAt: string }): StoredPhone
  remove(id: string, removedAt: string): boolean
  setPushToken(id: string, token: string): boolean
  clearPushToken(id: string): void
  pushToken(id: string): string | undefined
  notified(phoneId: string, requestId: string, waitingSince: string): boolean
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
  const list = (): StoredPhone[] =>
    live().map(({ removedAt: _, pushToken: __, ...row }) => ({
      ...row,
      edition: row.edition === 'release' ? 'release' : 'dev',
    }))
  const pushToken = (id: string) => live().find((row) => row.id === id)?.pushToken ?? undefined
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
      pair(input) {
        const phone = { id: randomUUID(), ...input }
        commit(events.phonePaired(phone))
        emit({ type: 'phones-changed' })
        return phone
      },
      remove(id, removedAt) {
        if (!list().some((phone) => phone.id === id)) return false
        commit(
          events.phoneRemoved({ id, removedAt }),
          ...(pushToken(id) === undefined ? [] : [events.phonePushTokenCleared({ phoneId: id })]),
        )
        emit({ type: 'phones-changed' })
        return true
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
