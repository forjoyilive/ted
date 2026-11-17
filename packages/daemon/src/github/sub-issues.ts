import type { GitHubIssueUrl } from '@ted/protocol'
import type { Gh } from './gh.ts'
import {
  type GitHubIssue,
  type GitHubIssueRead,
  type GitHubUnreadable,
  inFactory,
  readGitHubIssue,
} from './issues.ts'

export const maxSubIssueTasks = 100
export const maxSubIssueDepth = 8

export interface SubIssueChild {
  issue: GitHubIssue
  url: string
  parent: string
}

export type SubIssueSkip =
  | { kind: 'outside'; label: string; url: string }
  | { kind: 'tracked'; label: string; url: string; displayId: string }
  | { kind: 'limit'; label: string; url: string }

export type SubIssueTree =
  | { state: 'read'; children: SubIssueChild[]; skipped: SubIssueSkip[] }
  | { state: 'unreadable'; label: string; reason: GitHubUnreadable }

export function issueKey(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${number}`
}

export function issueUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/issues/${number}`
}

export async function readSubIssueTree(input: {
  gh: Pick<Gh, 'graphql'>
  root: GitHubIssue
  factoryRepos: readonly string[]
  tracked: (url: string) => string | undefined
  read?: typeof readGitHubIssue
}): Promise<SubIssueTree> {
  const read = input.read ?? readGitHubIssue
  const children: SubIssueChild[] = []
  const skipped: SubIssueSkip[] = []
  const seen = new Set([issueKey(input.root.repo, input.root.number)])
  let level: GitHubIssue[] = [input.root]
  for (let depth = 1; level.length > 0; depth++) {
    const next: GitHubIssue[] = []
    for (const parent of level) {
      const parentLabel = `${parent.repo}#${parent.number}`
      if (!parent.subIssuesComplete) {
        return { state: 'unreadable', label: parentLabel, reason: 'failed' }
      }
      for (const ref of parent.subIssues) {
        const key = issueKey(ref.repo, ref.number)
        if (ref.state === 'closed' || seen.has(key)) continue
        seen.add(key)
        const label = `${ref.repo}#${ref.number}`
        const url = issueUrl(ref.repo, ref.number)
        if (!inFactory(ref.repo, input.factoryRepos)) {
          skipped.push({ kind: 'outside', label, url })
          continue
        }
        const displayId = input.tracked(url)
        if (displayId !== undefined) {
          skipped.push({ kind: 'tracked', label, url, displayId })
          continue
        }
        if (depth > maxSubIssueDepth || children.length >= maxSubIssueTasks) {
          skipped.push({ kind: 'limit', label, url })
          continue
        }
        const [owner = '', repo = ''] = ref.repo.split('/')
        const link: GitHubIssueUrl = { owner, repo, number: ref.number, url }
        const found: GitHubIssueRead = await read(input.gh, link, input.factoryRepos)
        if (found.state === 'unreadable') {
          return { state: 'unreadable', label, reason: found.reason }
        }
        if (found.state === 'outside-factory') {
          skipped.push({ kind: 'outside', label, url })
          continue
        }
        if (found.issue.state === 'closed') continue
        seen.add(issueKey(found.issue.repo, found.issue.number))
        children.push({ issue: found.issue, url, parent: issueKey(parent.repo, parent.number) })
        next.push(found.issue)
      }
    }
    level = next
  }
  return { state: 'read', children, skipped }
}

const unreadableWhy: Record<GitHubUnreadable, string> = {
  'gh-missing': 'Ted can’t find the GitHub CLI',
  'signed-out': 'the GitHub CLI isn’t signed in',
  'not-found': 'GitHub couldn’t find it, or your GitHub login can’t open it',
  'rate-limit': 'GitHub’s rate limit was reached',
  failed: 'GitHub didn’t answer as expected',
}

export function subIssueNote(rootLabel: string, rootUrl: string, tree: SubIssueTree): string[] {
  if (tree.state === 'unreadable') {
    return [
      `Ted couldn’t read the sub-issues of GitHub issue ${rootLabel} (at ${tree.label}: ${unreadableWhy[tree.reason]}), so it created no child Tasks. Add them as Tasks yourself from ${rootUrl}`,
    ]
  }
  if (tree.skipped.length === 0) return []
  const why = (skip: SubIssueSkip) =>
    skip.kind === 'outside'
      ? 'in a repo outside this Factory'
      : skip.kind === 'tracked'
        ? `already tracked as ${skip.displayId}`
        : `past Ted’s limit of ${maxSubIssueTasks} child Tasks or ${maxSubIssueDepth} levels`
  const count = tree.skipped.length
  return [
    [
      `Ted didn’t make child Tasks for ${count} open ${count === 1 ? 'sub-issue' : 'sub-issues'} of GitHub issue ${rootLabel}, or for anything under ${count === 1 ? 'it' : 'them'}:`,
      ...tree.skipped.map((skip) => `- ${skip.label}: ${why(skip)}. ${skip.url}`),
    ].join('\n'),
  ]
}

export function withoutTracked(
  tree: SubIssueTree,
  tracked: (url: string) => string | undefined,
): SubIssueTree {
  if (tree.state !== 'read') return tree
  const dropped = new Set<string>()
  const skipped = [...tree.skipped]
  const children = tree.children.filter((child) => {
    const key = issueKey(child.issue.repo, child.issue.number)
    if (dropped.has(child.parent)) {
      dropped.add(key)
      return false
    }
    const displayId = tracked(child.url)
    if (displayId === undefined) return true
    dropped.add(key)
    skipped.push({
      kind: 'tracked',
      label: `${child.issue.repo}#${child.issue.number}`,
      url: child.url,
      displayId,
    })
    return false
  })
  return { state: 'read', children, skipped }
}
