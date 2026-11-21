import {
  type Edition,
  edition as ourEdition,
  type PairedPhones,
  type PhonePairingOffer,
  type PhonePairingState,
  relayPhonesMax,
  relayUrl,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import type { PhoneStore } from '../store/index.ts'
import { createPhoneActions, type PhoneTaskChanges } from './actions.ts'
import { createPhoneBridge, type PhoneBridge } from './bridge.ts'
import { createPhoneImages, type PhoneImageOptions } from './images.ts'
import { loadPhoneKeys, type PhoneKeyrings, type PhoneKeys, replaceRelayKey } from './keys.ts'
import { computerName } from './mac-name.ts'
import { createPhoneNewTask, type PhoneTaskCreation } from './new-task.ts'
import { createPairings } from './pairings.ts'
import { type PhoneProblemSource, phoneProblems } from './problems.ts'
import { createRelayClient, type RelayClient } from './relay-client.ts'
import { createPhoneRequests, type PhoneInbox } from './requests.ts'
import { createPhoneTasks, type PhoneTaskSource } from './tasks.ts'

export interface PhonesOptions {
  phones: PhoneStore
  inbox: PhoneInbox
  tasks: PhoneTaskSource
  taskChanges: PhoneTaskChanges
  taskCreation: PhoneTaskCreation
  images: PhoneImageOptions
  problems: Pick<PhoneProblemSource, 'banners' | 'factoryName'>
  keyrings: PhoneKeyrings
  version: string
  relayUrl?: string
  edition?: Edition
  now?: () => number
  macName?: () => Promise<string>
  relayDelaysMs?: readonly number[]
  relayAnswerMs?: number
  relayListAckMs?: number
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
export const relayAnswerMs = 5_000

interface Ticket {
  pairing: string
  expiresAt: number
  endAt?: number
  endTimer?: NodeJS.Timeout
}

export function createPhones(options: PhonesOptions): Phones {
  const now = options.now ?? Date.now
  const edition = options.edition ?? ourEdition
  const relay = options.relayUrl ?? relayUrl()
  const pairings = createPairings(now, edition)
  const reached = new Map<string, string>()
  const requests = createPhoneRequests(options.inbox)
  const tasks = createPhoneTasks(options.tasks, now)
  const actions = createPhoneActions(options.taskChanges, tasks)
  const newTask = createPhoneNewTask(options.taskCreation, options.phones, tasks)
  const images = createPhoneImages(options.images)
  const tickets = new Map<string, Ticket>()
  const ending = new Map<string, number>()
  let keysLoaded: Promise<PhoneKeys> | undefined
  let connection: { relay: RelayClient; bridge: PhoneBridge; channel: string } | undefined
  let rotation: Promise<PhoneKeys> | undefined
  let watcher: NodeJS.Timeout | undefined
  let holdUntil = 0
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

  const rotate = () => {
    rotation ??= (async () => {
      const fresh = await replaceRelayKey(options.keyrings, await keys())
      keysLoaded = Promise.resolve(fresh)
      return fresh
    })().finally(() => {
      rotation = undefined
    })
    return rotation
  }

  const freshKeys = async () => {
    if (rotation) return rotation
    const loaded = await keys()
    return options.phones.latestReset()?.channel === loaded.channel ? rotate() : loaded
  }

  const ticketOf = (pairing: string) =>
    [...tickets].find(([, ticket]) => ticket.pairing === pairing)?.[0]

  const wanted = () =>
    !closed &&
    (pairings.live() ||
      now() < holdUntil ||
      [...ending.values()].some((until) => now() < until) ||
      (options.phones.everPaired() && !options.phones.pairAgain()))

  const disconnect = () => {
    connection?.relay.stop()
    connection = undefined
    ending.clear()
  }

  const pushList = () => {
    const client = connection?.relay
    if (!client) return
    const { rev, keys: relayKeys } = options.phones.relayList()
    client.sendList(rev, [...new Set(relayKeys)].slice(0, relayPhonesMax)).then(
      () => pairings.listed(rev),
      () => undefined,
    )
  }

  const endTicket = (hash: string) => {
    const ticket = tickets.get(hash)
    if (!ticket) return
    tickets.delete(hash)
    if (ticket.endTimer) clearTimeout(ticket.endTimer)
    pairings.ended(ticket.pairing)
    const client = connection?.relay
    if (!client) return
    ending.set(hash, ticket.expiresAt + pairingAnswerMs)
    watch()
    client.endTicket(hash).then(
      () => {
        ending.delete(hash)
        refresh()
      },
      () => ending.delete(hash),
    )
  }

  const endLater = (hash: string, at: number) => {
    const ticket = tickets.get(hash)
    if (!ticket || (ticket.endAt !== undefined && ticket.endAt <= at)) return
    if (ticket.endTimer) clearTimeout(ticket.endTimer)
    ticket.endAt = at
    ticket.endTimer = setTimeout(() => endTicket(hash), Math.max(0, at - now()))
    ticket.endTimer.unref()
  }

  const stopPairing = () => {
    const ticket = pairings.ticket()
    if (ticket && tickets.has(ticket.ticketHash)) {
      if (ticket.used) endLater(ticket.ticketHash, now() + pairingAnswerMs)
      else endTicket(ticket.ticketHash)
    }
    pairings.cancel()
  }

  const reset = () => {
    const channel = connection?.channel
    disconnect()
    if (channel === undefined) return
    reached.clear()
    pairings.cancel()
    for (const ticket of tickets.values()) if (ticket.endTimer) clearTimeout(ticket.endTimer)
    tickets.clear()
    holdUntil = 0
    options.phones.resetRelay({ at: new Date(now()).toISOString(), channel })
    rotate().then(refresh, () =>
      console.error(
        'Ted couldn’t make a new phone relay key; it will try before the next pairing.',
      ),
    )
  }

  const update = async () => {
    if (!wanted()) return disconnect()
    const loaded = await freshKeys()
    if (connection && connection.channel !== loaded.channel) disconnect()
    if (connection || !wanted()) return
    let relayClient: RelayClient | undefined
    const bridge = createPhoneBridge({
      keys: loaded,
      phones: options.phones,
      pairings,
      routes: {
        macName: nameOfMac,
        edition,
        version: options.version,
        requests,
        tasks,
        actions,
        newTask,
        images,
        problems: () => phoneProblems(options.problems),
        setPushToken: (phoneId, token) => options.phones.setPushToken(phoneId, token),
      },
      now,
      send: (conn, data) => relayClient?.send(conn, data),
      reached: (phoneId) => reached.set(phoneId, new Date(now()).toISOString()),
      candidate(pairing, relayKey) {
        const hash = ticketOf(pairing)
        if (hash) relayClient?.bindCandidate(hash, relayKey).catch(() => undefined)
      },
      pairingAnswered(pairing) {
        const hash = ticketOf(pairing)
        if (hash) endTicket(hash)
      },
    })
    relayClient = createRelayClient({
      url: relay,
      keys: loaded,
      acked: options.phones.relayAcked(),
      pending: options.phones.relayPending(),
      onListSent: (list) => options.phones.markRelaySent(list),
      onListAcked: (ack) => options.phones.markRelayAcked(ack),
      ...(options.relayListAckMs !== undefined && { ackMs: options.relayListAckMs }),
      onMessage(conn, data) {
        bridge.handle(conn, data).catch((error: Error) => {
          console.error(redactSecrets(`a phone message failed: ${String(error)}`))
        })
      },
      onListRefused(answer) {
        console.error(`the phone relay answered ${answer}; Ted is making a new relay key`)
        reset()
      },
      ...(options.relayDelaysMs && { delaysMs: options.relayDelaysMs }),
    })
    connection = { relay: relayClient, bridge, channel: loaded.channel }
    relayClient.start()
    pushList()
  }

  const refresh = () => {
    update().catch((error: Error) =>
      console.error(redactSecrets(`couldn’t connect to the phone relay: ${String(error)}`)),
    )
  }

  const watch = () => {
    if (watcher) clearTimeout(watcher)
    watcher = undefined
    const time = now()
    const live = pairings.ticket()
    const next = [
      ...(live && pairings.live() ? [live.expiresAt] : []),
      holdUntil,
      ...ending.values(),
    ]
      .filter((at) => at > time)
      .sort((a, b) => a - b)[0]
    if (next === undefined) return
    watcher = setTimeout(
      () => {
        refresh()
        watch()
      },
      next - time + 50,
    )
    watcher.unref()
  }

  const hold = (until: number) => {
    holdUntil = until
    watch()
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
    pairAgain: options.phones.pairAgain(),
  })

  return {
    async start() {
      if (options.phones.latestReset()) {
        freshKeys().catch(() =>
          console.error(
            'Ted couldn’t make a new phone relay key; it will try before the next pairing.',
          ),
        )
      }
      if (options.phones.everPaired() && !options.phones.pairAgain()) refresh()
    },
    async createPairing() {
      const loaded = await freshKeys().catch((error: Error) => {
        throw new RequestError(
          503,
          `Ted couldn’t use the Keychain to keep this Mac’s phone keys: ${error.message}`,
        )
      })
      stopPairing()
      const { offer, ticketHash } = pairings.create(loaded, relay)
      tickets.set(ticketHash, { pairing: offer.pairing, expiresAt: offer.expiresAt })
      endLater(ticketHash, offer.expiresAt + pairingAnswerMs)
      hold(offer.expiresAt + pairingAnswerMs)
      await update()
      const client = connection?.relay
      const unreachable = new RequestError(503, 'Ted can’t reach the phone relay.')
      if (!client) throw unreachable
      const { promise: timedOut, reject } = Promise.withResolvers<never>()
      const timer = setTimeout(() => reject(unreachable), options.relayAnswerMs ?? relayAnswerMs)
      try {
        await Promise.race([client.registerTicket(ticketHash, offer.expiresAt), timedOut])
        pairings.registered(offer.pairing)
      } catch {
        if (pairings.ticket()?.ticketHash === ticketHash) {
          stopPairing()
          hold(now())
          refresh()
        }
        throw unreachable
      } finally {
        clearTimeout(timer)
      }
      return offer
    },
    current: () => pairings.current(),
    cancel() {
      stopPairing()
      hold(now() + pairingAnswerMs)
      refresh()
      return pairings.current()
    },
    approve(pairing) {
      const phone = pairings.approve(pairing, options.phones.relayList().rev + 1)
      options.phones.pair({
        name: phone.name,
        publicKey: phone.key,
        relayKey: phone.relayKey,
        edition: phone.edition,
        pairedAt: new Date(now()).toISOString(),
      })
      const hash = ticketOf(pairing)
      if (hash) endLater(hash, now() + pairingAnswerMs)
      hold(now() + pairingAnswerMs)
      refresh()
      pushList()
      return pairings.current()
    },
    refuse(pairing) {
      pairings.refuse(pairing)
      const hash = ticketOf(pairing)
      if (hash) endLater(hash, now() + pairingAnswerMs)
      hold(now() + pairingAnswerMs)
      refresh()
      return pairings.current()
    },
    list,
    remove(id) {
      if (!options.phones.remove(id, new Date(now()).toISOString())) {
        throw new RequestError(404, 'No such phone')
      }
      reached.delete(id)
      pushList()
      refresh()
      return list()
    },
    close() {
      closed = true
      if (watcher) clearTimeout(watcher)
      for (const ticket of tickets.values()) if (ticket.endTimer) clearTimeout(ticket.endTimer)
      tickets.clear()
      pairings.cancel()
      disconnect()
    },
  }
}
