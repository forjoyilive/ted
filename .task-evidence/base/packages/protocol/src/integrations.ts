export const minGhVersion = '2.81.0'

export interface FixCommand {
  label: string
  command: string
}

export const integrationInstallPages = {
  git: 'https://git-scm.com/install/linux',
  gh: 'https://github.com/cli/cli/blob/trunk/docs/install_linux.md',
} as const

export type IntegrationRemedy = FixCommand | { label: string; url: string }

export type GitHubCliState = 'ready' | 'not-installed' | 'too-old' | 'failed'

export interface GitHubCli {
  state: GitHubCliState
  version?: string
  path?: string
  error?: string
  fix?: IntegrationRemedy
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
  fix?: IntegrationRemedy
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

export type RunFixResult = { command: string } | { url: string }
