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
    if (!facts.allowed) return { state: 'not-allowed' }
    if (!facts.switchOn) return { state: 'off' }
    if (facts.connection.known) {
      if (facts.connection.account === undefined) return { state: 'disconnected' }
      if (facts.allowedAccount !== facts.connection.account) return { state: 'other-account' }
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
