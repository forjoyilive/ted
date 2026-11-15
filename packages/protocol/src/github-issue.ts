export interface GitHubIssueUrl {
  owner: string
  repo: string
  number: number
  url: string
}

export type GitHubIssueState = 'open' | 'closed'

export interface TaskGitHubSource {
  repo: string
  number: number
  title: string
  state: GitHubIssueState
  locked: boolean
  comments: number
  hiddenComments: number
  importedAt: string
  context: string
  outsiderText: boolean
}

const segment = /^[A-Za-z0-9_.-]+$/
const issuePath = /^\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]{0,9})\/?$/

export function parseGitHubIssueUrl(text: string): GitHubIssueUrl | undefined {
  const trimmed = text.trim()
  if (/\s/.test(trimmed) || !URL.canParse(trimmed)) return undefined
  const url = new URL(trimmed)
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return undefined
  if (host !== 'github.com' && host !== 'www.github.com') return undefined
  const match = issuePath.exec(url.pathname)
  const [, owner = '', repo = '', number = ''] = match ?? []
  if (!match || ![owner, repo].every((part) => segment.test(part) && !/^\.+$/.test(part))) {
    return undefined
  }
  const parsed = Number(number)
  if (!Number.isSafeInteger(parsed)) return undefined
  return {
    owner,
    repo,
    number: parsed,
    url: `https://github.com/${owner}/${repo}/issues/${parsed}`,
  }
}

export function gitHubIssueKey(issue: Pick<GitHubIssueUrl, 'owner' | 'repo' | 'number'>): string {
  return `github:${issue.owner.toLowerCase()}/${issue.repo.toLowerCase()}#${issue.number}`
}
