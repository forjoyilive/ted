import {
  type GitHubIntakeScope,
  type GitHubIssueUrl,
  parseGitHubIssueUrl,
  sameGitHubLabel,
  type Task,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'
import type { GitHubIssueRead, GitHubUnreadable } from '../github/issues.ts'
import type { TedStore } from '../store/index.ts'
import type { SourceClash } from './sources.ts'

export const githubUnreadableWhy: Record<GitHubUnreadable, string> = {
  'gh-missing': 'TED can’t find the GitHub CLI. Check it under Settings → Integrations → GitHub',
  'signed-out': 'the GitHub CLI isn’t signed in. Sign in under Settings → Integrations → GitHub',
  'not-found': 'GitHub couldn’t find it, or your GitHub login can’t open it. Check the link',
  'rate-limit': 'GitHub’s rate limit was reached. Wait a few minutes',
  failed: 'GitHub didn’t answer as expected. Try again later',
}

export function githubIntakeRefusal(input: {
  label: string
  read: GitHubIssueRead
  repos: readonly string[]
  scope: GitHubIntakeScope | undefined
  tracked: (url: string) => SourceClash | undefined
}): string | undefined {
  const { label, read, scope } = input
  if (read.state === 'outside-factory') {
    return `${label} isn’t in one of this Factory’s repos (${input.repos.join(', ')}). Leave it for another Factory.`
  }
  if (read.state === 'unreadable') {
    return `TED couldn’t read GitHub issue ${label} to check it against this Factory’s GitHub intake: ${githubUnreadableWhy[read.reason]}. Leave it for now.`
  }
  const { issue } = read
  if (issue.state !== 'open') {
    return `${label} is closed on GitHub. An Automation brings in only open issues; leave it.`
  }
  if (scope && !issue.labels.some((name) => sameGitHubLabel(name, scope.label))) {
    return issue.allLabels
      ? `${label} doesn’t have the label ${JSON.stringify(scope.label)}, which this Factory’s GitHub intake requires. Leave it until a maintainer adds the label.`
      : `TED couldn’t read all of ${label}’s labels, so it can’t confirm the label ${JSON.stringify(scope.label)} that this Factory’s GitHub intake requires. Leave it.`
  }
  const parent = issue.parent
  const clash = parent && input.tracked(parent.url)
  if (parent && clash) return parentText(label, parent, clash)
  return undefined
}

export function trackedParentRefusal(
  issue: GitHubIssueUrl,
  parent: GitHubIssueUrl,
  clash: SourceClash,
): string {
  return parentText(`${issue.owner}/${issue.repo}#${issue.number}`, parent, clash)
}

function parentText(label: string, parent: GitHubIssueUrl, clash: SourceClash): string {
  const parentLabel = `${parent.owner}/${parent.repo}#${parent.number}`
  return `${label} is a sub-issue of ${parentLabel}, which this Factory already tracks as ${clash.task.displayId}. Leave it; that Task covers it.`
}

export function githubIntakeScope(
  store: Pick<TedStore, 'settings'>,
  factoryId: string,
): { scope: GitHubIntakeScope | undefined; unchanged: () => void } {
  const scope = store.settings().githubIntakeScopes[factoryId]
  return {
    scope,
    unchanged() {
      if (store.settings().githubIntakeScopes[factoryId]?.label !== scope?.label) {
        throw new RequestError(
          409,
          'The Factory’s GitHub intake setting changed. Try creating the Task again.',
        )
      }
    },
  }
}

export function automationGitHubTask(task: Pick<Task, 'createdBy' | 'source'>): boolean {
  return (
    task.createdBy === 'automation' &&
    task.source !== undefined &&
    parseGitHubIssueUrl(task.source.url) !== undefined
  )
}
