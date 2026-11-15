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
