import { type MacToRelay, parseRelayToMac, relayLoginText, toBase64Url } from '@ted/protocol'
import { isString, parseJson } from '@ted/protocol/parse'
import nacl from 'tweetnacl'
import { redactSecrets } from '../redact.ts'
import type { PhoneKeys } from './keys.ts'

export const relayDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000] as const

export interface RelayClientOptions {
  url: string
  keys: PhoneKeys
  onMessage(conn: number, data: string): void
  delaysMs?: readonly number[]
}

export interface RelayClient {
  start(): void
  stop(): void
  send(conn: number, data: string): void
  ready(): boolean
}

export function macSocketUrl(relay: string, channel: string): string {
  const url = new URL(`/v1/mac/${channel}`, relay)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

export function createRelayClient(options: RelayClientOptions): RelayClient {
  const delays = options.delaysMs ?? relayDelaysMs
  let socket: WebSocket | undefined
  let running = false
  let loggedIn = false
  let attempt = 0
  let timer: NodeJS.Timeout | undefined

  const write = (frame: MacToRelay) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
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
    let opened: WebSocket
    try {
      opened = new WebSocket(macSocketUrl(options.url, options.keys.channel))
    } catch (error) {
      console.error(redactSecrets(`couldn’t reach the phone relay: ${String(error)}`))
      retry()
      return
    }
    socket = opened
    opened.addEventListener('message', (event) => {
      if (socket !== opened || !isString(event.data)) return
      const frame = parseRelayToMac(parseJson(event.data))
      if (!frame) return
      if (frame.t === 'challenge') {
        const text = new TextEncoder().encode(relayLoginText(options.keys.channel, frame.nonce))
        write({
          t: 'login',
          key: toBase64Url(options.keys.sign.publicKey),
          sig: toBase64Url(nacl.sign.detached(text, options.keys.sign.secretKey)),
        })
      } else if (frame.t === 'ready') {
        loggedIn = true
        attempt = 0
      } else if (frame.t === 'msg' && loggedIn) {
        options.onMessage(frame.conn, frame.data)
      }
    })
    opened.addEventListener('close', () => {
      if (socket !== opened) return
      socket = undefined
      loggedIn = false
      retry()
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
      running = false
      loggedIn = false
      if (timer) clearTimeout(timer)
      timer = undefined
      const open = socket
      socket = undefined
      open?.close()
    },
    send(conn, data) {
      if (loggedIn) write({ t: 'msg', conn, data })
    },
    ready() {
      return loggedIn
    },
  }
}
