import {
  type FactoryIconColor,
  type FactoryIconSymbol,
  factoryIconColors,
  factoryIconSymbols,
} from './factory-icon.ts'
import {
  isArray,
  isInteger,
  isNumber,
  isOneOf,
  isString,
  type Json,
  type JsonArray,
  type JsonObject,
  ParseError,
  parseJson,
  reader,
  type Untyped,
} from './parse.ts'
import { type PhoneImage, parsePhoneImage } from './phone-images.ts'
import { type PhoneRequestKind, phoneRequestKinds } from './phone-requests.ts'
import { type Priority, priorities } from './task.ts'

export const phoneTaskGroups = ['status', 'factory', 'stage'] as const
export type PhoneTaskGroup = (typeof phoneTaskGroups)[number]

export const phoneStatusSections = ['needs-you', 'working', 'waiting', 'backlog', 'done'] as const
export type PhoneStatusSection = (typeof phoneStatusSections)[number]

export const phoneStatusSectionLabels: Readonly<Record<PhoneStatusSection, string>> = {
  'needs-you': 'Needs you',
  working: 'Working',
  waiting: 'Waiting or blocked',
  backlog: 'Backlog',
  done: 'Done',
}

export const phoneTaskActions = [
  'start',
  'stop',
  'resume',
  'priority',
  'comment',
  'archive',
  'delete',
] as const
export type PhoneTaskAction = (typeof phoneTaskActions)[number]

export const phoneTaskTones = ['working', 'waiting', 'failed', 'stopped', 'done', 'none'] as const
export type PhoneTaskTone = (typeof phoneTaskTones)[number]

export const phoneTaskIdMax = 200
export const phoneCursorMax = 512
export const phoneDoneDays = 7
export const phoneTaskTitleMax = 500
export const phoneLabelMax = 200
export const phoneDescriptionMax = 16_000
export const phoneCommentTextMax = 2_000

export type PhoneFactoryIcon =
  | { kind: 'letter'; color: FactoryIconColor }
  | { kind: 'symbol'; symbol: FactoryIconSymbol; color: FactoryIconColor }
  | { kind: 'emoji'; emoji: string }

export const phoneNewTaskPriority: Priority = 'none'

export interface PhoneFactory {
  key: string
  name: string
  icon?: PhoneFactoryIcon
  defaultPriority: Priority
}

export interface PhoneFactoriesBody {
  factories: PhoneFactory[]
}

export interface PhoneTaskCreatedBody extends PhoneTaskBody {
  startRefused?: string
}

export interface PhoneNamed {
  id: string
  name: string
}

export interface PhoneTaskRow {
  id: string
  ref: string
  title: string
  factory: { id: string; name: string; icon?: PhoneFactoryIcon }
  stage: PhoneNamed
  status: string
  tone: PhoneTaskTone
  priority: Priority
  section: string
  updatedAt: string
  actions: PhoneTaskAction[]
}

export interface PhoneTaskSection {
  key: string
  label: string
  count: number
}

export interface PhoneTasksBody {
  rows: PhoneTaskRow[]
  sections: PhoneTaskSection[]
  cursor?: string
  at: string
}

export interface PhoneTaskDetail extends PhoneTaskRow {
  description: string
  cut: boolean
  childTasks: number
  openPullRequests: number
  hierarchyRevision: string
}

export interface PhoneTaskBody {
  task: PhoneTaskDetail
}

export interface PhoneCommentRequest {
  kind: PhoneRequestKind
  stage?: PhoneNamed
  open: boolean
  requestId?: string
}

export interface PhoneCommentEntry {
  id: string
  author: string
  kind: 'note' | 'request'
  createdAt: string
  text: string
  cut: boolean
  images: number
  imageList?: PhoneImage[]
  attachments: number
  formattedBlocks: number
  request?: PhoneCommentRequest
}

export interface PhoneTaskCommentsBody {
  entries: PhoneCommentEntry[]
  cursor?: string
}

export interface PhoneTasksCursor {
  section: number
  priority: number
  rank: number
  createdAt: string
  taskId: string
}

export interface PhoneCommentsCursor {
  createdAt: string
  id: string
}

const read = reader()

function encodeCursor(value: Json): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function cursorParts(text: string): JsonArray | undefined {
  if (text.length === 0 || text.length > phoneCursorMax || !/^[A-Za-z0-9_-]+$/.test(text)) {
    return undefined
  }
  const bytes = Buffer.from(text, 'base64url')
  if (bytes.toString('base64url') !== text) return undefined
  const value = parseJson(bytes.toString('utf8'))
  return isArray(value) ? value : undefined
}

function shortText(value: Json | undefined): value is string {
  return isString(value) && value.length > 0 && value.length <= phoneTaskIdMax
}

export function encodeTasksCursor(cursor: PhoneTasksCursor): string {
  return encodeCursor([
    cursor.section,
    cursor.priority,
    cursor.rank,
    cursor.createdAt,
    cursor.taskId,
  ])
}

export function parseTasksCursor(text: string): PhoneTasksCursor | undefined {
  const parts = cursorParts(text)
  if (parts?.length !== 5) return undefined
  const [section, priority, rank, createdAt, taskId] = parts
  if (!isInteger(section) || section < 0) return undefined
  if (!isInteger(priority) || priority < 0 || priority >= priorities.length) return undefined
  if (!isNumber(rank) || !Number.isFinite(rank)) return undefined
  if (!shortText(createdAt) || !shortText(taskId)) return undefined
  return { section, priority, rank, createdAt, taskId }
}

export function encodeCommentsCursor(cursor: PhoneCommentsCursor): string {
  return encodeCursor([cursor.createdAt, cursor.id])
}

export function parseCommentsCursor(text: string): PhoneCommentsCursor | undefined {
  const parts = cursorParts(text)
  if (parts?.length !== 2) return undefined
  const [createdAt, id] = parts
  if (!shortText(createdAt) || !shortText(id)) return undefined
  return { createdAt, id }
}

function count(object: JsonObject, field: string): number {
  const value = read.integer(object, field)
  if (value < 0) throw new ParseError(field, `${field} must not be negative`)
  return value
}

function named(value: Json | undefined, field: string): PhoneNamed {
  const object = read.object(value, field)
  return { id: read.string(object, 'id'), name: read.string(object, 'name') }
}

export function parsePhoneFactoryIcon(value: Untyped): PhoneFactoryIcon {
  const object = read.object(value, 'icon')
  const kind = read.oneOf(object, 'kind', ['letter', 'symbol', 'emoji'])
  if (kind === 'emoji') return { kind, emoji: read.string(object, 'emoji') }
  const color = read.oneOf(object, 'color', factoryIconColors)
  if (kind === 'letter') return { kind, color }
  return { kind, symbol: read.oneOf(object, 'symbol', factoryIconSymbols), color }
}

function action(value: Json): PhoneTaskAction {
  if (isOneOf(value, phoneTaskActions)) return value
  throw new ParseError('actions', `actions must hold only ${phoneTaskActions.join(', ')}`)
}

function rowFields(object: JsonObject): PhoneTaskRow {
  const factory = read.object(object.factory, 'factory')
  const icon = factory.icon === undefined ? undefined : parsePhoneFactoryIcon(factory.icon)
  return {
    id: read.string(object, 'id'),
    ref: read.string(object, 'ref'),
    title: read.string(object, 'title'),
    factory: {
      id: read.string(factory, 'id'),
      name: read.string(factory, 'name'),
      ...(icon !== undefined && { icon }),
    },
    stage: named(object.stage, 'stage'),
    status: read.string(object, 'status'),
    tone: read.oneOf(object, 'tone', phoneTaskTones),
    priority: read.oneOf(object, 'priority', priorities),
    section: read.string(object, 'section'),
    updatedAt: read.string(object, 'updatedAt'),
    actions: read.list(object, 'actions').map(action),
  }
}

export function parsePhoneTaskRow(value: Untyped): PhoneTaskRow {
  return rowFields(read.object(value, 'row'))
}

export function parsePhoneTaskSection(value: Untyped): PhoneTaskSection {
  const object = read.object(value, 'section')
  return {
    key: read.string(object, 'key'),
    label: read.string(object, 'label'),
    count: count(object, 'count'),
  }
}

export function parsePhoneTasksBody(value: Untyped): PhoneTasksBody {
  const object = read.object(value, 'body')
  const cursor = read.optional(object, 'cursor', read.string)
  return {
    rows: read.list(object, 'rows').map(parsePhoneTaskRow),
    sections: read.list(object, 'sections').map(parsePhoneTaskSection),
    ...(cursor !== undefined && { cursor }),
    at: read.string(object, 'at'),
  }
}

export function parsePhoneTaskBody(value: Untyped): PhoneTaskBody {
  const object = read.object(value, 'body')
  const task = read.object(object.task, 'task')
  return {
    task: {
      ...rowFields(task),
      description: read.string(task, 'description'),
      cut: read.boolean(task, 'cut'),
      childTasks: count(task, 'childTasks'),
      openPullRequests: count(task, 'openPullRequests'),
      hierarchyRevision: read.string(task, 'hierarchyRevision'),
    },
  }
}

export function parsePhoneTaskCreatedBody(value: Untyped): PhoneTaskCreatedBody {
  const object = read.object(value, 'body')
  const startRefused = read.optional(object, 'startRefused', read.string)
  return {
    ...parsePhoneTaskBody(object),
    ...(startRefused !== undefined && { startRefused }),
  }
}

export function parsePhoneFactoriesBody(value: Untyped): PhoneFactoriesBody {
  const object = read.object(value, 'body')
  return {
    factories: read.list(object, 'factories').map((entry) => {
      const factory = read.object(entry, 'factory')
      const icon = factory.icon === undefined ? undefined : parsePhoneFactoryIcon(factory.icon)
      return {
        key: read.string(factory, 'key'),
        name: read.string(factory, 'name'),
        ...(icon !== undefined && { icon }),
        defaultPriority: read.oneOf(factory, 'defaultPriority', priorities),
      }
    }),
  }
}

function parseCommentRequest(value: Json | undefined): PhoneCommentRequest {
  const object = read.object(value, 'request')
  const stage = object.stage === undefined ? undefined : named(object.stage, 'stage')
  const requestId = read.optional(object, 'requestId', read.string)
  const open = read.boolean(object, 'open')
  if (requestId !== undefined && !open) {
    throw new ParseError('requestId', 'only an open request has a requestId')
  }
  return {
    kind: read.oneOf(object, 'kind', phoneRequestKinds),
    ...(stage !== undefined && { stage }),
    open,
    ...(requestId !== undefined && { requestId }),
  }
}

export function parsePhoneCommentEntry(value: Untyped): PhoneCommentEntry {
  const object = read.object(value, 'entry')
  const kind = read.oneOf(object, 'kind', ['note', 'request'])
  if ((kind === 'request') !== (object.request !== undefined)) {
    throw new ParseError('request', 'a request entry, and only one, has request')
  }
  const request = kind === 'request' ? parseCommentRequest(object.request) : undefined
  const imageList = read.optional(object, 'imageList', (o, f) =>
    read.list(o, f).map((entry) => parsePhoneImage(entry, 'imageList')),
  )
  return {
    id: read.string(object, 'id'),
    author: read.string(object, 'author'),
    kind,
    createdAt: read.string(object, 'createdAt'),
    text: read.string(object, 'text'),
    cut: read.boolean(object, 'cut'),
    images: count(object, 'images'),
    ...(imageList !== undefined && { imageList }),
    attachments: count(object, 'attachments'),
    formattedBlocks: count(object, 'formattedBlocks'),
    ...(request !== undefined && { request }),
  }
}

export function parsePhoneTaskCommentsBody(value: Untyped): PhoneTaskCommentsBody {
  const object = read.object(value, 'body')
  const cursor = read.optional(object, 'cursor', read.string)
  return {
    entries: read.list(object, 'entries').map(parsePhoneCommentEntry),
    ...(cursor !== undefined && { cursor }),
  }
}
