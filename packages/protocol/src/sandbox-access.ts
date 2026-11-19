import type { SandboxGroup } from './sandbox-groups.ts'

export const accessHolderKinds = ['app', 'check', 'setup', 'teardown'] as const
export type AccessHolderKind = (typeof accessHolderKinds)[number]

export interface AccessHolder {
  kind: AccessHolderKind
  repo?: string
  name: string
  groups: readonly SandboxGroup[]
}

export interface SandboxAccessChange {
  kind: AccessHolderKind
  repo?: string
  name: string
  gained: SandboxGroup[]
  lost: SandboxGroup[]
}

function holderKey(holder: Pick<AccessHolder, 'kind' | 'repo' | 'name'>): string {
  return JSON.stringify([holder.kind, holder.repo ?? '', holder.name])
}

export function sandboxAccessChanges(
  before: readonly AccessHolder[],
  after: readonly AccessHolder[],
): SandboxAccessChange[] {
  const earlier = new Map<string, readonly SandboxGroup[]>()
  for (const holder of before) {
    const key = holderKey(holder)
    earlier.set(key, [...(earlier.get(key) ?? []), ...holder.groups])
  }
  const changes: SandboxAccessChange[] = []
  const seen = new Set<string>()
  const compare = (holder: AccessHolder, was: readonly SandboxGroup[]) => {
    const gained = [...new Set(holder.groups.filter((g) => !was.includes(g)))]
    const lost = [...new Set(was.filter((g) => !holder.groups.includes(g)))]
    if (gained.length === 0 && lost.length === 0) return
    changes.push({
      kind: holder.kind,
      ...(holder.repo !== undefined && { repo: holder.repo }),
      name: holder.name,
      gained,
      lost,
    })
  }
  for (const holder of after) {
    const key = holderKey(holder)
    seen.add(key)
    compare(holder, earlier.get(key) ?? [])
  }
  for (const holder of before) {
    const key = holderKey(holder)
    if (seen.has(key)) continue
    seen.add(key)
    compare({ ...holder, groups: [] }, earlier.get(key) ?? [])
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
