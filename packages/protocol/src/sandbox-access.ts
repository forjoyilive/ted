import type { SandboxAccess } from './sandbox-groups.ts'

export const accessHolderKinds = ['app', 'check', 'setup', 'teardown'] as const
export type AccessHolderKind = (typeof accessHolderKinds)[number]

export interface AccessHolder {
  kind: AccessHolderKind
  repo?: string
  name: string
  groups: readonly SandboxAccess[]
}

export interface SandboxAccessChange {
  kind: AccessHolderKind
  repo?: string
  name: string
  gained: SandboxAccess[]
  lost: SandboxAccess[]
}

function holderKey(holder: Pick<AccessHolder, 'kind' | 'repo' | 'name'>): string {
  return JSON.stringify([holder.kind, holder.repo ?? '', holder.name])
}

export function accessChange(
  before: AccessHolder | undefined,
  after: AccessHolder | undefined,
): SandboxAccessChange | undefined {
  const holder = after ?? before
  if (!holder) return undefined
  const was = before?.groups ?? []
  const now = after?.groups ?? []
  const gained = [...new Set(now.filter((g) => !was.includes(g)))]
  const lost = [...new Set(was.filter((g) => !now.includes(g)))]
  if (gained.length === 0 && lost.length === 0) return undefined
  return {
    kind: holder.kind,
    ...(holder.repo !== undefined && { repo: holder.repo }),
    name: holder.name,
    gained,
    lost,
  }
}

function byOccurrence(holders: readonly AccessHolder[]): Map<string, AccessHolder> {
  const seen = new Map<string, number>()
  const keyed = new Map<string, AccessHolder>()
  for (const holder of holders) {
    const key = holderKey(holder)
    const n = seen.get(key) ?? 0
    seen.set(key, n + 1)
    keyed.set(`${key}#${n}`, holder)
  }
  return keyed
}

export function sandboxAccessChanges(
  before: readonly AccessHolder[],
  after: readonly AccessHolder[],
): SandboxAccessChange[] {
  const earlier = byOccurrence(before)
  const later = byOccurrence(after)
  const changes: SandboxAccessChange[] = []
  for (const [key, holder] of later) {
    const change = accessChange(earlier.get(key), holder)
    if (change) changes.push(change)
  }
  for (const [key, holder] of earlier) {
    if (later.has(key)) continue
    const change = accessChange(holder, undefined)
    if (change) changes.push(change)
  }
  return changes
}

export function accessHolderLabel(holder: Pick<AccessHolder, 'kind' | 'repo' | 'name'>): string {
  const where = holder.repo ? ` in ${holder.repo}` : ''
  switch (holder.kind) {
    case 'app':
      return `${holder.name} App${where}`
    case 'check':
      return `${holder.name} Check${where}`
    case 'setup':
      return `Worktree setup${where}`
    case 'teardown':
      return `Worktree teardown${where}`
  }
}

export function sandboxAccessChangeText(change: SandboxAccessChange): string {
  const parts = [
    ...(change.gained.length > 0 ? [`gains ${change.gained.join(', ')}`] : []),
    ...(change.lost.length > 0 ? [`loses ${change.lost.join(', ')}`] : []),
  ]
  return `${accessHolderLabel(change)} ${parts.join(' and ')}`
}
