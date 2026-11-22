import { createHash, createHmac } from 'node:crypto'
import { type Edition, edition } from './edition.ts'
import { tedEnv } from './env.ts'
import {
  isArray,
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
import {
  type PhoneChatAgentsBody,
  type PhoneChatBody,
  type PhoneChatChangedBody,
  type PhoneChatCreatedBody,
  type PhoneChatItemBody,
  type PhoneChatItemsBody,
  type PhoneChatKind,
  type PhoneChatMessageBody,
  type PhoneChatStoppedBody,
  type PhoneChatsBody,
  phoneChatChangeRoutes,
  phoneChatIdMax,
  phoneChatKinds,
} from './phone-chats.ts'
import type { PhoneFactoryIconBody } from './phone-factory-icon.ts'
import {
  phoneFileNameMax,
  phoneFilePartBytes,
  phoneFilePartsMax,
  phoneFilesMax,
  phoneMediaTypeMax,
} from './phone-files.ts'
import { type PhoneImageBody, phoneImageIdMax } from './phone-images.ts'
import type { PhonePlanUsageBody } from './phone-plan-usage.ts'
import type { PhoneProblemsBody } from './phone-problems.ts'
import {
  type PhoneAnswer,
  type PhoneAnsweredBody,
  type PhoneRequestBody,
  type PhoneRequestsBody,
  type PhoneSnooze,
  type PhoneSnoozeBody,
  parsePhoneAnswer,
} from './phone-requests.ts'
import {
  type PhoneFactoriesBody,
  type PhoneTaskBody,
  type PhoneTaskCommentsBody,
  type PhoneTaskCreatedBody,
  type PhoneTaskGroup,
  type PhoneTaskOptionsBody,
  type PhoneTaskOverrides,
  type PhoneTasksBody,
  phoneCursorMax,
  phoneFactoryIdMax,
  phoneNewTaskPriority,
  phoneTaskGroups,
  phoneTaskIdMax,
  phoneTaskTitleMax,
} from './phone-tasks.ts'
import { agentKinds } from './run.ts'
import { clarifyDepths, efforts, isModelName, type Priority, priorities } from './task.ts'
import { snoozePresetIds } from './time.ts'
import { RequestValidationError } from './validation.ts'

export const phoneProtocolVersion = 3
export const minPhoneProtocolVersion = 3
export const phoneEnvelopeVersion = 1
export const pairingLinkVersion = 1
export const pairingLinkPrefix = 'ted-pair:'
export const pairingLifetimeMs = 5 * 60_000
export const phoneMessageWindowMs = 120_000
export const phoneNameMax = 100
export const phoneRequestIdMax = 200
export const phoneActionTextMax = 10_000
export const phoneRevisionMax = 128
export const phoneFactoryKeyMax = 200
export const relayLoginVersion = 2
export const relayAuthHeader = 'Ted-Relay-Auth'
export const relayAuthMax = 1_024
export const relayPhonesMax = 64

export const defaultRelayUrl = 'https://ted-relay.forjoyilive.workers.dev'
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
  'snoozed-requests',
  'request-snooze',
  'request',
  'answer',
  'push-token',
  'problems',
  'plan-usage',
  'problem-dismiss',
  'tasks',
  'task',
  'task-comments',
  'task-conversation',
  'task-conversation-item',
  'image',
  'context-file',
  'design-prototype',
  'task-start',
  'task-stop',
  'task-resume',
  'task-priority',
  'task-comment',
  'task-archive',
  'task-delete',
  'factories',
  'task-create',
  'task-create-options',
  'task-create-with-options',
  'file-part',
  'file-done',
  'chats',
  'chat',
  'chat-items',
  'chat-item',
  'factory-icon',
  'chat-message',
  'chat-stop',
  ...phoneChatChangeRoutes,
  'chat-agents',
  'chat-create',
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
      relayKey?: string
      relayProof?: string
    })
  | (PhoneMessageHeader & { type: 'pair-status'; pairing: string })
  | (PhoneMessageHeader & {
      type: 'request'
      route: string
      requestId?: string
      includeSnoozed?: boolean
      snooze?: PhoneSnooze
      problemId?: string
      raisedAt?: string
      answer?: PhoneAnswer
      token?: string
      taskId?: string
      group?: PhoneTaskGroup
      cursor?: string
      text?: string
      priority?: Priority
      children?: 'archive' | 'detach' | 'delete' | 'unparent'
      closePullRequests?: boolean
      hierarchyRevision?: string
      overrides?: PhoneTaskOverrides
      includePiModels?: boolean
      createId?: string
      factory?: string
      factoryId?: string
      title?: string
      description?: string
      start?: boolean
      files?: readonly string[]
      uploadId?: string
      index?: number
      data?: string
      name?: string
      mediaType?: string
      size?: number
      sha256?: string
      chatKind?: PhoneChatKind
      chatId?: string
      agentId?: string
      archived?: boolean
      before?: string
      itemId?: string
      offset?: number
      image?: string
      attachment?: string
      prototype?: string
      part?: number
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
  | PhoneSnoozeBody
  | PhoneRequestBody
  | PhoneAnsweredBody
  | PhonePushTokenBody
  | PhoneProblemsBody
  | PhonePlanUsageBody
  | PhoneTasksBody
  | PhoneTaskBody
  | PhoneTaskCommentsBody
  | PhoneImageBody
  | PhoneFactoriesBody
  | PhoneFactoryIconBody
  | PhoneTaskCreatedBody
  | PhoneTaskOptionsBody
  | PhoneChatsBody
  | PhoneChatBody
  | PhoneChatItemsBody
  | PhoneChatItemBody
  | PhoneChatMessageBody
  | PhoneChatStoppedBody
  | PhoneChatChangedBody
  | PhoneChatAgentsBody
  | PhoneChatCreatedBody

export type MacReplyMessage = PhoneMessageHeader & { type: 'reply' } & (
    | { ok: true; body: PhoneReplyBody }
    | { ok: false; error: PhoneReplyError }
  )

export type RelayToMac =
  | { t: 'ready' }
  | { t: 'msg'; conn: number; data: string }
  | { t: 'closed'; conn: number }
  | { t: 'phones-ok' | 'phones-stale' | 'phones-conflict'; rev: number }
  | { t: 'pairing-ok' | 'pairing-candidate-ok' | 'pairing-gone' | 'pairing-end-ok'; hash: string }

export type MacToRelay =
  | { t: 'msg'; conn: number; data: string }
  | { t: 'phones'; rev: number; keys: string[]; base: string | null }
  | { t: 'pairing'; hash: string; expiresAt: number }
  | { t: 'pairing-candidate'; hash: string; key: string }
  | { t: 'pairing-end'; hash: string }

export type RelayLoginMode = 'mac' | 'phone' | 'pairing'
export type RelayRoute = 'mac' | 'phone' | 'check'

export interface RelayLogin {
  v: number
  mode: RelayLoginMode
  key: string
  at: number
  nonce: string
  sig: string
  ticket?: string
}

export interface RelayLoginFields {
  mode: RelayLoginMode
  route: RelayRoute
  host: string
  channel: string
  at: number
  nonce: string
  ticketHash?: string
}

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
  pairAgain: boolean
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

export function relayLoginText(fields: RelayLoginFields): string {
  const { mode, route, host, channel, at, nonce, ticketHash } = fields
  return `ted-relay-login:v${relayLoginVersion}:${mode}:${route}:${host}:${channel}:${at}:${nonce}:${ticketHash ?? '-'}`
}

export function relayAuth(
  fields: RelayLoginFields & {
    key: Uint8Array
    ticket?: Uint8Array
    sign(text: Uint8Array): Uint8Array
  },
): string {
  const ticketHash = fields.ticket && relayTicketHash(fields.ticket)
  const text = relayLoginText({ ...fields, ...(ticketHash !== undefined && { ticketHash }) })
  const login: RelayLogin = {
    v: relayLoginVersion,
    mode: fields.mode,
    key: toBase64Url(fields.key),
    at: fields.at,
    nonce: fields.nonce,
    sig: toBase64Url(fields.sign(new TextEncoder().encode(text))),
    ...(fields.ticket && { ticket: toBase64Url(fields.ticket) }),
  }
  return Buffer.from(JSON.stringify(login), 'utf8').toString('base64url')
}

export function relayTicket(secret: Uint8Array, channel: string, pairing: string): Uint8Array {
  return new Uint8Array(
    createHmac('sha256', secret).update(`ted-relay-pairing:v1:${channel}:${pairing}`).digest(),
  )
}

export function relayTicketHash(ticket: Uint8Array): string {
  return toBase64Url(createHash('sha256').update(ticket).digest())
}

export function relayListHash(rev: number, keys: readonly string[]): string {
  const text = `${rev}:${[...keys].sort().join(',')}`
  return toBase64Url(createHash('sha256').update(text, 'utf8').digest())
}

export function relayKeyProofText(pairing: string, phoneBoxKey: string): string {
  return `ted-relay-key:v1:${pairing}:${phoneBoxKey}`
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
      ...(object.relayKey !== undefined && { relayKey: base64Field(object, 'relayKey', 32) }),
      ...(object.relayProof !== undefined && {
        relayProof: base64Field(object, 'relayProof', 64),
      }),
    }
  }
  if (type === 'pair-status') {
    return { ...header, type, pairing: base64Field(object, 'pairing', 16) }
  }
  const route = read.string(object, 'route')
  if (route === 'problem-dismiss') {
    return {
      ...header,
      type,
      route,
      problemId: read.string(object, 'problemId'),
      raisedAt: read.string(object, 'raisedAt'),
    }
  }
  if (route === 'request-snooze') {
    return {
      ...header,
      type,
      route,
      requestId: requestId(object),
      snooze: read.oneOf(object, 'snooze', [...snoozePresetIds, 'clear']),
    }
  }
  if (route === 'request') {
    const includeSnoozed = read.optional(object, 'includeSnoozed', read.boolean)
    const chatId = read.optional(object, 'chatId', (o, f) => boundedText(o, f, 200))
    return {
      ...header,
      type,
      route,
      requestId: requestId(object),
      ...(chatId !== undefined && { chatId }),
      ...(includeSnoozed !== undefined && { includeSnoozed }),
    }
  }
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
  if (route === 'tasks') {
    const group = read.optional(object, 'group', (o, f) => read.oneOf(o, f, phoneTaskGroups))
    const cursor = optionalCursor(object)
    return {
      ...header,
      type,
      route,
      group: group ?? 'status',
      ...(cursor !== undefined && { cursor }),
    }
  }
  if (route === 'task') return { ...header, type, route, taskId: taskId(object) }
  if (route === 'task-comments' || route === 'task-conversation') {
    const cursor = optionalCursor(object)
    return {
      ...header,
      type,
      route,
      taskId: taskId(object),
      ...(cursor !== undefined && { cursor }),
    }
  }
  if (route === 'task-conversation-item') {
    const offset = read.optional(object, 'offset', read.integer)
    if (offset !== undefined && offset < 0)
      throw new ParseError('offset', 'offset must be nonnegative')
    return {
      ...header,
      type,
      route,
      taskId: taskId(object),
      itemId: chatText(object, 'itemId'),
      ...(offset !== undefined && { offset }),
    }
  }
  if (route === 'context-file') {
    return {
      ...header,
      type,
      route,
      requestId: requestId(object),
      attachment: imageId(object, 'attachment'),
      part: imagePart(object),
    }
  }
  if (route === 'design-prototype') {
    const prototype = read.string(object, 'prototype')
    if (!prototype || prototype.length > phoneImageIdMax) {
      throw new ParseError('prototype', 'prototype reference is invalid')
    }
    return { ...header, type, route, prototype, part: imagePart(object) }
  }
  if (route === 'image') {
    return { ...header, type, route, image: imageId(object), part: imagePart(object) }
  }
  if (route === 'task-start' || route === 'task-stop') {
    return { ...header, type, route, taskId: taskId(object) }
  }
  if (route === 'task-resume') {
    const text = read.optional(object, 'text', read.string)
    if (text !== undefined) actionText(text, false)
    return {
      ...header,
      type,
      route,
      taskId: taskId(object),
      ...(text !== undefined && { text }),
    }
  }
  if (route === 'task-priority') {
    return {
      ...header,
      type,
      route,
      taskId: taskId(object),
      priority: read.oneOf(object, 'priority', priorities),
    }
  }
  if (route === 'task-comment') {
    const files = optionalFiles(object)
    const text =
      files === undefined
        ? read.string(object, 'text')
        : (read.optional(object, 'text', read.string) ?? '')
    actionText(text, files === undefined)
    return { ...header, type, route, taskId: taskId(object), text, ...(files && { files }) }
  }
  if (route === 'task-archive') {
    const children = read.optional(object, 'children', (o, f) =>
      read.oneOf(o, f, ['archive', 'detach'] as const),
    )
    return {
      ...header,
      type,
      route,
      taskId: taskId(object),
      hierarchyRevision: revision(object),
      closePullRequests: read.boolean(object, 'closePullRequests'),
      ...(children !== undefined && { children }),
    }
  }
  if (route === 'task-delete') {
    const children = read.optional(object, 'children', (o, f) =>
      read.oneOf(o, f, ['delete', 'unparent'] as const),
    )
    return {
      ...header,
      type,
      route,
      taskId: taskId(object),
      hierarchyRevision: revision(object),
      ...(children !== undefined && { children }),
    }
  }
  if (route === 'task-create-options') {
    const includePiModels = read.optional(object, 'includePiModels', read.boolean)
    return {
      ...header,
      type,
      route,
      factory: factoryKey(object),
      includePiModels: includePiModels ?? false,
    }
  }
  if (route === 'task-create' || route === 'task-create-with-options') {
    const overrides =
      route === 'task-create-with-options'
        ? readTaskOverrides(read.object(object.overrides, 'overrides'))
        : undefined
    const title = read.optional(object, 'title', read.string)
    if (title !== undefined && title.length > phoneTaskTitleMax) {
      throw new ParseError('title', `title must be at most ${phoneTaskTitleMax} characters`)
    }
    const description = read.optional(object, 'description', read.string)
    if (description !== undefined && description.length > phoneActionTextMax) {
      throw new ParseError(
        'description',
        `description must be at most ${phoneActionTextMax} characters`,
      )
    }
    const priority = read.optional(object, 'priority', (o, f) => read.oneOf(o, f, priorities))
    const files = optionalFiles(object)
    return {
      ...header,
      type,
      route,
      createId: base64Field(object, 'createId', 16),
      ...(overrides && { overrides }),
      factory: factoryKey(object),
      ...(title !== undefined && { title }),
      ...(description !== undefined && { description }),
      priority: priority ?? phoneNewTaskPriority,
      start: read.boolean(object, 'start'),
      ...(files && { files }),
    }
  }
  if (route === 'file-part') {
    const index = read.integer(object, 'index')
    if (index < 0 || index >= phoneFilePartsMax) {
      throw new ParseError('index', `index must be 0 to ${phoneFilePartsMax - 1}`)
    }
    return {
      ...header,
      type,
      route,
      uploadId: base64Field(object, 'uploadId', 16),
      index,
      data: partData(object),
    }
  }
  if (route === 'file-done') {
    const size = read.integer(object, 'size')
    if (size < 0) throw new ParseError('size', 'size must not be negative')
    const sha256 = read.string(object, 'sha256')
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new ParseError('sha256', 'sha256 must be 64 lowercase hex digits')
    }
    return {
      ...header,
      type,
      route,
      uploadId: base64Field(object, 'uploadId', 16),
      name: boundedText(object, 'name', phoneFileNameMax),
      mediaType: boundedText(object, 'mediaType', phoneMediaTypeMax),
      size,
      sha256,
    }
  }
  if (route === 'chats') {
    const factoryId = read.optional(object, 'factoryId', (o, f) => chatText(o, f))
    const archived = read.optional(object, 'archived', read.boolean)
    const cursor = optionalCursor(object)
    return {
      ...header,
      type,
      route,
      ...(factoryId !== undefined && { factoryId }),
      archived: archived ?? false,
      ...(cursor !== undefined && { cursor }),
    }
  }
  if (route === 'chat') {
    return { ...header, type, route, ...chatRef(object) }
  }
  if (route === 'chat-items') {
    const before = optionalCursor(object, 'before')
    return { ...header, type, route, ...chatRef(object), ...(before !== undefined && { before }) }
  }
  if (route === 'chat-item') {
    const offset = read.optional(object, 'offset', read.integer)
    if (offset !== undefined && offset < 0) {
      throw new ParseError('offset', 'offset must be a whole number from 0')
    }
    return {
      ...header,
      type,
      route,
      ...chatRef(object),
      itemId: chatText(object, 'itemId'),
      ...(offset !== undefined && { offset }),
    }
  }
  if (route === 'factory-icon') return { ...header, type, route, factoryId: factoryId(object) }
  if (route === 'chat-message') {
    const text = read.string(object, 'text')
    actionText(text, true)
    return {
      ...header,
      type,
      route,
      ...chatRef(object),
      text,
      createId: base64Field(object, 'createId', 16),
    }
  }
  if (route === 'chat-rename') {
    return { ...header, type, route, ...chatRef(object), title: read.string(object, 'title') }
  }
  if (route === 'chat-stop' || isOneOf(route, phoneChatChangeRoutes)) {
    return { ...header, type, route, ...chatRef(object) }
  }
  if (route === 'chat-agents') return { ...header, type, route, factory: factoryKey(object) }
  if (route === 'chat-create') {
    const text = read.string(object, 'text')
    actionText(text, true)
    return {
      ...header,
      type,
      route,
      factory: factoryKey(object),
      agentId: chatText(object, 'agentId'),
      text,
      createId: base64Field(object, 'createId', 16),
    }
  }
  return { ...header, type, route }
}

function optionalFiles(object: JsonObject): string[] | undefined {
  if (object.files === undefined) return undefined
  const list = read.list(object, 'files')
  if (list.length === 0 || list.length > phoneFilesMax) {
    throw new ParseError('files', `files must hold 1 to ${phoneFilesMax} uploadIds`)
  }
  const ids = list.map((id) => {
    if (!isString(id) || !fromBase64Url(id, 16)) {
      throw new ParseError('files', 'each of files must be 16 bytes in base64url')
    }
    return id
  })
  if (new Set(ids).size !== ids.length) {
    throw new ParseError('files', 'files must not repeat an uploadId')
  }
  return ids
}

function partData(object: JsonObject): string {
  const data = read.string(object, 'data')
  const bytes = /^[A-Za-z0-9+/]*={0,2}$/.test(data) ? Buffer.from(data, 'base64') : undefined
  if (!bytes || bytes.toString('base64') !== data) {
    throw new ParseError('data', 'data must be base64')
  }
  if (bytes.length > phoneFilePartBytes) {
    throw new ParseError('data', `data must hold at most ${phoneFilePartBytes} bytes`)
  }
  return data
}

function boundedText(object: JsonObject, field: string, max: number): string {
  const value = read.string(object, field)
  if (value.trim() === '' || value.length > max) {
    throw new ParseError(field, `${field} must be text of 1 to ${max} characters`)
  }
  return value
}

function chatText(object: JsonObject, field: string): string {
  const value = read.string(object, field)
  if (!value || value.length > phoneChatIdMax) {
    throw new ParseError(field, `${field} must be text of 1 to ${phoneChatIdMax} characters`)
  }
  return value
}

interface PhoneChatRef {
  chatKind: PhoneChatKind
  chatId: string
}

function chatRef(object: JsonObject): PhoneChatRef {
  return {
    chatKind: read.oneOf(object, 'chatKind', phoneChatKinds),
    chatId: chatText(object, 'chatId'),
  }
}

function readTaskOverrides(object: JsonObject): PhoneTaskOverrides {
  const clarifyDepth = read.optional(object, 'clarifyDepth', (o, f) =>
    read.oneOf(o, f, clarifyDepths),
  )
  const lead = read.optional(object, 'lead', (o, f) => {
    const fields = read.object(o[f], f)
    const agent = read.oneOf(fields, 'agent', agentKinds)
    const model = read.optional(fields, 'model', read.string)
    if (model !== undefined && !isModelName(model))
      throw new ParseError('model', 'invalid model name')
    const effort = read.optional(fields, 'effort', (value, name) =>
      read.oneOf(value, name, efforts),
    )
    const effortMode = read.optional(fields, 'effortMode', (value, name) =>
      read.oneOf(value, name, ['stage'] as const),
    )
    return {
      agent,
      ...(model !== undefined && { model }),
      ...(effort !== undefined && { effort }),
      ...(effortMode !== undefined && { effortMode }),
    }
  })
  if (clarifyDepth === undefined && lead === undefined) {
    throw new ParseError('overrides', 'give at least one New Task override')
  }
  return {
    ...(clarifyDepth !== undefined && { clarifyDepth }),
    ...(lead !== undefined && { lead }),
  }
}

function factoryKey(object: JsonObject): string {
  const key = read.string(object, 'factory')
  if (!key || key.length > phoneFactoryKeyMax) {
    throw new ParseError('factory', `factory must be text of 1 to ${phoneFactoryKeyMax} characters`)
  }
  return key
}

function actionText(text: string, required: boolean): void {
  if (text.length > phoneActionTextMax || (required && text.trim() === '')) {
    throw new ParseError(
      'text',
      `text must be ${required ? 'text of 1' : '0'} to ${phoneActionTextMax} characters`,
    )
  }
}

function revision(object: JsonObject): string {
  const value = read.string(object, 'hierarchyRevision')
  if (!value || value.length > phoneRevisionMax) {
    throw new ParseError(
      'hierarchyRevision',
      `hierarchyRevision must be text of 1 to ${phoneRevisionMax} characters`,
    )
  }
  return value
}

function factoryId(object: JsonObject): string {
  const id = read.string(object, 'factoryId')
  if (!id || id.length > phoneFactoryIdMax) {
    throw new ParseError(
      'factoryId',
      `factoryId must be text of 1 to ${phoneFactoryIdMax} characters`,
    )
  }
  return id
}

function imageId(object: JsonObject, field = 'image'): string {
  const id = read.string(object, field)
  if (!id || id.length > phoneImageIdMax) {
    throw new ParseError(field, `${field} must be text of 1 to ${phoneImageIdMax} characters`)
  }
  return id
}

function imagePart(object: JsonObject): number {
  const part = read.integer(object, 'part')
  if (part < 0) throw new ParseError('part', 'part must be a whole number from 0')
  return part
}

function taskId(object: JsonObject): string {
  const id = read.string(object, 'taskId')
  if (!id || id.length > phoneTaskIdMax) {
    throw new ParseError('taskId', `taskId must be text of 1 to ${phoneTaskIdMax} characters`)
  }
  return id
}

function optionalCursor(object: JsonObject, field = 'cursor'): string | undefined {
  const cursor = read.optional(object, field, read.string)
  if (cursor !== undefined && (!cursor || cursor.length > phoneCursorMax)) {
    throw new ParseError(field, `${field} must be text of 1 to ${phoneCursorMax} characters`)
  }
  return cursor
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

const relayHashAnswers = [
  'pairing-ok',
  'pairing-candidate-ok',
  'pairing-gone',
  'pairing-end-ok',
] as const
const relayListAnswers = ['phones-ok', 'phones-stale', 'phones-conflict'] as const

function isRelayBytes(value: Untyped, length: number): value is string {
  return isString(value) && fromBase64Url(value, length) !== undefined
}

export function parseRelayToMac(value: Untyped): RelayToMac | undefined {
  if (!isObject(value)) return undefined
  if (value.t === 'ready') return { t: 'ready' }
  if (value.t === 'msg' && isInteger(value.conn) && isString(value.data)) {
    return { t: 'msg', conn: value.conn, data: value.data }
  }
  if (value.t === 'closed' && isInteger(value.conn)) return { t: 'closed', conn: value.conn }
  if (isOneOf(value.t, relayListAnswers) && isInteger(value.rev)) {
    return { t: value.t, rev: value.rev }
  }
  if (isOneOf(value.t, relayHashAnswers) && isRelayBytes(value.hash, 32)) {
    return { t: value.t, hash: value.hash }
  }
  return undefined
}

export function parseMacToRelay(value: Untyped): MacToRelay | undefined {
  if (!isObject(value)) return undefined
  if (value.t === 'msg' && isInteger(value.conn) && isString(value.data)) {
    return { t: 'msg', conn: value.conn, data: value.data }
  }
  if (value.t === 'phones' && isInteger(value.rev) && value.rev >= 0 && isArray(value.keys)) {
    const keys = value.keys.filter((key): key is string => isRelayBytes(key, 32))
    if (keys.length !== value.keys.length || keys.length > relayPhonesMax) return undefined
    if (new Set(keys).size !== keys.length) return undefined
    if (value.base !== null && !isRelayBytes(value.base, 32)) return undefined
    return { t: 'phones', rev: value.rev, keys, base: value.base }
  }
  if (!isRelayBytes(value.hash, 32)) return undefined
  if (value.t === 'pairing' && isInteger(value.expiresAt)) {
    return { t: 'pairing', hash: value.hash, expiresAt: value.expiresAt }
  }
  if (value.t === 'pairing-candidate' && isRelayBytes(value.key, 32)) {
    return { t: 'pairing-candidate', hash: value.hash, key: value.key }
  }
  if (value.t === 'pairing-end') return { t: 'pairing-end', hash: value.hash }
  return undefined
}

export function parseRelayAuth(text: string): RelayLogin {
  if (text.length > relayAuthMax) {
    throw new ParseError('login', `the login is longer than ${relayAuthMax} characters`)
  }
  const bytes = fromBase64Url(text)
  const object = read.object(bytes && parseJson(Buffer.from(bytes).toString('utf8')), 'login')
  const mode = read.oneOf(object, 'mode', ['mac', 'phone', 'pairing'])
  const login: RelayLogin = {
    v: read.integer(object, 'v'),
    mode,
    key: base64Field(object, 'key', 32),
    at: read.integer(object, 'at'),
    nonce: base64Field(object, 'nonce', 16),
    sig: base64Field(object, 'sig', 64),
  }
  if (mode === 'pairing') return { ...login, ticket: base64Field(object, 'ticket', 32) }
  if (object.ticket !== undefined) throw new ParseError('ticket', 'only pairing mode has a ticket')
  return login
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
