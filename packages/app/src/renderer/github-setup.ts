import type {
  GitHubSetupChoice,
  GitHubSetupPlan,
  GitHubSetupStep,
} from '@ted/protocol/github-setup'
import { filesToCommit } from '@ted/protocol/github-setup'
import { plural } from './words.ts'

export function suggestedRepoName(folder: string): string {
  const base = folder.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
  return base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
}

const listed = (items: readonly string[]) =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

export function stepLabel(
  step: GitHubSetupStep,
  plan: GitHubSetupPlan,
  choice: GitHubSetupChoice,
): string {
  switch (step) {
    case 'init':
      return 'Start git in this folder'
    case 'ignore':
      return `Write a .gitignore that leaves out ${listed(choice.leaveOut)}`
    case 'commit':
      return `Commit ${plural(filesToCommit(plan, choice.leaveOut), 'file')} on ${choice.branch} as “Initial commit”`
    case 'create':
      return `Create the private repo ${choice.owner}/${choice.name}`
    case 'push':
      return `Add it as the remote ${plan.remoteName} and push ${choice.branch}`
  }
}
