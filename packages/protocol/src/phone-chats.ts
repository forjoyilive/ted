import type { ChatToolStatus } from './chat.ts'
import {
  isOneOf,
  isString,
  type Json,
  type JsonObject,
  ParseError,
  reader,
  type Untyped,
} from './parse.ts'
import { type PhoneFactoryIcon, parsePhoneFactoryIcon } from './phone-factory-icon.ts'
import {
  encodePhoneCursor,
  type PhoneTaskTone,
  phoneCursorParts,
  phoneTaskTones,
} from './phone-tasks.ts'

export const phoneChatKinds = ['coordinator', 'plan'] as const
export type PhoneChatKind = (typeof phoneChatKinds)[number]

export const phoneChatActions = [
  'stop',
  'retry',
  'resume',
  'rename',
  'archive',
  'unarchive',
  'delete',
] as const
export type PhoneChatAction = (typeof phoneChatActions)[number]

export const phoneChatChangeRoutes = [
  'chat-retry',
  'chat-archive',
  'chat-unarchive',
  'chat-rename',
  'chat-delete',
] as const
export type PhoneChatChangeRoute = (typeof phoneChatChangeRoutes)[number]

export const phoneChatIdMax = 200
export const phoneChatTitleMax = 500
export const phoneChatTextMax = 4_000
export const phoneChatToolTitleMax = 200
export const phoneChatLineMax = 2_000

export const phoneChatRequestKinds = [
  'Question',
  'Round',
  'Proposal',
  'Agent draft',
  'Outside command',
  'Note',
] as const
export type PhoneChatRequestKind = (typeof phoneChatRequestKinds)[number]

export const phoneChatToolStatuses = [
  'running',
  'done',
  'failed',
  'stopped',
] as const satisfies readonly ChatToolStatus[]

export const phoneChatCommandStatuses = ['running', 'passed', 'failed', 'stopped'] as const
export type PhoneChatCommandStatus = (typeof phoneChatCommandStatuses)[number]

export const phoneChatSendStates = ['live', 'resume', 'off'] as const
export type PhoneChatSend = (typeof phoneChatSendStates)[number]

export const phoneChatOffReasonMax = 300
export const phoneChatAgentDescriptionMax = 500

export const phoneChatLineKinds = ['heading', 'text', 'added', 'removed', 'context'] as const
export type PhoneChatLineKind = (typeof phoneChatLineKinds)[number]

export interface PhoneChatFactory {
  id: string
  name: string
  icon?: PhoneFactoryIcon
}

export interface PhoneChatRow {
  kind: PhoneChatKind
  id: string
  title: string
  agent: string
  factory: PhoneChatFactory
  status: string
  tone: PhoneTaskTone
  waiting: boolean
  archived: boolean
  lastAt: string
  send: PhoneChatSend
  offReason?: string
  canStop: boolean
  actions?: PhoneChatAction[]
}

export interface PhoneChatsBody {
  factories: PhoneChatFactory[]
  rows: PhoneChatRow[]
  archivedCount: number
  cursor?: string
}

export interface PhoneChatBody {
  chat: PhoneChatRow
}

export interface PhoneChatMessageBody {
  queued: boolean
}

export interface PhoneChatChangedBody {
  changed: true
}

export interface PhoneChatStoppedBody {
  stopped: true
}

export interface PhoneChatAgent {
  id: string
  name: string
  description: string
  planner: boolean
}

export interface PhoneChatAgentsBody {
  agents: PhoneChatAgent[]
}

export interface PhoneChatCreatedBody {
  chat: { kind: PhoneChatKind; id: string }
}

interface ItemBase {
  id: string
  at?: string
}

export type PhoneChatItem =
  | (ItemBase & {
      kind: 'human'
      text: string
      cut: boolean
      images: string[]
      files: number
      unsent?: true
      queued?: true
    })
  | (ItemBase & { kind: 'agent'; text: string; cut: boolean; agent: string })
  | (ItemBase & { kind: 'ted'; title: string; text: string; cut: boolean })
  | (ItemBase & { kind: 'interrupted' })
  | (ItemBase & {
      kind: 'tool'
      tool: string
      title: string
      status: ChatToolStatus
      additions?: number
      deletions?: number
      lines?: number
      detail?: true
    })
  | (ItemBase & {
      kind: 'command'
      name: string
      status: PhoneChatCommandStatus
      exitCode?: number
      lines: number
      detail?: true
    })
  | (ItemBase & { kind: 'action'; text: string; taskRef?: string })
  | (ItemBase & {
      kind: 'request'
      requestKind: PhoneChatRequestKind
      title: string
      text: string
      cut: boolean
      open: boolean
      onPhone?: true
      macReason?: string
    })
  | (ItemBase & { kind: 'card'; text: string; open: boolean; macReason?: string })

export interface PhoneChatItemsBody {
  items: PhoneChatItem[]
  cursor?: string
}

export interface PhoneChatDetailLine {
  kind: PhoneChatLineKind
  text: string
}

export interface PhoneChatItemBody {
  lines: PhoneChatDetailLine[]
  next?: number
}

export interface PhoneChatsCursor {
  lastAt: string
  kind: PhoneChatKind
  id: string
}

export interface PhoneChatItemsCursor {
  chatKind: PhoneChatKind
  itemId: string
}

const chatsTag = 'chats'
const itemsTag = 'chat-items'

function idText(value: Json | undefined): value is string {
  return isString(value) && value.length > 0 && value.length <= phoneChatIdMax
}

export function encodeChatsCursor(cursor: PhoneChatsCursor): string {
  return encodePhoneCursor([chatsTag, cursor.lastAt, cursor.kind, cursor.id])
}

export function parseChatsCursor(text: string): PhoneChatsCursor | undefined {
  const parts = phoneCursorParts(text)
  if (parts?.length !== 4) return undefined
  const [tag, lastAt, kind, id] = parts
  if (tag !== chatsTag || !isString(lastAt) || lastAt.length > phoneChatIdMax) return undefined
  if (!isOneOf(kind, phoneChatKinds) || !idText(id)) return undefined
  return { lastAt, kind, id }
}

export function encodeChatItemsCursor(cursor: PhoneChatItemsCursor): string {
  return encodePhoneCursor([itemsTag, cursor.chatKind, cursor.itemId])
}

export function parseChatItemsCursor(text: string): PhoneChatItemsCursor | undefined {
  const parts = phoneCursorParts(text)
  if (parts?.length !== 3) return undefined
  const [tag, chatKind, itemId] = parts
  if (tag !== itemsTag || !isOneOf(chatKind, phoneChatKinds)) return undefined
  if (!isString(itemId) || itemId.length === 0) return undefined
  return { chatKind, itemId }
}

const read = reader()

function count(object: JsonObject, field: string): number {
  const value = read.integer(object, field)
  if (value < 0) throw new ParseError(field, `${field} must not be negative`)
  return value
}

function optionalCount(object: JsonObject, field: string): number | undefined {
  return object[field] === undefined ? undefined : count(object, field)
}

function onlyTrue(object: JsonObject, field: string): true | undefined {
  if (object[field] === undefined) return undefined
  if (object[field] !== true) throw new ParseError(field, `${field} is true or left out`)
  return true
}

function parseChatFactory(value: Json | undefined): PhoneChatFactory {
  const object = read.object(value, 'factory')
  const icon = object.icon === undefined ? undefined : parsePhoneFactoryIcon(object.icon)
  return {
    id: read.string(object, 'id'),
    name: read.string(object, 'name'),
    ...(icon !== undefined && { icon }),
  }
}

export function parsePhoneChatRow(value: Untyped): PhoneChatRow {
  const object = read.object(value, 'chat')
  const offReason = read.optional(object, 'offReason', read.string)
  const actions = read
    .optional(object, 'actions', read.list)
    ?.filter((action) => isOneOf(action, phoneChatActions))
  return {
    kind: read.oneOf(object, 'kind', phoneChatKinds),
    id: read.string(object, 'id'),
    title: read.string(object, 'title'),
    agent: read.string(object, 'agent'),
    factory: parseChatFactory(object.factory),
    status: read.string(object, 'status'),
    tone: read.oneOf(object, 'tone', phoneTaskTones),
    waiting: read.boolean(object, 'waiting'),
    archived: read.boolean(object, 'archived'),
    lastAt: read.string(object, 'lastAt'),
    send: read.oneOf(object, 'send', phoneChatSendStates),
    ...(offReason !== undefined && { offReason }),
    canStop: read.boolean(object, 'canStop'),
    ...(actions !== undefined && { actions }),
  }
}

export function parsePhoneChatsBody(value: Untyped): PhoneChatsBody {
  const object = read.object(value, 'body')
  const cursor = read.optional(object, 'cursor', read.string)
  return {
    factories: read.list(object, 'factories').map(parseChatFactory),
    rows: read.list(object, 'rows').map(parsePhoneChatRow),
    archivedCount: count(object, 'archivedCount'),
    ...(cursor !== undefined && { cursor }),
  }
}

export function parsePhoneChatBody(value: Untyped): PhoneChatBody {
  const object = read.object(value, 'body')
  return { chat: parsePhoneChatRow(object.chat) }
}

export function parsePhoneChatMessageBody(value: Untyped): PhoneChatMessageBody {
  const object = read.object(value, 'body')
  return { queued: read.boolean(object, 'queued') }
}

export function parsePhoneChatStoppedBody(value: Untyped): PhoneChatStoppedBody {
  const object = read.object(value, 'body')
  if (object.stopped !== true) throw new ParseError('stopped', 'stopped must be true')
  return { stopped: true }
}

function parsePhoneChatAgent(value: Json): PhoneChatAgent {
  const object = read.object(value, 'agent')
  return {
    id: read.string(object, 'id'),
    name: read.string(object, 'name'),
    description: read.string(object, 'description'),
    planner: read.boolean(object, 'planner'),
  }
}

export function parsePhoneChatAgentsBody(value: Untyped): PhoneChatAgentsBody {
  const object = read.object(value, 'body')
  return { agents: read.list(object, 'agents').map(parsePhoneChatAgent) }
}

export function parsePhoneChatCreatedBody(value: Untyped): PhoneChatCreatedBody {
  const object = read.object(value, 'body')
  const chat = read.object(object.chat, 'chat')
  return {
    chat: { kind: read.oneOf(chat, 'kind', phoneChatKinds), id: read.string(chat, 'id') },
  }
}

function imageName(value: Json): string {
  if (isString(value)) return value
  throw new ParseError('images', 'images must be a list of names')
}

export function parsePhoneChatItem(value: Untyped): PhoneChatItem {
  const object = read.object(value, 'item')
  const at = read.optional(object, 'at', read.string)
  const base = { id: read.string(object, 'id'), ...(at !== undefined && { at }) }
  const kind = read.oneOf(object, 'kind', [
    'human',
    'agent',
    'ted',
    'interrupted',
    'tool',
    'command',
    'action',
    'request',
    'card',
  ])
  switch (kind) {
    case 'human': {
      const unsent = onlyTrue(object, 'unsent')
      const queued = onlyTrue(object, 'queued')
      return {
        ...base,
        kind,
        text: read.string(object, 'text'),
        cut: read.boolean(object, 'cut'),
        images: read.list(object, 'images').map(imageName),
        files: count(object, 'files'),
        ...(unsent && { unsent }),
        ...(queued && { queued }),
      }
    }
    case 'agent':
      return {
        ...base,
        kind,
        text: read.string(object, 'text'),
        cut: read.boolean(object, 'cut'),
        agent: read.string(object, 'agent'),
      }
    case 'ted':
      return {
        ...base,
        kind,
        title: read.string(object, 'title'),
        text: read.string(object, 'text'),
        cut: read.boolean(object, 'cut'),
      }
    case 'interrupted':
      return { ...base, kind }
    case 'tool': {
      const additions = optionalCount(object, 'additions')
      const deletions = optionalCount(object, 'deletions')
      const lines = optionalCount(object, 'lines')
      const detail = onlyTrue(object, 'detail')
      return {
        ...base,
        kind,
        tool: read.string(object, 'tool'),
        title: read.string(object, 'title'),
        status: read.oneOf(object, 'status', phoneChatToolStatuses),
        ...(additions !== undefined && { additions }),
        ...(deletions !== undefined && { deletions }),
        ...(lines !== undefined && { lines }),
        ...(detail && { detail }),
      }
    }
    case 'command': {
      const exitCode = read.optional(object, 'exitCode', read.integer)
      const detail = onlyTrue(object, 'detail')
      return {
        ...base,
        kind,
        name: read.string(object, 'name'),
        status: read.oneOf(object, 'status', phoneChatCommandStatuses),
        ...(exitCode !== undefined && { exitCode }),
        lines: count(object, 'lines'),
        ...(detail && { detail }),
      }
    }
    case 'action': {
      const taskRef = read.optional(object, 'taskRef', read.string)
      return {
        ...base,
        kind,
        text: read.string(object, 'text'),
        ...(taskRef !== undefined && { taskRef }),
      }
    }
    case 'request': {
      const macReason = read.optional(object, 'macReason', read.string)
      return {
        ...base,
        kind,
        requestKind: read.oneOf(object, 'requestKind', phoneChatRequestKinds),
        title: read.string(object, 'title'),
        text: read.string(object, 'text'),
        cut: read.boolean(object, 'cut'),
        open: read.boolean(object, 'open'),
        ...(read.optional(object, 'onPhone', read.boolean) === true && { onPhone: true as const }),
        ...(macReason !== undefined && { macReason }),
      }
    }
    case 'card': {
      const macReason = read.optional(object, 'macReason', read.string)
      return {
        ...base,
        kind,
        text: read.string(object, 'text'),
        open: read.boolean(object, 'open'),
        ...(macReason !== undefined && { macReason }),
      }
    }
  }
}

export function parsePhoneChatItemsBody(value: Untyped): PhoneChatItemsBody {
  const object = read.object(value, 'body')
  const cursor = read.optional(object, 'cursor', read.string)
  return {
    items: read.list(object, 'items').map(parsePhoneChatItem),
    ...(cursor !== undefined && { cursor }),
  }
}

export function parsePhoneChatDetailLine(value: Untyped): PhoneChatDetailLine {
  const object = read.object(value, 'line')
  return {
    kind: read.oneOf(object, 'kind', phoneChatLineKinds),
    text: read.string(object, 'text'),
  }
}

export function parsePhoneChatItemBody(value: Untyped): PhoneChatItemBody {
  const object = read.object(value, 'body')
  const next = read.optional(object, 'next', read.integer)
  if (next !== undefined && next < 0) throw new ParseError('next', 'next must not be negative')
  return {
    lines: read.list(object, 'lines').map(parsePhoneChatDetailLine),
    ...(next !== undefined && { next }),
  }
}
