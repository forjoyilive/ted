import { randomBytes } from 'node:crypto'
import {
  type MacToRelay,
  parseRelayToMac,
  relayAuth,
  relayAuthHeader,
  relayListHash,
  toBase64Url,
} from '@ted/protocol'
import { isString, parseJson } from '@ted/protocol/parse'
import nacl from 'tweetnacl'
import type { PhoneKeys } from './keys.ts'

export const relayDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000] as const

export type ListRefusal = 'phones-stale' | 'phones-conflict'
export type CandidateAnswer = 'bound' | 'gone'

export interface RelayListAck {
  rev: number
  hash: string
}

export interface SentList {
  rev: number
  keys: string[]
  base: string | null
}

export const relayListAckMs = 10_000

export interface RelayClientOptions {
  url: string
  keys: PhoneKeys
  acked: RelayListAck | undefined
  pending: SentList | undefined
  onMessage(conn: number, data: string): void
  onListSent(list: SentList): void
  onListAcked(ack: RelayListAck): void
  onListRefused(answer: ListRefusal, rev: number): void
  delaysMs?: readonly number[]
  ackMs?: number
}

export interface RelayClient {
  start(): void
  stop(): void
  send(conn: number, data: string): void
  ready(): boolean
  sendList(rev: number, keys: string[]): Promise<void>
  registerTicket(hash: string, expiresAt: number): Promise<void>
  bindCandidate(hash: string, key: string): Promise<CandidateAnswer>
  endTicket(hash: string): Promise<void>
}

interface Unanswered<T> {
  frame: MacToRelay
  answered: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

interface PhoneList {
  rev: number
  keys: string[]
}

export function macSocketUrl(relay: string, channel: string): string {
  const url = new URL(`/v1/mac/${channel}`, relay)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

function unanswered<T>(frame: MacToRelay): Unanswered<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { frame, answered: promise, resolve, reject }
}

export function createRelayClient(options: RelayClientOptions): RelayClient {
  const delays = options.delaysMs ?? relayDelaysMs
  const { keys } = options
  let socket: WebSocket | undefined
  let running = false
  let loggedIn = false
  let forwarding = false
  let attempt = 0
  let timer: NodeJS.Timeout | undefined
  let base = options.acked?.hash ?? null
  let ackedRev = options.acked?.rev
  let pending = options.pending
  let desired: PhoneList | undefined
  let inFlight: SentList | undefined
  let ackTimer: NodeJS.Timeout | undefined
  let listWaiters: { rev: number; resolve(): void; reject(error: Error): void }[] = []
  const tickets = new Map<string, Unanswered<void>>()
  const candidates = new Map<string, Unanswered<CandidateAnswer>>()
  const ends = new Map<string, Unanswered<void>>()

  const write = (frame: MacToRelay) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
  }

  const clearAckTimer = () => {
    if (ackTimer) clearTimeout(ackTimer)
    ackTimer = undefined
  }

  const sendDesired = () => {
    if (!loggedIn || inFlight) return
    let next = pending
    if (!next) {
      if (!desired) return
      next = { rev: desired.rev, keys: desired.keys, base }
      if (desired.rev !== ackedRev) {
        try {
          options.onListSent(next)
        } catch {
          console.error('Ted couldn’t record the phone list before sending it.')
          detach()
          return
        }
        pending = next
      }
    }
    inFlight = next
    write({ t: 'phones', rev: next.rev, keys: next.keys, base: next.base })
    const waiting = socket
    clearAckTimer()
    ackTimer = setTimeout(() => {
      if (socket === waiting) detach()
    }, options.ackMs ?? relayListAckMs)
    ackTimer.unref()
  }

  const ask = <T>(waiting: Map<string, Unanswered<T>>, hash: string, frame: MacToRelay) => {
    const known = waiting.get(hash)
    if (known) return known.answered
    const made = unanswered<T>(frame)
    waiting.set(hash, made)
    if (loggedIn) write(frame)
    return made.answered
  }

  const answer = <T>(waiting: Map<string, Unanswered<T>>, hash: string, value: T) => {
    waiting.get(hash)?.resolve(value)
    waiting.delete(hash)
  }

  const abandon = <T>(waiting: Map<string, Unanswered<T>>, hash: string, why: string) => {
    waiting.get(hash)?.reject(new Error(why))
    waiting.delete(hash)
  }

  const listAcked = (acked: SentList) => {
    clearAckTimer()
    const hash = relayListHash(acked.rev, acked.keys)
    try {
      options.onListAcked({ rev: acked.rev, hash })
    } catch {
      console.error('Ted couldn’t record that the phone relay took the list.')
      detach()
      return
    }
    inFlight = undefined
    pending = undefined
    forwarding = true
    ackedRev = acked.rev
    base = hash
    for (const waiting of listWaiters) if (waiting.rev <= acked.rev) waiting.resolve()
    listWaiters = listWaiters.filter((waiting) => waiting.rev > acked.rev)
    if (desired && desired.rev !== ackedRev) sendDesired()
  }

  const detach = () => {
    clearAckTimer()
    const old = socket
    socket = undefined
    loggedIn = false
    forwarding = false
    inFlight = undefined
    old?.close()
    retry()
  }

  const halt = (why: string) => {
    clearAckTimer()
    running = false
    loggedIn = false
    forwarding = false
    inFlight = undefined
    if (timer) clearTimeout(timer)
    timer = undefined
    const open = socket
    socket = undefined
    open?.close()
    for (const waiting of listWaiters) waiting.reject(new Error(why))
    listWaiters = []
    for (const hash of [...tickets.keys()]) abandon(tickets, hash, why)
    for (const hash of [...candidates.keys()]) abandon(candidates, hash, why)
    for (const hash of [...ends.keys()]) abandon(ends, hash, why)
  }

  const retry = () => {
    if (!running || timer) return
    const delay = delays[Math.min(attempt, delays.length - 1)] ?? 30_000
    attempt += 1
    timer = setTimeout(() => {
      timer = undefined
      connect()
    }, delay)
    timer.unref()
  }

  const connect = () => {
    if (!running) return
    loggedIn = false
    forwarding = false
    inFlight = undefined
    const url = macSocketUrl(options.url, keys.channel)
    let opened: WebSocket
    try {
      const login = relayAuth({
        mode: 'mac',
        route: 'mac',
        host: new URL(url).host,
        channel: keys.channel,
        at: Date.now(),
        nonce: toBase64Url(randomBytes(16)),
        key: keys.sign.publicKey,
        sign: (text) => nacl.sign.detached(text, keys.sign.secretKey),
      })
      // Node's WebSocket (undici) takes { headers }; the DOM typing in the app's tsconfig leaves it out.
      opened = Reflect.construct(WebSocket, [url, { headers: { [relayAuthHeader]: login } }])
    } catch {
      console.error('Ted couldn’t open a connection to the phone relay.')
      retry()
      return
    }
    socket = opened
    opened.addEventListener('message', (event) => {
      if (socket !== opened || !isString(event.data)) return
      const frame = parseRelayToMac(parseJson(event.data))
      if (!frame) return
      if (frame.t === 'ready') {
        loggedIn = true
        attempt = 0
        sendDesired()
        for (const waiting of [...tickets.values(), ...candidates.values(), ...ends.values()]) {
          write(waiting.frame)
        }
        return
      }
      if (!loggedIn) return
      if (frame.t === 'msg') {
        if (forwarding) options.onMessage(frame.conn, frame.data)
      } else if (frame.t === 'phones-ok') {
        if (inFlight?.rev === frame.rev) listAcked(inFlight)
      } else if (frame.t === 'phones-stale' || frame.t === 'phones-conflict') {
        const solicited =
          frame.t === 'phones-stale' ? inFlight !== undefined : inFlight?.rev === frame.rev
        if (!solicited) return
        halt(`the phone relay answered ${frame.t}`)
        options.onListRefused(frame.t, frame.rev)
      } else if (frame.t === 'pairing-ok') answer(tickets, frame.hash, undefined)
      else if (frame.t === 'pairing-candidate-ok') answer(candidates, frame.hash, 'bound')
      else if (frame.t === 'pairing-gone') answer(candidates, frame.hash, 'gone')
      else if (frame.t === 'pairing-end-ok') answer(ends, frame.hash, undefined)
    })
    opened.addEventListener('close', () => {
      if (socket === opened) detach()
    })
    opened.addEventListener('error', () => {
      if (socket === opened) opened.close()
    })
  }

  return {
    start() {
      if (running) return
      running = true
      attempt = 0
      connect()
    },
    stop() {
      halt('the phone relay connection stopped')
    },
    send(conn, data) {
      if (loggedIn) write({ t: 'msg', conn, data })
    },
    ready() {
      return loggedIn
    },
    sendList(rev, phoneKeys) {
      const { promise, resolve, reject } = Promise.withResolvers<void>()
      listWaiters.push({ rev, resolve, reject })
      desired = { rev, keys: phoneKeys }
      sendDesired()
      return promise
    },
    registerTicket(hash, expiresAt) {
      return ask(tickets, hash, { t: 'pairing', hash, expiresAt })
    },
    bindCandidate(hash, key) {
      return ask(candidates, hash, { t: 'pairing-candidate', hash, key })
    },
    endTicket(hash) {
      abandon(tickets, hash, 'the pairing ended')
      abandon(candidates, hash, 'the pairing ended')
      return ask(ends, hash, { t: 'pairing-end', hash })
    },
  }
}
