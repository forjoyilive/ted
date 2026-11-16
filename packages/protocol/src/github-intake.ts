import { reader, type Untyped } from './parse.ts'
import { bodyObject, RequestValidationError } from './validation.ts'

export const maxGitHubLabelLength = 50

export interface GitHubIntakeScope {
  label: string
}

export interface SetFactoryGitHubIntakeRequest {
  scope: GitHubIntakeScope | null
}

export function isGitHubLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= maxGitHubLabelLength &&
    !/\p{Cc}/u.test(value)
  )
}

export function isGitHubIntakeScope(value: unknown): value is GitHubIntakeScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const scope = value as Record<string, unknown>
  return isGitHubLabel(scope.label) && Object.keys(scope).every((key) => key === 'label')
}

export function sameGitHubLabel(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export function parseSetFactoryGitHubIntakeRequest(value: unknown): SetFactoryGitHubIntakeRequest {
  const body = bodyObject(value)
  if (body.scope === null) return { scope: null }
  const scope = bodyObject(body.scope)
  const label = typeof scope.label === 'string' ? scope.label.trim() : scope.label
  if (!isGitHubIntakeScope({ ...scope, label })) {
    throw new RequestValidationError(
      400,
      `Type a GitHub label of 1 to ${maxGitHubLabelLength} characters, or null for any open issue`,
    )
  }
  return { scope: { label: label as string } }
}

export const maxGitHubIntakeTasks = 100

export interface GitHubIntakeRequest {
  factory?: string
}

export interface GitHubIntakeTaskRef {
  taskId: string
  displayId: string
}

export interface GitHubIntakeImported {
  url: string
  issue: string
  root: GitHubIntakeTaskRef
  created: GitHubIntakeTaskRef[]
}

export interface GitHubIntakeSkipped {
  url: string
  issue: string
  reason: string
}

export interface GitHubIntakeUnlisted {
  repo: string
  reason: string
}

export interface GitHubIntakeResult {
  label: string
  imported: GitHubIntakeImported[]
  skipped: GitHubIntakeSkipped[]
  tracked: number
  left: number
  unlisted: GitHubIntakeUnlisted[]
  incomplete?: string
  stopped?: string
}

const readIntake = reader((message) => {
  throw new RequestValidationError(400, message)
})

export function parseGitHubIntakeRequest(value: Untyped): GitHubIntakeRequest {
  if (value === undefined || value === null) return {}
  const body = readIntake.object(value, 'request', 'the request must be an object')
  const factory = readIntake.optional(body, 'factory', (object, field) =>
    readIntake.string(object, field, 'factory must be a Factory key'),
  )
  if (factory === '') throw new RequestValidationError(400, 'factory must be a Factory key')
  return factory === undefined ? {} : { factory }
}
