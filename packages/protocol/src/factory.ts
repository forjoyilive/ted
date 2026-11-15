import type { FactoryIcon } from './factory-icon.ts'
import type { PermissionMode } from './run.ts'
export interface LocalFolder {
  path: string
  found: boolean
}

export interface FactoryRepo {
  repo: string
  name: string
  localFolder?: LocalFolder
}

export type RepoCloneState = 'waiting' | 'cloning' | 'fetching' | 'cloned' | 'shared' | 'failed'

export interface RepoSetup {
  repo: string
  state: RepoCloneState
  percent?: number
  detail?: string
  sharedWith?: string
  error?: string
  suggestSetupGit?: boolean
}

export interface Factory {
  id: string
  key: string
  name: string
  repo: string
  defaultBranch: string
  localFolder?: LocalFolder
  repos: FactoryRepo[]
  autoStartBacklog: boolean
  icon?: FactoryIcon
  cloned: boolean
  hasSettings?: true
  setup?: RepoSetup[]
  position: number
  createdAt: string
}

export interface ReorderFactoriesRequest {
  factoryIds: string[]
}

export interface TaskRef {
  id: string
  displayId: string
  title: string
}

export interface FactoryRemoval {
  factoryId: string
  key: string
  name: string
  tasks: number
  runs: number
  worktrees: number
  openPullRequests: number
  clones: string[]
  sharedClones: string[]
}

export interface RemoveFactoryRequest {
  key: string
  closePullRequests: boolean
}

export interface RepoRemoval {
  repo: string
  name: string
  openTasks: TaskRef[]
}

export interface AddFactoryRequest {
  repo: string
  key: string
  localFolder?: string
}

export interface SetLocalFolderRequest {
  path: string
}

export type RepoSource = { folder: string } | { remote: string }

export interface CheckRepoRequest {
  source: RepoSource
  primary: boolean
}

export type RepoProblemKind =
  | 'invalid'
  | 'no-folder'
  | 'no-remote'
  | 'primary-elsewhere'
  | 'read-only'
  | 'not-found'
  | 'empty'
  | 'github'
  | 'failed'

export type RepoFix =
  | { kind: 'open-factory'; factoryId: string; factoryName: string }
  | { kind: 'check-again' }
  | { kind: 'github-settings' }
  | { kind: 'choose-folder' }

export interface RepoProblem {
  kind: RepoProblemKind
  text: string
  detail?: string
  fixes: RepoFix[]
}

export interface RepoCheck {
  repo?: string
  folder?: string
  name?: string
  defaultBranch?: string
  ok: boolean
  problem?: RepoProblem
  notes: string[]
}

export interface NewFactoryRepo {
  source: RepoSource
  name: string
}

export interface CreateFactoryRequest {
  name: string
  key: string
  repos: NewFactoryRepo[]
}

export const repoNamePattern = /^[a-z0-9-]+$/

export function keyProblem(
  key: string,
  factories: readonly { key: string; name: string }[],
): string | undefined {
  if (key === '') return 'Choose a key.'
  if (!/^[A-Z][A-Z0-9]{1,4}$/.test(key)) {
    return 'A key is 2 to 5 uppercase letters or digits, starting with a letter.'
  }
  const taken = factories.find((f) => f.key === key)
  if (taken) return `${key} is already the key of ${taken.name}.`
  return undefined
}

export function suggestKey(name: string, factories: readonly { key: string }[] = []): string {
  const words = name
    .replace(/[’']s\b/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w !== '' && /^[A-Za-z]/.test(w) === true)
  const initials = words.map((w) => w[0]?.toUpperCase() ?? '').join('')
  const first = words[0]?.toUpperCase().replace(/[^A-Z0-9]/g, '') ?? ''
  const consonant = /[B-DF-HJ-NP-TV-Z0-9]/.exec(first.slice(1))?.[0] ?? first.charAt(1)
  const base = initials.length >= 2 ? initials.slice(0, 5) : `${first.charAt(0)}${consonant}`
  if (base.length < 2) return base
  const used = new Set(factories.map((f) => f.key))
  if (!used.has(base)) return base
  for (let n = 2; n < 10; n++) {
    const next = `${base.slice(0, 4)}${n}`
    if (!used.has(next)) return next
  }
  return base
}

export function suggestFactoryName(repo: string): string {
  const name = repo.split('/').at(-1) ?? repo
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export function suggestRepoName(repo: string): string {
  const name = (repo.split('/').at(-1) ?? repo).toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  return name.replace(/^-+|-+$/g, '') || 'repo'
}

export interface AutoStartBacklogRequest {
  enabled: boolean
}
export interface SetRepoFolderRequest {
  path: string
}
export interface StopCheckTryRequest {
  name: string
}

export interface SetFactoryNotificationsRequest {
  inboxItems?: boolean
  taskMerged?: boolean
}

export interface SetFactoryPermissionsRequest {
  mode: PermissionMode
  confirmBypass?: boolean
}
