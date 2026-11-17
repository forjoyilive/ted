import type { Attachment, Priority } from './task.ts'
import { trimEndOf, urlTrailingPunctuation } from './trim.ts'

export type LinearKeyPlace = 'keyring' | 'file'

export type LinearKeyState =
  | 'no-key'
  | 'connected'
  | 'invalid'
  | 'unreachable'
  | 'no-keyring'
  | 'locked'

export interface LinearStatus {
  state: LinearKeyState
  keyring: 'macos-keychain' | 'secret-service'
  last4?: string
  storedIn?: LinearKeyPlace
  user?: string
  workspace?: string
  error?: string
}

export interface SaveLinearKeyRequest {
  key: string
  inFile?: boolean
}

export interface LinearIssue {
  url: string
  identifier: string
  title: string
  priority: Priority
  team?: LinearTeam
  branchName?: string
  description?: string
  files?: LinearFile[]
  unfetched?: LinearUnfetched[]
  discussionWarning?: string
}

export interface LinearTeam {
  key: string
  name: string
}

export interface LinearFile extends Attachment {
  url: string
}

export interface LinearUnfetched {
  name: string
  url: string
  reason: string
}

export type LinearLookup =
  | { state: 'found'; issue: LinearIssue }
  | { state: 'no-key' }
  | { state: 'failed'; error: string }

export interface LinearIssueLink {
  identifier: string
  url: string
}

export const maxLinearIssueLinks = 50

export function isLinearIdentifier(text: string): boolean {
  return /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/.test(text)
}

export interface LinearLookupRequest {
  url: string
}

export interface LinearUrl {
  url: string
  workspace: string
  identifier: string
}

export const linearKeyPage = 'https://linear.app/settings/account/security'

const linearIssueUrl =
  /https:\/\/linear\.app\/([a-z0-9][a-z0-9-]*)\/issue\/([a-z][a-z0-9]*-\d+)(?:\/[^\s<>()"'?#]*)?/i

export function findLinearUrl(text: string): LinearUrl | undefined {
  const found = linearIssueUrl.exec(text)
  if (!found) return undefined
  const [url, workspace = '', identifier = ''] = found
  return {
    url: trimEndOf(url, urlTrailingPunctuation),
    workspace: workspace.toLowerCase(),
    identifier: identifier.toUpperCase(),
  }
}

export function isLinearTeamKey(text: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(text)
}

export function parseLinearUrl(text: string): LinearUrl | undefined {
  const trimmed = text.trim()
  const found = findLinearUrl(trimmed)
  if (!found || !trimmed.startsWith(found.url)) return undefined
  const rest = trimmed.slice(found.url.length)
  return rest === '' || /^[?#]\S*$/.test(rest) ? found : undefined
}

export interface LinearIntakeScope {
  kind: 'team' | 'project'
  id: string
  name: string
  workspaceId: string
  workspace: string
}

export interface LinearIntakeChoices {
  workspaceId: string
  workspace: string
  teams: { id: string; name: string; key: string }[]
  projects: { id: string; name: string }[]
}

export function isLinearIntakeScope(value: unknown): value is LinearIntakeScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const scope = value as Record<string, unknown>
  const id = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v)
  return (
    (scope.kind === 'team' || scope.kind === 'project') &&
    id(scope.id) &&
    id(scope.workspaceId) &&
    typeof scope.name === 'string' &&
    scope.name.trim().length > 0 &&
    scope.name.length <= 500 &&
    typeof scope.workspace === 'string' &&
    /^[a-z0-9][a-z0-9-]{0,99}$/.test(scope.workspace) &&
    Object.keys(scope).every((key) =>
      ['kind', 'id', 'name', 'workspaceId', 'workspace'].includes(key),
    )
  )
}

export interface AllowLinearTeamRequest {
  factoryId: string
  team: string
}

export interface SetFactoryLinearIntakeRequest {
  scope: LinearIntakeScope | null
}
