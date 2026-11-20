import {
  type Edition,
  edition as ourEdition,
  type PairedPhones,
  type PhonePairingOffer,
  type PhonePairingState,
  relayUrl,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import type { PhoneStore } from '../store/index.ts'
import { createPhoneBridge, type PhoneBridge } from './bridge.ts'
import { loadPhoneKeys, type PhoneKeyrings, type PhoneKeys } from './keys.ts'
import { computerName } from './mac-name.ts'
import { createPairings } from './pairings.ts'
import { createRelayClient, type RelayClient } from './relay-client.ts'

export interface PhonesOptions {
  phones: PhoneStore
  keyrings: PhoneKeyrings
  version: string
  relayUrl?: string
  edition?: Edition
  now?: () => number
  macName?: () => Promise<string>
  relayDelaysMs?: readonly number[]
}

export interface Phones {
  start(): Promise<void>
  createPairing(): Promise<PhonePairingOffer>
  current(): PhonePairingState
  cancel(): PhonePairingState
  approve(pairing: string): PhonePairingState
  refuse(pairing: string): PhonePairingState
  list(): PairedPhones
  remove(id: string): PairedPhones
  close(): void
}

export const pairingAnswerMs = 120_000

export function createPhones(options: PhonesOptions): Phones {
  const now = options.now ?? Date.now
  const edition = options.edition ?? ourEdition
  const relay = options.relayUrl ?? relayUrl()
  const pairings = createPairings(now, edition)
  const reached = new Map<string, string>()
  let keysLoaded: Promise<PhoneKeys> | undefined
  let connection: { relay: RelayClient; bridge: PhoneBridge } | undefined
  let expiry: NodeJS.Timeout | undefined
  let closed = false
  let macName: Promise<string> | undefined
  const nameOfMac = () => {
    macName ??= (options.macName ?? computerName)()
    return macName
  }

  const keys = () => {
    keysLoaded ??= loadPhoneKeys(options.keyrings).catch((error: Error) => {
      keysLoaded = undefined
      throw error
    })
    return keysLoaded
  }

  const answering = () => {
    const at = pairings.expiresAt()
    return at !== undefined && now() < at + pairingAnswerMs
  }
  const wanted = () => !closed && (pairings.live() || answering() || options.phones.everPaired())

  const disconnect = () => {
    connection?.relay.stop()
    connection = undefined
  }

  const update = async () => {
    if (!wanted()) return disconnect()
    if (connection) return
    const loaded = await keys()
    if (connection || !wanted()) return
    let relayClient: RelayClient | undefined
    const bridge = createPhoneBridge({
      keys: loaded,
      phones: options.phones,
      pairings,
      routes: { macName: nameOfMac, edition, version: options.version },
      now,
      send: (conn, data) => relayClient?.send(conn, data),
      reached: (phoneId) => reached.set(phoneId, new Date(now()).toISOString()),
    })
    relayClient = createRelayClient({
      url: relay,
      keys: loaded,
      onMessage(conn, data) {
        bridge.handle(conn, data).catch((error: Error) => {
          console.error(redactSecrets(`a phone message failed: ${String(error)}`))
        })
      },
      ...(options.relayDelaysMs && { delaysMs: options.relayDelaysMs }),
    })
    connection = { relay: relayClient, bridge }
    relayClient.start()
  }

  const refresh = () => {
    update().catch((error: Error) =>
      console.error(redactSecrets(`couldn’t connect to the phone relay: ${String(error)}`)),
    )
  }

  const watchExpiry = () => {
    if (expiry) clearTimeout(expiry)
    const at = pairings.expiresAt()
    if (at === undefined) return
    if (now() >= at + pairingAnswerMs) return
    const next = now() < at ? at : at + pairingAnswerMs
    expiry = setTimeout(
      () => {
        refresh()
        watchExpiry()
      },
      Math.max(0, next - now()) + 50,
    )
    expiry.unref()
  }

  const list = (): PairedPhones => ({
    phones: options.phones.list().map((phone) => {
      const last = reached.get(phone.id)
      return {
        id: phone.id,
        name: phone.name,
        pairedAt: phone.pairedAt,
        ...(last !== undefined && { lastReachedAt: last }),
      }
    }),
  })

  return {
    async start() {
      if (options.phones.everPaired()) refresh()
    },
    async createPairing() {
      const loaded = await keys().catch((error: Error) => {
        throw new RequestError(
          503,
          `Ted couldn’t use the Keychain to keep this Mac’s phone keys: ${error.message}`,
        )
      })
      const offer = pairings.create(loaded, relay)
      watchExpiry()
      await update()
      return offer
    },
    current: () => pairings.current(),
    cancel() {
      pairings.cancel()
      watchExpiry()
      refresh()
      return pairings.current()
    },
    approve(pairing) {
      const phone = pairings.approve(pairing)
      options.phones.pair({
        name: phone.name,
        publicKey: phone.key,
        edition: phone.edition,
        pairedAt: new Date(now()).toISOString(),
      })
      refresh()
      return pairings.current()
    },
    refuse(pairing) {
      pairings.refuse(pairing)
      refresh()
      return pairings.current()
    },
    list,
    remove(id) {
      if (!options.phones.remove(id, new Date(now()).toISOString())) {
        throw new RequestError(404, 'No such phone')
      }
      reached.delete(id)
      refresh()
      return list()
    },
    close() {
      closed = true
      if (expiry) clearTimeout(expiry)
      pairings.cancel()
      disconnect()
    },
  }
}
