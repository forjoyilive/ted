import { createHash } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  fromBase64Url,
  type MacReply,
  type PairingLink,
  type PhoneRequest,
  parseMacReply,
  parseMacToRelay,
  parsePairingLink,
  parsePhoneEnvelope,
  parseRelayToPhone,
  phoneProtocolVersion,
  type RelayToMac,
  type RelayToPhone,
  relayLoginText,
  toBase64Url,
} from '@ted/protocol'
import { isObject, isString, parseJson } from '@ted/protocol/parse'
import nacl from 'tweetnacl'
import { type WebSocket as RelaySocket, WebSocketServer } from 'ws'
import type { Keyring } from '../../src/linear/keyring.ts'
import type { PhoneKeyrings } from '../../src/phones/keys.ts'

export interface RecordedFrame {
  from: 'mac' | 'phone' | 'relay'
  text: string
}

export interface RelayStub {
  url: string
  frames: RecordedFrame[]
  macReady(): Promise<void>
  close(): Promise<void>
}

export async function startRelayStub(): Promise<RelayStub> {
  const frames: RecordedFrame[] = []
  const server = http.createServer((_, res) => res.writeHead(404).end())
  const sockets = new WebSocketServer({ noServer: true })
  const channels = new Map<
    string,
    { mac?: RelaySocket | undefined; phones: Map<number, RelaySocket>; nextConn: number }
  >()
  let ready = Promise.withResolvers<void>()
  const channelOf = (name: string) => {
    let found = channels.get(name)
    if (!found) {
      found = { phones: new Map(), nextConn: 1 }
      channels.set(name, found)
    }
    return found
  }
  const send = (socket: RelaySocket, frame: RelayToMac | RelayToPhone) => {
    const text = JSON.stringify(frame)
    frames.push({ from: 'relay', text })
    socket.send(text)
  }

  server.on('upgrade', (req, socket, head) => {
    const match = /^\/v1\/(mac|phone)\/([A-Za-z0-9_-]{43})$/.exec(req.url ?? '')
    if (!match) return socket.destroy()
    const [, side, name = ''] = match
    sockets.handleUpgrade(req, socket, head, (ws) => {
      const channel = channelOf(name)
      if (side === 'mac') {
        const nonce = toBase64Url(nacl.randomBytes(32))
        let loggedIn = false
        send(ws, { t: 'challenge', nonce })
        ws.on('message', (raw) => {
          const text = raw.toString()
          frames.push({ from: 'mac', text })
          const frame = parseMacToRelay(JSON.parse(text))
          if (frame?.t === 'login' && !loggedIn) {
            const key = fromBase64Url(frame.key, 32)
            const sig = fromBase64Url(frame.sig, 64)
            const good =
              key !== undefined &&
              sig !== undefined &&
              toBase64Url(createHash('sha256').update(key).digest()) === name &&
              nacl.sign.detached.verify(
                new TextEncoder().encode(relayLoginText(name, nonce)),
                sig,
                key,
              )
            if (!good) return ws.close(4401)
            loggedIn = true
            channel.mac?.close(4409)
            channel.mac = ws
            send(ws, { t: 'ready' })
            for (const phone of channel.phones.values()) send(phone, { t: 'mac-online' })
            ready.resolve()
          } else if (frame?.t === 'msg' && loggedIn) {
            const phone = channel.phones.get(frame.conn)
            if (phone) send(phone, { t: 'msg', data: frame.data })
          } else {
            ws.close(4400)
          }
        })
        ws.on('close', () => {
          if (channel.mac !== ws) return
          channel.mac = undefined
          ready = Promise.withResolvers<void>()
          for (const phone of channel.phones.values()) send(phone, { t: 'mac-offline' })
        })
        return
      }
      const conn = channel.nextConn++
      channel.phones.set(conn, ws)
      send(ws, { t: channel.mac ? 'mac-online' : 'mac-offline' })
      ws.on('message', (raw) => {
        const text = raw.toString()
        frames.push({ from: 'phone', text })
        const frame = parseJson(text)
        if (!isObject(frame) || frame.t !== 'msg' || !isString(frame.data)) return ws.close(4400)
        if (!channel.mac) return send(ws, { t: 'mac-offline' })
        send(channel.mac, { t: 'msg', conn, data: frame.data })
      })
      ws.on('close', () => {
        channel.phones.delete(conn)
        if (channel.mac) send(channel.mac, { t: 'closed', conn })
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    frames,
    macReady: () => ready.promise,
    async close() {
      for (const client of sockets.clients) client.terminate()
      sockets.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

export interface MemoryKeyrings {
  keyrings: PhoneKeyrings
  secrets: Map<string, string>
}

export function memoryKeyrings(): MemoryKeyrings {
  const secrets = new Map<string, string>()
  const keyring = (account: string): Keyring => ({
    kind: 'macos-keychain',
    async get() {
      return secrets.get(account)
    },
    async set(secret) {
      secrets.set(account, secret)
    },
    async delete() {
      secrets.delete(account)
    },
  })
  return { keyrings: async (account) => keyring(account), secrets }
}

export type PhoneBody = PhoneRequest extends infer R
  ? R extends PhoneRequest
    ? Omit<R, 'protocol' | 'id' | 'at'>
    : never
  : never

export interface SealedMessage {
  id: string
  envelope: string
}

export class TestPhone {
  readonly keys: nacl.BoxKeyPair
  readonly link: PairingLink
  readonly replies: MacReply[] = []
  readonly online: Promise<void>
  #socket: WebSocket
  #now: () => number
  #waiting = new Map<string, (reply: MacReply) => void>()

  constructor(
    linkText: string,
    {
      now = Date.now,
      keys = nacl.box.keyPair(),
    }: { now?: () => number; keys?: nacl.BoxKeyPair } = {},
  ) {
    this.link = parsePairingLink(linkText)
    this.keys = keys
    this.#now = now
    const url = new URL(`/v1/phone/${this.link.channel}`, this.link.relay)
    url.protocol = 'ws:'
    this.#socket = new WebSocket(url)
    const online = Promise.withResolvers<void>()
    this.online = online.promise
    this.#socket.addEventListener('message', (event) => {
      const frame = parseRelayToPhone(JSON.parse(String(event.data)))
      if (frame?.t === 'mac-online') online.resolve()
      if (frame?.t !== 'msg') return
      const reply = this.open(frame.data)
      if (!reply) return
      this.replies.push(reply)
      this.#waiting.get(reply.id)?.(reply)
    })
  }

  publicKey(): string {
    return toBase64Url(this.keys.publicKey)
  }

  open(data: string): MacReply | undefined {
    const envelope = parsePhoneEnvelope(JSON.parse(data))
    const opened = nacl.box.open(
      fromBase64Url(envelope.box) ?? new Uint8Array(),
      fromBase64Url(envelope.nonce) ?? new Uint8Array(),
      fromBase64Url(envelope.from) ?? new Uint8Array(),
      this.keys.secretKey,
    )
    if (!opened) return undefined
    return parseMacReply(JSON.parse(new TextDecoder().decode(opened)))
  }

  seal(message: PhoneRequest, signer: nacl.BoxKeyPair = this.keys): string {
    const nonce = nacl.randomBytes(24)
    const macKey = fromBase64Url(this.link.macKey, 32) ?? new Uint8Array()
    const box = nacl.box(
      new TextEncoder().encode(JSON.stringify(message)),
      nonce,
      macKey,
      signer.secretKey,
    )
    return JSON.stringify({
      v: 1,
      from: toBase64Url(signer.publicKey),
      nonce: toBase64Url(nonce),
      box: toBase64Url(box),
    })
  }

  message(body: PhoneBody, protocol = phoneProtocolVersion): SealedMessage {
    const id = toBase64Url(nacl.randomBytes(16))
    const message: PhoneRequest = { protocol, id, at: this.#now(), ...body }
    return { id, envelope: this.seal(message) }
  }

  sendRaw(envelope: string): void {
    this.#socket.send(JSON.stringify({ t: 'msg', data: envelope }))
  }

  async ask(id: string, envelope: string): Promise<MacReply> {
    await this.online
    const { promise, resolve } = Promise.withResolvers<MacReply>()
    this.#waiting.set(id, resolve)
    this.sendRaw(envelope)
    return promise.finally(() => this.#waiting.delete(id))
  }

  async send(body: PhoneBody, protocol = phoneProtocolVersion): Promise<MacReply> {
    const { id, envelope } = this.message(body, protocol)
    return this.ask(id, envelope)
  }

  pair(name = 'Test Phone', edition: 'dev' | 'release' = 'dev', protocol = phoneProtocolVersion) {
    return this.send(
      { type: 'pair', pairing: this.link.pairing, secret: this.link.secret, name, edition },
      protocol,
    )
  }

  status(protocol = phoneProtocolVersion) {
    return this.send({ type: 'request', route: 'status' }, protocol)
  }

  close(): void {
    this.#socket.close()
  }
}
