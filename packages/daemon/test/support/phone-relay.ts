import { createHash } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import {
  fromBase64Url,
  type MacReply,
  type MacToRelay,
  type PairingLink,
  type PhoneAnswer,
  type PhoneRequest,
  parseMacReply,
  parseMacToRelay,
  parsePairingLink,
  parsePhoneEnvelope,
  parseRelayAuth,
  parseRelayToPhone,
  phoneProtocolVersion,
  type RelayLogin,
  type RelayRoute,
  type RelayToMac,
  type RelayToPhone,
  relayAuth,
  relayAuthHeader,
  relayKeyProofText,
  relayLoginText,
  relayTicket,
  relayTicketHash,
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

export interface RecordedLogin {
  mode: string
  route: RelayRoute
  status: number
}

export interface StoredList {
  rev: number
  keys: string[]
}

interface Ticket {
  expiresAt: number
  candidate?: string
}

interface PhoneSocket {
  ws: RelaySocket
  key: string
  ticketHash?: string
}

interface Admission {
  status: number
  login?: RelayLogin
  ticketHash?: string
}

interface Channel {
  mac?: RelaySocket | undefined
  phones: Map<number, PhoneSocket>
  nextConn: number
  list?: StoredList
  tickets: Map<string, Ticket>
}

export interface RelayStub {
  url: string
  frames: RecordedFrame[]
  logins: RecordedLogin[]
  unanswered: Set<MacToRelay['t']>
  macReady(): Promise<void>
  macFrame(match: (frame: MacToRelay) => boolean): Promise<MacToRelay>
  list(channel: string): StoredList | undefined
  storeList(channel: string, list: StoredList): void
  dropMac(): void
  close(): Promise<void>
}

const loginWindowMs = 60_000

export async function startRelayStub(): Promise<RelayStub> {
  const frames: RecordedFrame[] = []
  const logins: RecordedLogin[] = []
  const unanswered = new Set<MacToRelay['t']>()
  const seen = new Set<string>()
  const macWaiters: { match: (frame: MacToRelay) => boolean; resolve(frame: MacToRelay): void }[] =
    []
  const channels = new Map<string, Channel>()
  let ready = Promise.withResolvers<void>()
  const server = http.createServer()
  const sockets = new WebSocketServer({ noServer: true })

  const channelOf = (name: string) => {
    let found = channels.get(name)
    if (!found) {
      found = { phones: new Map(), nextConn: 1, tickets: new Map() }
      channels.set(name, found)
    }
    return found
  }
  const send = (socket: RelaySocket, frame: RelayToMac | RelayToPhone) => {
    const text = JSON.stringify(frame)
    frames.push({ from: 'relay', text })
    socket.send(text)
  }

  const verified = (
    req: http.IncomingMessage,
    route: RelayRoute,
    channel: string,
  ): { login: RelayLogin; ticketHash?: string } | undefined => {
    const header = req.headers[relayAuthHeader.toLowerCase()]
    if (!isString(header)) return undefined
    let login: RelayLogin
    try {
      login = parseRelayAuth(header)
    } catch {
      return undefined
    }
    if (login.v !== 2) return undefined
    if ((login.mode === 'mac') !== (route === 'mac')) return undefined
    if (Math.abs(Date.now() - login.at) > loginWindowMs) return undefined
    const key = fromBase64Url(login.key, 32) ?? new Uint8Array()
    const ticket = login.ticket === undefined ? undefined : fromBase64Url(login.ticket, 32)
    const ticketHash = ticket && relayTicketHash(ticket)
    const text = relayLoginText({
      mode: login.mode,
      route,
      host: req.headers.host ?? '',
      channel,
      at: login.at,
      nonce: login.nonce,
      ...(ticketHash !== undefined && { ticketHash }),
    })
    const signed = nacl.sign.detached.verify(
      new TextEncoder().encode(text),
      fromBase64Url(login.sig, 64) ?? new Uint8Array(),
      key,
    )
    if (!signed) return undefined
    if (login.mode === 'mac' && toBase64Url(createHash('sha256').update(key).digest()) !== channel)
      return undefined
    return { login, ...(ticketHash !== undefined && { ticketHash }) }
  }

  const admit = (req: http.IncomingMessage, route: RelayRoute, name: string): Admission => {
    const checked = verified(req, route, name)
    if (!checked) return { status: 401 }
    const { login, ticketHash } = checked
    const channel = channelOf(name)
    let status = 200
    if (login.mode === 'phone') {
      if (!channel.list) status = 503
      else if (!channel.list.keys.includes(login.key)) status = 403
    } else if (login.mode === 'pairing') {
      const ticket = ticketHash === undefined ? undefined : channel.tickets.get(ticketHash)
      const open = [...channel.phones.values()].filter((each) => each.ticketHash === ticketHash)
      const allowed =
        ticket !== undefined &&
        (ticket.candidate === undefined
          ? Date.now() < ticket.expiresAt && open.length < 2
          : ticket.candidate === login.key)
      if (!allowed) status = 403
    }
    if (status === 200) {
      const used = `${login.key}.${login.nonce}`
      if (seen.has(used)) status = 401
      else seen.add(used)
    }
    logins.push({ mode: login.mode, route, status })
    return { status, login, ...(ticketHash !== undefined && { ticketHash }) }
  }

  const refuse = (socket: Duplex, status: number) => {
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nContent-Length: 0\r\n\r\n`)
  }

  const closeWhere = (channel: Channel, match: (phone: PhoneSocket) => boolean) => {
    for (const phone of channel.phones.values()) if (match(phone)) phone.ws.close(4403)
  }

  const answerMac = (ws: RelaySocket, channel: Channel, frame: MacToRelay) => {
    if (frame.t === 'phones') {
      const stored = channel.list
      if (stored && frame.rev < stored.rev) return send(ws, { t: 'phones-stale', rev: stored.rev })
      if (stored && frame.rev === stored.rev) {
        const same = JSON.stringify(stored.keys) === JSON.stringify(frame.keys)
        return send(ws, { t: same ? 'phones-ok' : 'phones-conflict', rev: frame.rev })
      }
      channel.list = { rev: frame.rev, keys: frame.keys }
      closeWhere(
        channel,
        (phone) => phone.ticketHash === undefined && !frame.keys.includes(phone.key),
      )
      return send(ws, { t: 'phones-ok', rev: frame.rev })
    }
    if (frame.t === 'pairing') {
      channel.tickets.set(frame.hash, { expiresAt: frame.expiresAt })
      for (const hash of [...channel.tickets.keys()].slice(0, -4)) channel.tickets.delete(hash)
      return send(ws, { t: 'pairing-ok', hash: frame.hash })
    }
    if (frame.t === 'pairing-candidate') {
      const ticket = channel.tickets.get(frame.hash)
      if (!ticket) return send(ws, { t: 'pairing-gone', hash: frame.hash })
      ticket.candidate = frame.key
      closeWhere(channel, (phone) => phone.ticketHash === frame.hash && phone.key !== frame.key)
      return send(ws, { t: 'pairing-candidate-ok', hash: frame.hash })
    }
    if (frame.t === 'pairing-end') {
      channel.tickets.delete(frame.hash)
      closeWhere(channel, (phone) => phone.ticketHash === frame.hash)
      return send(ws, { t: 'pairing-end-ok', hash: frame.hash })
    }
    const phone = channel.phones.get(frame.conn)
    if (phone) send(phone.ws, { t: 'msg', data: frame.data })
  }

  const openMac = (ws: RelaySocket, channel: Channel) => {
    channel.mac?.close(4409)
    channel.mac = ws
    send(ws, { t: 'ready' })
    for (const phone of channel.phones.values()) send(phone.ws, { t: 'mac-online' })
    ready.resolve()
    ws.on('message', (raw) => {
      if (channel.mac !== ws) return
      const text = raw.toString()
      frames.push({ from: 'mac', text })
      const frame = parseMacToRelay(parseJson(text))
      if (!frame) return ws.close(4400)
      for (const waiter of macWaiters.splice(0)) {
        if (waiter.match(frame)) waiter.resolve(frame)
        else macWaiters.push(waiter)
      }
      if (!unanswered.has(frame.t)) answerMac(ws, channel, frame)
    })
    ws.on('close', () => {
      if (channel.mac !== ws) return
      channel.mac = undefined
      ready = Promise.withResolvers<void>()
      for (const phone of channel.phones.values()) send(phone.ws, { t: 'mac-offline' })
    })
  }

  const openPhone = (ws: RelaySocket, channel: Channel, phone: PhoneSocket) => {
    if (phone.ticketHash === undefined) {
      closeWhere(channel, (other) => other.ticketHash === undefined && other.key === phone.key)
    }
    const conn = channel.nextConn++
    channel.phones.set(conn, phone)
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
  }

  server.on('request', (req, res) => {
    const match = /^\/v1\/phone\/([A-Za-z0-9_-]{43})\/check$/.exec(req.url ?? '')
    if (!match) return res.writeHead(404).end()
    res.writeHead(admit(req, 'check', match[1] ?? '').status).end()
  })

  server.on('upgrade', (req, socket, head) => {
    const match = /^\/v1\/(mac|phone)\/([A-Za-z0-9_-]{43})$/.exec(req.url ?? '')
    if (!match) return refuse(socket, 404)
    const route = match[1] === 'mac' ? 'mac' : 'phone'
    const name = match[2] ?? ''
    const { status, login, ticketHash } = admit(req, route, name)
    if (status !== 200 || !login) return refuse(socket, status)
    sockets.handleUpgrade(req, socket, head, (ws) => {
      const channel = channelOf(name)
      if (route === 'mac') return openMac(ws, channel)
      openPhone(ws, channel, {
        ws,
        key: login.key,
        ...(ticketHash !== undefined && { ticketHash }),
      })
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    frames,
    logins,
    unanswered,
    macReady: () => ready.promise,
    macFrame(match) {
      for (const { from, text } of frames) {
        const frame = from === 'mac' ? parseMacToRelay(parseJson(text)) : undefined
        if (frame && match(frame)) return Promise.resolve(frame)
      }
      const { promise, resolve } = Promise.withResolvers<MacToRelay>()
      macWaiters.push({ match, resolve })
      return promise
    },
    list: (channel) => channels.get(channel)?.list,
    storeList(channel, list) {
      channelOf(channel).list = list
    },
    dropMac() {
      for (const channel of channels.values()) channel.mac?.close(1012)
    },
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

export function ticketHashOf(link: PairingLink): string {
  return relayTicketHash(
    relayTicket(fromBase64Url(link.secret, 32) ?? new Uint8Array(), link.channel, link.pairing),
  )
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

export class RelayRefused extends Error {}

export class TestPhone {
  readonly keys: nacl.BoxKeyPair
  readonly relayKeys: nacl.SignKeyPair
  readonly link: PairingLink
  readonly replies: MacReply[] = []
  readonly closes: number[] = []
  #mode: 'pairing' | 'phone' = 'pairing'
  #socket: WebSocket | undefined
  #online: Promise<void> | undefined
  #closed = false
  #now: () => number
  #listeners = new Set<(data: string) => void>()

  constructor(
    linkText: string,
    {
      now = Date.now,
      keys = nacl.box.keyPair(),
      relayKeys = nacl.sign.keyPair(),
    }: { now?: () => number; keys?: nacl.BoxKeyPair; relayKeys?: nacl.SignKeyPair } = {},
  ) {
    this.link = parsePairingLink(linkText)
    this.keys = keys
    this.relayKeys = relayKeys
    this.#now = now
  }

  get online(): Promise<void> {
    if (this.#closed) return Promise.reject(new RelayRefused('this phone was closed'))
    if (this.#online) return this.#online
    const url = new URL(`/v1/phone/${this.link.channel}`, this.link.relay)
    url.protocol = 'ws:'
    const ticket =
      this.#mode === 'pairing'
        ? relayTicket(
            fromBase64Url(this.link.secret, 32) ?? new Uint8Array(),
            this.link.channel,
            this.link.pairing,
          )
        : undefined
    const login = relayAuth({
      mode: this.#mode,
      route: 'phone',
      host: url.host,
      channel: this.link.channel,
      at: Date.now(),
      nonce: toBase64Url(nacl.randomBytes(16)),
      key: this.relayKeys.publicKey,
      sign: (text) => nacl.sign.detached(text, this.relayKeys.secretKey),
      ...(ticket && { ticket }),
    })
    const socket = new WebSocket(url, { headers: { [relayAuthHeader]: login } })
    this.#socket = socket
    const online = Promise.withResolvers<void>()
    online.promise.catch(() => undefined)
    this.#online = online.promise
    socket.addEventListener('message', (event) => {
      const frame = parseRelayToPhone(JSON.parse(String(event.data)))
      if (frame?.t === 'mac-online') online.resolve()
      if (frame?.t !== 'msg') return
      for (const listener of this.#listeners) listener(frame.data)
      const reply = this.open(frame.data)
      if (reply) this.replies.push(reply)
    })
    socket.addEventListener('close', (event) => {
      this.closes.push(event.code)
      online.reject(new RelayRefused(`the relay closed the socket with ${event.code}`))
      if (this.#socket !== socket) return
      this.#socket = undefined
      this.#online = undefined
    })
    return online.promise
  }

  publicKey(): string {
    return toBase64Url(this.keys.publicKey)
  }

  relayKey(): string {
    return toBase64Url(this.relayKeys.publicKey)
  }

  relayProof(): string {
    const text = new TextEncoder().encode(relayKeyProofText(this.link.pairing, this.publicKey()))
    return toBase64Url(nacl.sign.detached(text, this.relayKeys.secretKey))
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

  async sendRaw(envelope: string): Promise<void> {
    await this.online
    this.#socket?.send(JSON.stringify({ t: 'msg', data: envelope }))
  }

  async ask(id: string, envelope: string, carrier: TestPhone = this): Promise<MacReply> {
    const { promise, resolve } = Promise.withResolvers<MacReply>()
    const listener = (data: string) => {
      const reply = this.open(data)
      if (reply?.id === id) resolve(reply)
    }
    carrier.#listeners.add(listener)
    try {
      await carrier.sendRaw(envelope)
      return await promise
    } finally {
      carrier.#listeners.delete(listener)
    }
  }

  async send(
    body: PhoneBody,
    protocol = phoneProtocolVersion,
    carrier: TestPhone = this,
  ): Promise<MacReply> {
    const { id, envelope } = this.message(body, protocol)
    return this.ask(id, envelope, carrier)
  }

  pair(
    name = 'Test Phone',
    edition: 'dev' | 'release' = 'dev',
    protocol = phoneProtocolVersion,
    relay: { relayKey?: string; relayProof?: string } = {},
  ) {
    return this.send(
      {
        type: 'pair',
        pairing: this.link.pairing,
        secret: this.link.secret,
        name,
        edition,
        relayKey: relay.relayKey ?? this.relayKey(),
        relayProof: relay.relayProof ?? this.relayProof(),
      },
      protocol,
    )
  }

  pairStatus() {
    return this.send({ type: 'pair-status', pairing: this.link.pairing })
  }

  async approved(): Promise<void> {
    for (;;) {
      const reply = await this.pairStatus()
      if (!reply.ok) throw new Error(`pair-status failed: ${reply.error.code}`)
      if (reply.body.state === 'approved') break
      if (reply.body.state !== 'waiting') throw new Error(`pairing ${String(reply.body.state)}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    this.#mode = 'phone'
    const socket = this.#socket
    this.#socket = undefined
    this.#online = undefined
    socket?.close()
  }

  status(protocol = phoneProtocolVersion) {
    return this.send({ type: 'request', route: 'status' }, protocol)
  }

  requests(carrier: TestPhone = this) {
    return this.send({ type: 'request', route: 'requests' }, phoneProtocolVersion, carrier)
  }

  request(requestId: string) {
    return this.send({ type: 'request', route: 'request', requestId })
  }

  answer(requestId: string, answer: PhoneAnswer, carrier: TestPhone = this) {
    return this.send(
      { type: 'request', route: 'answer', requestId, answer },
      phoneProtocolVersion,
      carrier,
    )
  }

  close(): void {
    this.#closed = true
    this.#socket?.close()
  }
}
