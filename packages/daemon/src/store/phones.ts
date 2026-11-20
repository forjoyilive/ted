import { randomUUID } from 'node:crypto'
import { queryDb } from '@livestore/livestore'
import type { Edition } from '@ted/protocol'
import type { StoreContext } from './context.ts'
import { events, phones } from './schema.ts'

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
}

export interface PhonesArea {
  phones: PhoneStore
}

export function phonesArea(ctx: StoreContext): PhonesArea {
  const { store, commit, emit } = ctx
  const rows = () => store.query(queryDb(phones.orderBy('pairedAt', 'asc')))
  const list = (): StoredPhone[] =>
    rows()
      .filter((row) => row.removedAt === null)
      .map(({ removedAt: _, ...row }) => ({
        ...row,
        edition: row.edition === 'release' ? 'release' : 'dev',
      }))
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
        commit(events.phoneRemoved({ id, removedAt }))
        emit({ type: 'phones-changed' })
        return true
      },
    },
  }
}
