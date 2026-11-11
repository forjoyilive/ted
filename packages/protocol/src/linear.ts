import type { Attachment, Priority } from './task.ts'

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
    url: url.replace(/[.,;:!?]+$/, ''),
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

export interface AllowLinearTeamRequest {
  factoryId: string
  team: string
}
