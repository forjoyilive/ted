import { bodyObject, RequestValidationError } from './validation.ts'

export const maxAsanaIntakeTasks = 100

export interface AsanaRef {
  gid: string
  name: string
}

export interface AsanaIntakeScope {
  workspace: AsanaRef
  project: AsanaRef
  section?: AsanaRef
}

export interface SetFactoryAsanaIntakeRequest {
  scope: AsanaIntakeScope | null
}

export interface AsanaIntakeRequest {
  factory?: string
}

export interface AsanaIntakeImported {
  gid: string
  name: string
  root: { taskId: string; displayId: string }
  created: { taskId: string; displayId: string }[]
  linked: { taskId: string; displayId: string }[]
}

export interface AsanaIntakeSkipped {
  gid: string
  name: string
  url: string
  reason: string
}

export interface AsanaIntakeResult {
  scope: AsanaIntakeScope
  imported: AsanaIntakeImported[]
  skipped: AsanaIntakeSkipped[]
  tracked: number
  left: number
  incomplete?: string
  stopped?: string
}

const isGid = (value: unknown) => typeof value === 'string' && /^\d{1,32}$/.test(value)

function isRef(value: unknown): value is AsanaRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const ref = value as Record<string, unknown>
  return (
    isGid(ref.gid) &&
    typeof ref.name === 'string' &&
    ref.name.trim().length > 0 &&
    ref.name.length <= 500 &&
    Object.keys(ref).every((key) => key === 'gid' || key === 'name')
  )
}

export function isAsanaIntakeScope(value: unknown): value is AsanaIntakeScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const scope = value as Record<string, unknown>
  return (
    isRef(scope.workspace) &&
    isRef(scope.project) &&
    (scope.section === undefined || isRef(scope.section)) &&
    Object.keys(scope).every((key) => ['workspace', 'project', 'section'].includes(key))
  )
}

export function parseSetFactoryAsanaIntakeRequest(value: unknown): SetFactoryAsanaIntakeRequest {
  const body = bodyObject(value)
  if (body.scope !== null && !isAsanaIntakeScope(body.scope)) {
    throw new RequestValidationError(
      400,
      'Choose an Asana workspace and project, and optionally a section, or null to clear',
    )
  }
  return { scope: body.scope }
}

export function parseAsanaIntakeRequest(value: unknown): AsanaIntakeRequest {
  const body = value === undefined || value === null ? {} : bodyObject(value)
  if (body.factory !== undefined && (typeof body.factory !== 'string' || body.factory === '')) {
    throw new RequestValidationError(400, 'factory must be a Factory key')
  }
  return body.factory === undefined ? {} : { factory: body.factory as string }
}

export interface AsanaChoicesPage {
  items: AsanaRef[]
  nextOffset?: string
}

export interface AsanaChoicesQuery {
  offset?: string
}

export type AsanaIntakeCheck =
  | { state: 'none' }
  | { state: 'current'; scope: AsanaIntakeScope }
  | { state: 'stale'; part: 'workspace' | 'project' | 'section'; reason: string }
  | { state: 'unreadable'; reason: string }

export const isAsanaOffset = (value: string) => /^[A-Za-z0-9_\-.:+/=]{1,512}$/.test(value)

export function parseAsanaChoicesQuery(search: string): AsanaChoicesQuery {
  const params = new URLSearchParams(search)
  for (const key of params.keys())
    if (key !== 'offset') throw new RequestValidationError(400, `unknown query parameter ${key}`)
  const offsets = params.getAll('offset')
  if (offsets.length > 1) throw new RequestValidationError(400, 'offset may be given once')
  const offset = offsets[0]
  if (offset === undefined) return {}
  if (!isAsanaOffset(offset))
    throw new RequestValidationError(400, 'offset must be the next page Asana returned')
  return { offset }
}
