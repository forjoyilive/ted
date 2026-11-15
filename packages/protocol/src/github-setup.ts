export interface GitHubSetupPlanRequest {
  folder: string
}

export interface LeaveOutCandidate {
  path: string
  files: number
  secret: boolean
}

export interface OtherRemote {
  name: string
  url: string
}

export interface GitHubSetupPlan {
  folder: string
  git: boolean
  commits: boolean
  branch?: string
  uncommitted: number
  files: number
  hasIgnoreFile: boolean
  leaveOut: LeaveOutCandidate[]
  otherRemote?: OtherRemote
  remoteName: string
  owners: string[]
  signedIn: boolean
}

export interface GitHubNameRequest {
  owner: string
  name: string
}

export interface GitHubNameCheck {
  available: boolean
}

export const gitHubSetupSteps = ['init', 'ignore', 'commit', 'create', 'push'] as const
export type GitHubSetupStep = (typeof gitHubSetupSteps)[number]

export interface GitHubSetupChoice {
  owner: string
  name: string
  description: string
  branch: string
  leaveOut: string[]
}

export interface GitHubSetupStepRequest extends GitHubSetupChoice {
  folder: string
  step: GitHubSetupStep
}

export interface GitHubSetupStepResult {
  done: boolean
}

export const gitHubNameLimit = 100
export const gitHubOwnerLimit = 39
export const gitHubDescriptionLimit = 350
export const branchNameLimit = 100

export function gitHubNameProblem(name: string): string | undefined {
  if (name === '') return 'Choose a name.'
  if (name.length > gitHubNameLimit) return `Use at most ${gitHubNameLimit} characters.`
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    return 'Use letters, digits, ., - and _ only.'
  }
  return undefined
}

export function isGitHubOwner(owner: string): boolean {
  return (
    owner.length <= gitHubOwnerLimit && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner)
  )
}

export function branchNameProblem(branch: string): string | undefined {
  if (branch === '') return 'Choose a branch name.'
  if (
    branch.length > branchNameLimit ||
    !/^[A-Za-z0-9._/-]+$/.test(branch) ||
    /^[-/.]|[/.]$|\.\.|\/\/|\.lock$|@\{/.test(branch)
  ) {
    return 'Use letters, digits, ., -, _ and / only.'
  }
  return undefined
}

export function setupSteps(plan: GitHubSetupPlan, choice: GitHubSetupChoice): GitHubSetupStep[] {
  const steps: GitHubSetupStep[] = []
  if (!plan.git) steps.push('init')
  if (!plan.commits) {
    if (choice.leaveOut.length > 0 && !plan.hasIgnoreFile) steps.push('ignore')
    steps.push('commit')
  }
  steps.push('create', 'push')
  return steps
}

export function filesToCommit(plan: GitHubSetupPlan, leaveOut: readonly string[]): number {
  const left = plan.leaveOut.filter((c) => leaveOut.includes(c.path))
  return Math.max(0, plan.files - left.reduce((sum, c) => sum + c.files, 0))
}
