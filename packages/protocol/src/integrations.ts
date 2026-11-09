export const minGhVersion = '2.81.0'

export interface FixCommand {
  label: string
  command: string
}

export type GitHubCliState = 'ready' | 'not-installed' | 'too-old' | 'failed'

export interface GitHubCli {
  state: GitHubCliState
  version?: string
  path?: string
  error?: string
  fix?: FixCommand
}

export type GitHubHostState = 'ready' | 'signed-out' | 'missing-workflow-scope' | 'failed'

export interface GitHubHost {
  host: string
  state: GitHubHostState
  login?: string
  tokenSource?: string
  gitProtocol?: string
  scopes: string[]
  usedBy: string[]
  error?: string
  fix?: FixCommand
}

export type GitState = 'ready' | 'not-installed' | 'no-identity'

export interface GitHealth {
  state: GitState
  version?: string
  path?: string
  name?: string
  email?: string
  fix?: FixCommand
  copy?: string[]
}

export interface IntegrationsHealth {
  github: { cli: GitHubCli; hosts: GitHubHost[] }
  git: GitHealth
  checkedAt: string
}

export const integrationFixes = [
  'gh-install',
  'gh-update',
  'gh-login',
  'gh-refresh',
  'gh-setup-git',
  'git-install',
] as const

export type IntegrationFix = (typeof integrationFixes)[number]

export interface RunFixRequest {
  fix: IntegrationFix
  host?: string
}

export interface RunFixResult {
  command: string
}
