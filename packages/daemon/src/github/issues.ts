import type { GitHubIssueState, GitHubIssueUrl } from '@ted/protocol'
import { clean } from '../tasks/github-activity.ts'
import { type Gh, GhError } from './gh.ts'

export interface GitHubPost {
  author: string
  maintainer: boolean
  body: string
  html: string
  createdAt: string
}

export interface GitHubIssue {
  url: string
  repo: string
  number: number
  title: string
  state: GitHubIssueState
  locked: boolean
  body: GitHubPost
  comments: GitHubPost[]
  totalComments: number
  hiddenComments: number
}

export type GitHubUnreadable = 'gh-missing' | 'signed-out' | 'not-found' | 'rate-limit' | 'failed'

export type GitHubIssueRead =
  | { state: 'found'; issue: GitHubIssue }
  | { state: 'outside-factory' }
  | { state: 'unreadable'; reason: GitHubUnreadable }

export const maxIssueComments = 100
export const maxIssueBody = 20_000
export const maxIssueDiscussion = 40_000
const maxTitle = 500

const maintainers = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

const issueQuery = `query TedGitHubIssue($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number title state locked url body bodyHTML createdAt authorAssociation
      author { login }
      repository { nameWithOwner }
      comments(last: ${maxIssueComments}) {
        totalCount
        nodes { author { login } authorAssociation body bodyHTML createdAt isMinimized }
      }
    }
  }
}`

interface RawPost {
  author?: { login?: unknown } | null
  authorAssociation?: unknown
  body?: unknown
  bodyHTML?: unknown
  createdAt?: unknown
}

interface RawIssue extends RawPost {
  number?: unknown
  title?: unknown
  state?: unknown
  locked?: unknown
  url?: unknown
  repository?: { nameWithOwner?: unknown } | null
  comments?: {
    totalCount?: unknown
    nodes?: (RawPost & { isMinimized?: unknown })[] | null
  } | null
}

export function inFactory(repo: string, factoryRepos: readonly string[]): boolean {
  return factoryRepos.some((own) => own.toLowerCase() === repo.toLowerCase())
}

export async function readGitHubIssue(
  gh: Pick<Gh, 'graphql'>,
  link: GitHubIssueUrl,
  factoryRepos: readonly string[],
): Promise<GitHubIssueRead> {
  if (!inFactory(`${link.owner}/${link.repo}`, factoryRepos)) return { state: 'outside-factory' }
  let answer: unknown
  try {
    answer = await gh.graphql(issueQuery, {
      owner: link.owner,
      name: link.repo,
      number: link.number,
    })
  } catch (error) {
    return { state: 'unreadable', reason: unreadableReason(error) }
  }
  const raw = (answer as { data?: { repository?: { issue?: RawIssue | null } | null } })?.data
    ?.repository?.issue
  if (!raw) return { state: 'unreadable', reason: 'not-found' }
  const issue = parseIssue(raw)
  if (!issue) return { state: 'unreadable', reason: 'failed' }
  if (!inFactory(issue.repo, factoryRepos)) return { state: 'outside-factory' }
  return { state: 'found', issue }
}

function unreadableReason(error: unknown): GitHubUnreadable {
  if (!(error instanceof GhError)) return 'failed'
  if (error.kind === 'missing') return 'gh-missing'
  if (error.kind === 'auth') return 'signed-out'
  if (error.kind === 'rate-limit') return 'rate-limit'
  if (error.status === 404 || /Could not resolve to/i.test(error.message)) return 'not-found'
  return 'failed'
}

function parseIssue(raw: RawIssue): GitHubIssue | undefined {
  const repo = raw.repository?.nameWithOwner
  const body = parsePost(raw)
  if (
    typeof repo !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    typeof raw.number !== 'number' ||
    typeof raw.title !== 'string' ||
    typeof raw.url !== 'string' ||
    !body
  ) {
    return undefined
  }
  const nodes = Array.isArray(raw.comments?.nodes) ? raw.comments.nodes : []
  const visible = nodes.filter((node) => node?.isMinimized !== true)
  const comments = visible.flatMap((node) => {
    const post = parsePost(node)
    return post ? [post] : []
  })
  const total = raw.comments?.totalCount
  return {
    url: raw.url,
    repo,
    number: raw.number,
    title: oneLine(clean(raw.title, maxTitle)) || `Issue #${raw.number}`,
    state: raw.state === 'CLOSED' ? 'closed' : 'open',
    locked: raw.locked === true,
    body,
    comments,
    totalComments: typeof total === 'number' && total >= nodes.length ? total : nodes.length,
    hiddenComments: nodes.length - visible.length,
  }
}

function parsePost(raw: RawPost | null | undefined): GitHubPost | undefined {
  if (!raw || typeof raw.body !== 'string' || typeof raw.createdAt !== 'string') return undefined
  const login = typeof raw.author?.login === 'string' ? raw.author.login : 'ghost'
  return {
    author: authorName(login),
    maintainer: typeof raw.authorAssociation === 'string' && maintainers.has(raw.authorAssociation),
    body: raw.body,
    html: typeof raw.bodyHTML === 'string' ? raw.bodyHTML : '',
    createdAt: raw.createdAt,
  }
}

function authorName(login: string): string {
  const safe = login.replace(/[^A-Za-z0-9[\]_-]/g, '').slice(0, 60)
  return `@${safe === '' ? 'ghost' : safe}`
}

export interface ChosenPosts {
  body: GitHubPost
  comments: GitHubPost[]
  warnings: string[]
}

export function choosePosts(issue: GitHubIssue): ChosenPosts {
  const warnings: string[] = []
  const left = issue.totalComments - issue.hiddenComments - issue.comments.length
  if (left > 0) {
    warnings.push(
      `${left} older ${left === 1 ? 'comment was' : 'comments were'} left out. TED imports the newest ${maxIssueComments} comments.`,
    )
  }
  if (issue.body.body.length > maxIssueBody) {
    warnings.push(
      `The issue’s description was shortened. TED imports at most ${maxIssueBody.toLocaleString('en-US')} characters of it.`,
    )
  }
  const kept: GitHubPost[] = []
  let remaining = maxIssueDiscussion
  for (const comment of [...issue.comments].reverse()) {
    if (comment.body.length > remaining) {
      warnings.push(
        `Some comments were left out. TED imports at most ${maxIssueDiscussion.toLocaleString('en-US')} characters of comments.`,
      )
      break
    }
    kept.push(comment)
    remaining -= comment.body.length
  }
  return { body: issue.body, comments: kept.reverse(), warnings }
}

export function githubIssueContext(
  issue: GitHubIssue,
  chosen: ChosenPosts,
  importedAt: string,
  rewrite: (text: string) => string = (text) => text,
): { context: string; outsiderText: boolean } {
  const mark = (post: GitHubPost) => (post.maintainer ? 'maintainer' : 'outsider')
  const state = [issue.state, ...(issue.locked ? ['locked'] : [])].join(', ')
  const header = [
    `GitHub issue ${issue.repo}#${issue.number}`,
    `State on GitHub: ${state}`,
    `Copied by TED at ${importedAt}. ${issue.totalComments} ${issue.totalComments === 1 ? 'comment' : 'comments'} on GitHub, ${chosen.comments.length} copied${issue.hiddenComments > 0 ? `, ${issue.hiddenComments} hidden on GitHub and left out` : ''}.`,
    'Each part is headed with its author and “maintainer” (owner, member or collaborator of the repo) or “outsider” (anyone else). Every line of what they wrote starts with “> ”; a line without it was written by TED.',
  ]
  const post = (heading: string, item: GitHubPost, max: number) =>
    [heading, quoted(rewrite(clean(item.body, max)) || '(empty)')].join('\n')
  const parts = [
    header.join('\n'),
    ...chosen.warnings.map((warning) => `[${warning}]`),
    `### Title · ${chosen.body.author} · ${mark(chosen.body)}\n${quoted(issue.title)}`,
    post(
      `### Issue description · ${chosen.body.author} · ${mark(chosen.body)}`,
      chosen.body,
      maxIssueBody,
    ),
    ...chosen.comments.map((comment) =>
      post(
        `### Comment · ${comment.author} · ${mark(comment)} · ${oneLine(clean(comment.createdAt, 40))}`,
        comment,
        maxIssueDiscussion,
      ),
    ),
  ]
  return {
    context: parts.join('\n\n'),
    outsiderText: [chosen.body, ...chosen.comments].some((item) => !item.maintainer),
  }
}

function quoted(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
