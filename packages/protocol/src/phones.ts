import { createHash } from 'node:crypto'
import { type Edition, edition } from './edition.ts'
import { tedEnv } from './env.ts'
import {
  isInteger,
  isObject,
  isOneOf,
  isString,
  type JsonObject,
  ParseError,
  parseJson,
  reader,
  type Untyped,
} from './parse.ts'
import type { PhoneProblemsBody } from './phone-problems.ts'
import {
  type PhoneAnswer,
  type PhoneAnsweredBody,
  type PhoneRequestBody,
  type PhoneRequestsBody,
  parsePhoneAnswer,
} from './phone-requests.ts'
import { RequestValidationError } from './validation.ts'

export const phoneProtocolVersion = 2
export const minPhoneProtocolVersion = 1
export const phoneEnvelopeVersion = 1
export const pairingLinkVersion = 1
export const pairingLinkPrefix = 'ted-pair:'
export const pairingLifetimeMs = 5 * 60_000
export const phoneMessageWindowMs = 120_000
export const phoneNameMax = 100
export const phoneRequestIdMax = 200

export const defaultRelayUrl = 'https://ted-relay.invalid'
export const devRelayUrl = 'http://127.0.0.1:8787'

export function relayUrl(env: NodeJS.ProcessEnv = process.env, which: Edition = edition): string {
  return tedEnv('TED_RELAY_URL', env, which) ?? (which === 'dev' ? devRelayUrl : defaultRelayUrl)
}

export const phoneErrorCodes = [
  'not-paired',
  'expired',
  'used',
  'wrong-edition',
  'too-old',
  'too-new',
  'bad-request',
  'unknown-route',
  'gone',
  'answer-on-mac',
  'refused',
] as const
export type PhoneErrorCode = (typeof phoneErrorCodes)[number]

export const phoneRouteNames = [
  'status',
  'requests',
  'request',
  'answer',
  'push-token',
  'problems',
] as const
export type PhoneRouteName = (typeof phoneRouteNames)[number]

export interface PairingLink {
  v: number
  edition: Edition
  relay: string
  channel: string
  macKey: string
  pairing: string
  secret: string
  expiresAt: number
}

export interface PhoneEnvelope {
  v: number
  from: string
  nonce: string
  box: string
}

export interface PhoneMessageHeader {
  protocol: number
  id: string
  at: number
  type: string
}

export type PhoneRequest =
  | (PhoneMessageHeader & {
      type: 'pair'
      pairing: string
      secret: string
      name: string
      edition: Edition
    })
  | (PhoneMessageHeader & { type: 'pair-status'; pairing: string })
  | (PhoneMessageHeader & {
      type: 'request'
      route: string
      requestId?: string
      answer?: PhoneAnswer
      token?: string
    })

export interface PhoneReplyError {
  code: PhoneErrorCode
  message: string
}

export type MacReply = PhoneMessageHeader & { type: 'reply' } & (
    | { ok: true; body: JsonObject }
    | { ok: false; error: PhoneReplyError }
  )

export type PairReplyBody = { state: 'waiting'; code: string }
export type PairStatusBody =
  | { state: 'waiting' }
  | { state: 'approved'; mac: string }
  | { state: 'refused' }
  | { state: 'expired' }
export interface PhoneStatusBody {
  mac: string
  edition: Edition
  version: string
  protocol: number
}

export type PhonePushTokenBody = Record<never, never>

export const pushTokenPattern = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{1,200}\]$/

export type PhoneReplyBody =
  | PairReplyBody
  | PairStatusBody
  | PhoneStatusBody
  | PhoneRequestsBody
  | PhoneRequestBody
  | PhoneAnsweredBody
  | PhonePushTokenBody
  | PhoneProblemsBody

export type MacReplyMessage = PhoneMessageHeader & { type: 'reply' } & (
    | { ok: true; body: PhoneReplyBody }
    | { ok: false; error: PhoneReplyError }
  )

export type RelayToMac =
  | { t: 'challenge'; nonce: string }
  | { t: 'ready' }
  | { t: 'msg'; conn: number; data: string }
  | { t: 'closed'; conn: number }

export type MacToRelay =
  | { t: 'login'; key: string; sig: string }
  | { t: 'msg'; conn: number; data: string }

export type RelayToPhone = { t: 'msg'; data: string } | { t: 'mac-online' } | { t: 'mac-offline' }

export type PhonePairingState =
  | { state: 'none' }
  | { state: 'live'; pairing: string; link: string; expiresAt: number; edition: Edition }
  | {
      state: 'waiting'
      pairing: string
      link: string
      expiresAt: number
      phoneName: string
      code: string
    }
  | { state: 'expired'; pairing: string }
  | { state: 'approved'; pairing: string; phoneName: string }
  | { state: 'refused'; pairing: string; phoneName: string }

export interface PhonePairingOffer {
  pairing: string
  link: string
  expiresAt: number
  edition: Edition
}

export interface PhonePairingDecision {
  pairing: string
}

export interface PairedPhone {
  id: string
  name: string
  pairedAt: string
  lastReachedAt?: string
}

export interface PairedPhones {
  phones: PairedPhone[]
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export function fromBase64Url(text: string, length?: number): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined
  const bytes = Buffer.from(text, 'base64url')
  if (bytes.toString('base64url') !== text) return undefined
  if (length !== undefined && bytes.length !== length) return undefined
  return new Uint8Array(bytes)
}

export function relayChannel(signPublicKey: Uint8Array): string {
  return toBase64Url(createHash('sha256').update(signPublicKey).digest())
}

export function relayLoginText(channel: string, nonce: string): string {
  return `ted-relay-login:v1:${channel}:${nonce}`
}

export function shortCode(macKey: Uint8Array, phoneKey: Uint8Array, secret: Uint8Array): string {
  const digest = createHash('sha256').update(macKey).update(phoneKey).update(secret).digest()
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

export function encodePairingLink(link: PairingLink): string {
  return `${pairingLinkPrefix}${Buffer.from(JSON.stringify(link), 'utf8').toString('base64url')}`
}

const read = reader()

function base64Field(object: JsonObject, field: string, length: number): string {
  const value = read.string(object, field)
  if (!fromBase64Url(value, length)) {
    throw new ParseError(field, `${field} must be ${length} bytes in base64url`)
  }
  return value
}

function relayAddress(object: JsonObject, field: string): string {
  const value = read.string(object, field)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ParseError(field, `${field} must be a URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ParseError(field, `${field} must be an http or https URL`)
  }
  return value
}

export function parsePairingLink(text: string): PairingLink {
  if (!text.startsWith(pairingLinkPrefix)) {
    throw new ParseError('link', `a pairing link starts with ${pairingLinkPrefix}`)
  }
  const encoded = text.slice(pairingLinkPrefix.length)
  const bytes = fromBase64Url(encoded)
  const value = bytes && parseJson(Buffer.from(bytes).toString('utf8'))
  const object = read.object(value, 'link')
  return {
    v: read.integer(object, 'v'),
    edition: read.oneOf(object, 'edition', ['release', 'dev']),
    relay: relayAddress(object, 'relay'),
    channel: base64Field(object, 'channel', 32),
    macKey: base64Field(object, 'macKey', 32),
    pairing: base64Field(object, 'pairing', 16),
    secret: base64Field(object, 'secret', 32),
    expiresAt: read.integer(object, 'expiresAt'),
  }
}

export function parsePhoneEnvelope(value: Untyped): PhoneEnvelope {
  const object = read.object(value, 'envelope')
  return {
    v: read.integer(object, 'v'),
    from: base64Field(object, 'from', 32),
    nonce: base64Field(object, 'nonce', 24),
    box: read.string(object, 'box'),
  }
}

export function parsePhoneMessageHeader(value: Untyped): PhoneMessageHeader {
  const object = read.object(value, 'message')
  return {
    protocol: read.integer(object, 'protocol'),
    id: base64Field(object, 'id', 16),
    at: read.integer(object, 'at'),
    type: read.string(object, 'type'),
  }
}

function phoneName(object: JsonObject): string {
  const name = read.string(object, 'name').trim()
  if (!name || name.length > phoneNameMax) {
    throw new ParseError('name', `name must be text of 1 to ${phoneNameMax} characters`)
  }
  return name
}

export function parsePhoneRequest(value: Untyped): PhoneRequest {
  const object = read.object(value, 'message')
  const header = parsePhoneMessageHeader(object)
  const type = read.oneOf(object, 'type', ['pair', 'pair-status', 'request'])
  if (type === 'pair') {
    return {
      ...header,
      type,
      pairing: base64Field(object, 'pairing', 16),
      secret: base64Field(object, 'secret', 32),
      name: phoneName(object),
      edition: read.oneOf(object, 'edition', ['release', 'dev']),
    }
  }
  if (type === 'pair-status') {
    return { ...header, type, pairing: base64Field(object, 'pairing', 16) }
  }
  const route = read.string(object, 'route')
  if (route === 'request') return { ...header, type, route, requestId: requestId(object) }
  if (route === 'answer') {
    return {
      ...header,
      type,
      route,
      requestId: requestId(object),
      answer: parsePhoneAnswer(object.answer),
    }
  }
  if (route === 'push-token') return { ...header, type, route, token: pushToken(object) }
  return { ...header, type, route }
}

function pushToken(object: JsonObject): string {
  const token = read.string(object, 'token')
  if (!pushTokenPattern.test(token)) {
    throw new ParseError('token', 'token must be an Expo push token')
  }
  return token
}

function requestId(object: JsonObject): string {
  const id = read.string(object, 'requestId')
  if (!id || id.length > phoneRequestIdMax) {
    throw new ParseError(
      'requestId',
      `requestId must be text of 1 to ${phoneRequestIdMax} characters`,
    )
  }
  return id
}

export function parseMacReply(value: Untyped): MacReply {
  const object = read.object(value, 'reply')
  const header = parsePhoneMessageHeader(object)
  read.oneOf(object, 'type', ['reply'])
  if (read.boolean(object, 'ok')) {
    return { ...header, type: 'reply', ok: true, body: read.object(object.body, 'body') }
  }
  const error = read.object(object.error, 'error')
  return {
    ...header,
    type: 'reply',
    ok: false,
    error: {
      code: read.oneOf(error, 'code', phoneErrorCodes),
      message: read.string(error, 'message'),
    },
  }
}

export function parseRelayToMac(value: Untyped): RelayToMac | undefined {
  if (!isObject(value)) return undefined
  if (value.t === 'challenge' && isString(value.nonce))
    return { t: 'challenge', nonce: value.nonce }
  if (value.t === 'ready') return { t: 'ready' }
  if (value.t === 'msg' && isInteger(value.conn) && isString(value.data)) {
    return { t: 'msg', conn: value.conn, data: value.data }
  }
  if (value.t === 'closed' && isInteger(value.conn)) return { t: 'closed', conn: value.conn }
  return undefined
}

export function parseMacToRelay(value: Untyped): MacToRelay | undefined {
  if (!isObject(value)) return undefined
  if (value.t === 'login' && isString(value.key) && isString(value.sig)) {
    return { t: 'login', key: value.key, sig: value.sig }
  }
  if (value.t === 'msg' && isInteger(value.conn) && isString(value.data)) {
    return { t: 'msg', conn: value.conn, data: value.data }
  }
  return undefined
}

export function parseRelayToPhone(value: Untyped): RelayToPhone | undefined {
  if (!isObject(value)) return undefined
  if (value.t === 'msg' && isString(value.data)) return { t: 'msg', data: value.data }
  if (isOneOf(value.t, ['mac-online', 'mac-offline'] as const)) return { t: value.t }
  return undefined
}

export function parsePhonePairingDecision(value: Untyped): PhonePairingDecision {
  const fail = (message: string): never => {
    throw new RequestValidationError(400, message)
  }
  const body = reader(fail).object(value, 'request', 'the request must be an object')
  const pairing = reader(fail).string(body, 'pairing', 'pairing must be text')
  if (!fromBase64Url(pairing, 16)) fail('pairing must be a pairing ID')
  return { pairing }
}
