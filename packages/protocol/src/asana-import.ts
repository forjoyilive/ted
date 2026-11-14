import { type Priority, priorities } from './task.ts'
import { bodyObject, RequestValidationError } from './validation.ts'

export const maxAsanaImportTasks = 100
export const maxAsanaImportDepth = 10
export const maxAsanaComments = 100
export const maxAsanaFiles = 20

export interface AsanaTaskUrl {
  url: string
  gid: string
}

const asanaUrl = /https:\/\/app\.asana\.com\/[^\s<>()"'`]+/i
const gidPattern = /^\d{1,32}$/

export function findAsanaUrl(text: string): AsanaTaskUrl | undefined {
  for (const match of text.matchAll(new RegExp(asanaUrl, 'gi'))) {
    const url = match[0].replace(/[.,;:!?]+$/, '')
    const gid = asanaGid(url)
    if (gid !== undefined) return { url, gid }
  }
  return undefined
}

export function parseAsanaTaskUrl(text: string): AsanaTaskUrl | undefined {
  const trimmed = text.trim()
  const gid = asanaGid(trimmed)
  return gid === undefined ? undefined : { url: trimmed, gid }
}

function asanaGid(text: string): string | undefined {
  if (!URL.canParse(text)) return undefined
  const url = new URL(text)
  if (url.protocol !== 'https:' || url.host.toLowerCase() !== 'app.asana.com') return undefined
  if (url.username || url.password) return undefined
  const parts = url.pathname.split('/').filter((part) => part !== '')
  if (parts[0] === '0') {
    const rest = parts.at(-1) === 'f' ? parts.slice(1, -1) : parts.slice(1)
    const [project, task] = rest
    if (rest.length !== 2 || project === undefined || task === undefined) return undefined
    return gidPattern.test(project) && gidPattern.test(task) && task !== '0' ? task : undefined
  }
  if (parts[0] === '1') {
    const at = Math.max(parts.lastIndexOf('task'), parts.lastIndexOf('item'))
    const task = at > 1 ? parts[at + 1] : undefined
    return task !== undefined && gidPattern.test(task) && task !== '0' ? task : undefined
  }
  return undefined
}

export interface AsanaPerson {
  name: string
  you: boolean
}

export type AsanaImportAction =
  | { kind: 'new' }
  | { kind: 'kept'; taskId: string; displayId: string }
  | { kind: 'linked'; taskId: string; displayId: string }
  | { kind: 'done'; taskId: string; displayId: string }
  | { kind: 'complete' }
  | { kind: 'archived'; taskId: string; displayId: string }
  | { kind: 'conflict'; taskId: string; displayId: string; parentDisplayId: string }
  | { kind: 'unreadable'; reason: string }

export interface AsanaImportRow {
  gid: string
  name: string
  url: string
  depth: number
  parentGid?: string
  assignee?: AsanaPerson
  completed: boolean
  action: AsanaImportAction
  problems?: string[]
}

export interface AsanaImportPreview {
  root: { gid: string; name: string; url: string; completed: boolean }
  rows: AsanaImportRow[]
  create: number
  ownership: { you: number; others: number; unassigned: number }
  tracked?: { taskId: string; displayId: string; stage: string }
  refusal?: string
  missing: number
}

export interface AsanaImportRequest {
  url: string
  factory?: string
  priority?: Priority
  start?: boolean
  addToTree?: boolean
  taskSync?: boolean
  dryRun?: boolean
  draftRevision?: string
}

export interface AsanaImportResult {
  preview: AsanaImportPreview
  root?: { taskId: string; displayId: string }
  created: { taskId: string; displayId: string }[]
  linked: { taskId: string; displayId: string }[]
}

export function parseAsanaImportRequest(value: unknown): AsanaImportRequest {
  const body = bodyObject(value)
  if (typeof body.url !== 'string' || parseAsanaTaskUrl(body.url) === undefined) {
    throw new RequestValidationError(400, 'url must be an Asana task URL')
  }
  if (body.factory !== undefined && (typeof body.factory !== 'string' || body.factory === '')) {
    throw new RequestValidationError(400, 'factory must be a Factory key')
  }
  if (body.priority !== undefined && !(priorities as readonly unknown[]).includes(body.priority)) {
    throw new RequestValidationError(400, 'priority must be none, low, medium, high or urgent')
  }
  if (
    body.draftRevision !== undefined &&
    (typeof body.draftRevision !== 'string' || !/^[\w-]{1,100}$/.test(body.draftRevision))
  ) {
    throw new RequestValidationError(400, 'draftRevision must be a draft revision')
  }
  for (const flag of ['start', 'addToTree', 'taskSync', 'dryRun'] as const) {
    if (body[flag] !== undefined && typeof body[flag] !== 'boolean') {
      throw new RequestValidationError(400, `${flag} must be true or false`)
    }
  }
  return {
    url: body.url.trim(),
    ...(body.factory !== undefined && { factory: body.factory as string }),
    ...(body.priority !== undefined && { priority: body.priority as Priority }),
    ...(body.start !== undefined && { start: body.start as boolean }),
    ...(body.addToTree !== undefined && { addToTree: body.addToTree as boolean }),
    ...(body.taskSync !== undefined && { taskSync: body.taskSync as boolean }),
    ...(body.dryRun !== undefined && { dryRun: body.dryRun as boolean }),
    ...(body.draftRevision !== undefined && { draftRevision: body.draftRevision as string }),
  }
}

export function ownershipLine(preview: Pick<AsanaImportPreview, 'create' | 'ownership'>): string {
  const { create, ownership } = preview
  const parts = [
    ownership.you > 0 && `${ownership.you} assigned to you`,
    ownership.others > 0 && `${ownership.others} to others`,
    ownership.unassigned > 0 && `${ownership.unassigned} unassigned`,
  ].filter((part): part is string => typeof part === 'string')
  const count = `${create} ${create === 1 ? 'Task' : 'Tasks'}`
  return parts.length === 0 ? count : `${count}: ${parts.join(', ')}`
}

export interface AsanaMissing {
  rootGid: string
  items: { gid: string; name: string; url: string; reason: string }[]
}

export type AsanaUnfinishedReason = 'new' | 'skipped' | 'archived' | 'unreadable' | 'over-limit'

export interface AsanaUnfinishedItem {
  key: string
  gid: string
  name: string
  url: string
  reason: AsanaUnfinishedReason
  detail?: string
}

export interface AsanaUnfinished {
  parentGid: string
  items: AsanaUnfinishedItem[]
}

export const asanaAddChoice = 'Add them as Tasks'
export const asanaCompleteChoice = 'Complete it in Asana anyway'
export const asanaLeaveOpenChoice = 'Leave it open in Asana'

export function asanaImportable(item: Pick<AsanaUnfinishedItem, 'reason'>): boolean {
  return item.reason === 'new' || item.reason === 'skipped'
}
