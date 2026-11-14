import { bodyObject, RequestValidationError } from './validation.ts'

export type AsanaSyncState =
  | 'not-allowed'
  | 'off'
  | 'disconnected'
  | 'other-account'
  | 'waiting-merge'
  | 'waiting-children'
  | 'completed-by-ted'
  | 'completed-in-asana'
  | 'archived'

export interface AsanaSync {
  state: AsanaSyncState
  openChildren?: number
  completedAt?: string
  linked: number
}

export const asanaSyncing: readonly AsanaSyncState[] = [
  'waiting-merge',
  'waiting-children',
  'completed-by-ted',
  'completed-in-asana',
  'archived',
]

export interface AsanaSyncFacts {
  allowed: boolean
  allowedAccount?: string
  projectAccounts?: readonly string[]
  switchOn: boolean
  connection: { known: false } | { known: true; account?: string }
  archivedUnmerged: boolean
  completedByTed?: string
  completeInAsana: boolean
  merged: boolean
  openChildren?: number
  linked: number
}

export function asanaSyncOf(facts: AsanaSyncFacts): AsanaSync {
  const linked = facts.linked
  const state = ((): Omit<AsanaSync, 'linked'> => {
    const projectAccounts = facts.projectAccounts ?? []
    if (!facts.allowed && projectAccounts.length === 0) return { state: 'not-allowed' }
    if (!facts.switchOn) return { state: 'off' }
    if (facts.connection.known) {
      const account = facts.connection.account
      if (account === undefined) return { state: 'disconnected' }
      const byTask = facts.allowed && facts.allowedAccount === account
      if (!byTask && !projectAccounts.includes(account)) return { state: 'other-account' }
    }
    if (facts.completedByTed !== undefined)
      return { state: 'completed-by-ted', completedAt: facts.completedByTed }
    if (facts.completeInAsana) return { state: 'completed-in-asana' }
    if (facts.archivedUnmerged) return { state: 'archived' }
    if (facts.merged && facts.openChildren !== undefined && facts.openChildren > 0)
      return { state: 'waiting-children', openChildren: facts.openChildren }
    return { state: 'waiting-merge' }
  })()
  return { ...state, linked }
}

export function asanaSyncAllowable(sync: AsanaSync | undefined): boolean {
  return sync?.state === 'not-allowed' || sync?.state === 'other-account'
}

export interface AsanaProjectOption {
  gid: string
  name: string
  workspace: string
}

export interface AsanaProjectList {
  projects: AsanaProjectOption[]
  complete: boolean
}

export interface AllowAsanaProjectRequest {
  factoryId: string
  project: string
}

export type AsanaProjectListName = 'allowed' | 'declined'

export interface ForgetAsanaProjectRequest {
  factoryId: string
  project: string
  list: AsanaProjectListName
}

const projectGid = /^\d{1,32}$/

function projectFields(value: unknown): AllowAsanaProjectRequest {
  const body = bodyObject(value)
  if (typeof body.factoryId !== 'string' || body.factoryId === '') {
    throw new RequestValidationError(400, 'factoryId must be a Factory ID')
  }
  if (typeof body.project !== 'string' || !projectGid.test(body.project)) {
    throw new RequestValidationError(400, 'project must be an Asana project ID')
  }
  return { factoryId: body.factoryId, project: body.project }
}

export function parseAllowAsanaProjectRequest(value: unknown): AllowAsanaProjectRequest {
  return projectFields(value)
}

export function parseForgetAsanaProjectRequest(value: unknown): ForgetAsanaProjectRequest {
  const fields = projectFields(value)
  const list = bodyObject(value).list
  if (list !== 'allowed' && list !== 'declined') {
    throw new RequestValidationError(400, 'list must be allowed or declined')
  }
  return { ...fields, list }
}
