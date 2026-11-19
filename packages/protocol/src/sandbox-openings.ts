import type { PermissionMode } from './run.ts'
import type { LayerKind } from './workflow.ts'

export const networkLevels = ['none', 'localhost', 'outbound'] as const
export type NetworkLevel = (typeof networkLevels)[number]
export const defaultNetwork: NetworkLevel = 'localhost'

export interface ElectronApp {
  repo: string
  name: string
}

export type NetworkGrant =
  | { place: 'factory'; from: LayerKind }
  | { place: 'worktree'; repo: string }
  | { place: 'app'; repo: string; app: string }
  | { place: 'check'; check: string }

export interface SandboxOpeningsInput {
  permissions: PermissionMode
  appsOutsideSandbox: readonly string[]
  piUnsandboxedAllowed: boolean
  sockets: readonly string[]
  socketsFrom?: LayerKind
  electronApps: readonly ElectronApp[]
  networkGrants?: readonly NetworkGrant[]
}

export type SandboxOpening =
  | { kind: 'bypass'; unsandboxed: true }
  | { kind: 'app-outside'; unsandboxed: true; app: string }
  | { kind: 'pi-unsandboxed'; unsandboxed: true }
  | { kind: 'socket'; unsandboxed: false; socket: string; from: LayerKind }
  | { kind: 'electron-app'; unsandboxed: false; repo: string; app: string }
  | { kind: 'network'; unsandboxed: false; grant: NetworkGrant }

export type SandboxSummary =
  | { kind: 'closed' }
  | { kind: 'widened'; count: number }
  | { kind: 'unsandboxed'; count: number }

export function sandboxOpenings(input: SandboxOpeningsInput): SandboxOpening[] {
  const bypass = input.permissions === 'bypass'
  const openings: SandboxOpening[] = []
  if (bypass) openings.push({ kind: 'bypass', unsandboxed: true })
  for (const app of new Set(input.appsOutsideSandbox)) {
    openings.push({ kind: 'app-outside', unsandboxed: true, app })
  }
  if (input.piUnsandboxedAllowed && !bypass) {
    openings.push({ kind: 'pi-unsandboxed', unsandboxed: true })
  }
  for (const socket of new Set(input.sockets)) {
    openings.push({
      kind: 'socket',
      unsandboxed: false,
      socket,
      from: input.socketsFrom ?? 'factory',
    })
  }
  for (const { repo, name } of input.electronApps) {
    openings.push({ kind: 'electron-app', unsandboxed: false, repo, app: name })
  }
  for (const grant of input.networkGrants ?? []) {
    openings.push({ kind: 'network', unsandboxed: false, grant })
  }
  return openings
}

export function sandboxSummary(openings: readonly SandboxOpening[]): SandboxSummary {
  const unsandboxed = openings.filter((o) => o.unsandboxed).length
  if (unsandboxed > 0) return { kind: 'unsandboxed', count: unsandboxed }
  if (openings.length > 0) return { kind: 'widened', count: openings.length }
  return { kind: 'closed' }
}
