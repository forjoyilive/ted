import type { OutsideSandboxApproval } from './outside-sandbox.ts'
import type { PermissionMode } from './run.ts'
import type { LayerKind } from './workflow.ts'

export interface ElectronApp {
  repo: string
  name: string
}

export interface SandboxOpeningsInput {
  permissions: PermissionMode
  appsOutsideSandbox: readonly OutsideSandboxApproval[]
  piUnsandboxedAllowed: boolean
  sockets: readonly string[]
  socketsFrom?: LayerKind
  electronApps: readonly ElectronApp[]
}

export type SandboxOpening =
  | { kind: 'bypass'; unsandboxed: true }
  | { kind: 'app-outside'; unsandboxed: true; repo: string; app: string }
  | { kind: 'pi-unsandboxed'; unsandboxed: true }
  | { kind: 'socket'; unsandboxed: false; socket: string; from: LayerKind }
  | { kind: 'electron-app'; unsandboxed: false; repo: string; app: string }

export type SandboxSummary =
  | { kind: 'closed' }
  | { kind: 'widened'; count: number }
  | { kind: 'unsandboxed'; count: number }

export function sandboxOpenings(input: SandboxOpeningsInput): SandboxOpening[] {
  const bypass = input.permissions === 'bypass'
  const openings: SandboxOpening[] = []
  if (bypass) openings.push({ kind: 'bypass', unsandboxed: true })
  for (const { repo, app } of input.appsOutsideSandbox) {
    openings.push({ kind: 'app-outside', unsandboxed: true, repo, app })
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
  return openings
}

export function sandboxSummary(openings: readonly SandboxOpening[]): SandboxSummary {
  const unsandboxed = openings.filter((o) => o.unsandboxed).length
  if (unsandboxed > 0) return { kind: 'unsandboxed', count: unsandboxed }
  if (openings.length > 0) return { kind: 'widened', count: openings.length }
  return { kind: 'closed' }
}
