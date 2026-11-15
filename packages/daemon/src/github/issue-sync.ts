import type { GitHubIssueUrl } from '@ted/protocol'
import { type Gh, GhError } from './gh.ts'

export type IssueClose = 'completed' | 'not planned' | 'duplicate' | 'closed'

export interface IssueSyncState {
  open: boolean
  closedAs?: IssueClose
  closedBy?: string
  openSubIssues: number
}

export interface IssueComments {
  viewer: string
  comments: { author: string; body: string }[]
  complete: boolean
}

export interface PullRequestRef {
  repo: string
  number: number
}

export interface GitHubIssueSyncApi {
  states(issues: readonly GitHubIssueUrl[]): Promise<Map<string, IssueSyncState> | undefined>
  comments(issue: GitHubIssueUrl): Promise<IssueComments>
  comment(issue: GitHubIssueUrl, body: string): Promise<void>
  close(issue: GitHubIssueUrl): Promise<void>
  pullRequestBody(pr: PullRequestRef): Promise<string>
  setPullRequestBody(pr: PullRequestRef, body: string): Promise<void>
}

export const issuesPerQuery = 50
export const commentsPerPage = 100
export const commentPages = 5
const segment = /^[A-Za-z0-9_.-]+$/
const safe = (part: string) => segment.test(part) && !/^\.+$/.test(part)

export function issueKey(issue: Pick<GitHubIssueUrl, 'owner' | 'repo' | 'number'>): string {
  return `${issue.owner}/${issue.repo}#${issue.number}`.toLowerCase()
}

export function parsePullRequestRef(url: string): PullRequestRef | undefined {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]{0,9})$/.exec(url)
  const [, owner = '', repo = '', number = ''] = match ?? []
  if (!match || ![owner, repo].every(safe)) {
    return undefined
  }
  return { repo: `${owner}/${repo}`, number: Number(number) }
}

const issueFields = `state stateReason
      subIssuesSummary { total completed }
      timelineItems(itemTypes: [CLOSED_EVENT], last: 1) {
        nodes { ... on ClosedEvent { closer { __typename ... on PullRequest { url } } } }
      }`

function statesQuery(count: number): string {
  const variables = Array.from(
    { length: count },
    (_, i) => `$o${i}: String!, $n${i}: String!, $i${i}: Int!`,
  ).join(', ')
  const parts = Array.from(
    { length: count },
    (_, i) =>
      `r${i}: repository(owner: $o${i}, name: $n${i}) { issue(number: $i${i}) { ${issueFields} } }`,
  ).join('\n  ')
  return `query TedIssueStates(${variables}) {\n  ${parts}\n}`
}

const commentsQuery = `query TedIssueComments($owner: String!, $name: String!, $number: Int!, $before: String) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      comments(last: ${commentsPerPage}, before: $before) {
        pageInfo { hasPreviousPage startCursor }
        nodes { author { login } body }
      }
    }
  }
}`

interface RawCommentPage {
  data?: {
    viewer?: { login?: unknown } | null
    repository?: {
      issue?: {
        comments?: {
          pageInfo?: { hasPreviousPage?: unknown; startCursor?: unknown } | null
          nodes?: ({ author?: { login?: unknown } | null; body?: unknown } | null)[] | null
        } | null
      } | null
    } | null
  }
}

interface RawState {
  state?: unknown
  stateReason?: unknown
  subIssuesSummary?: { total?: unknown; completed?: unknown } | null
  timelineItems?: {
    nodes?: ({ closer?: { __typename?: unknown; url?: unknown } | null } | null)[] | null
  } | null
}

export function parseIssueState(raw: RawState | null | undefined): IssueSyncState | undefined {
  if (!raw || (raw.state !== 'OPEN' && raw.state !== 'CLOSED')) return undefined
  const total = raw.subIssuesSummary?.total
  const completed = raw.subIssuesSummary?.completed
  const openSubIssues =
    typeof total === 'number' && typeof completed === 'number' ? Math.max(0, total - completed) : 0
  if (raw.state === 'OPEN') return { open: true, openSubIssues }
  const closer = raw.timelineItems?.nodes?.at(-1)?.closer
  const closedBy =
    closer?.__typename === 'PullRequest' && typeof closer.url === 'string' ? closer.url : undefined
  return {
    open: false,
    closedAs: closeReason(raw.stateReason),
    ...(closedBy !== undefined && { closedBy }),
    openSubIssues,
  }
}

function closeReason(reason: unknown): IssueClose {
  if (reason === 'COMPLETED') return 'completed'
  if (reason === 'NOT_PLANNED') return 'not planned'
  if (reason === 'DUPLICATE') return 'duplicate'
  return 'closed'
}

const answered = (error: unknown) =>
  error instanceof GhError &&
  (error.kind === 'rate-limit' || error.kind === 'auth' || error.kind === 'missing')

export function gitHubIssueSyncApi(gh: Pick<Gh, 'graphql' | 'api'>): GitHubIssueSyncApi {
  async function readChunk(
    chunk: readonly GitHubIssueUrl[],
    into: Map<string, IssueSyncState>,
  ): Promise<void> {
    const variables: Record<string, unknown> = {}
    chunk.forEach((issue, i) => {
      variables[`o${i}`] = issue.owner
      variables[`n${i}`] = issue.repo
      variables[`i${i}`] = issue.number
    })
    const answer = (await gh.graphql(statesQuery(chunk.length), variables)) as {
      data?: Record<string, { issue?: RawState | null } | null> | null
    }
    chunk.forEach((issue, i) => {
      const state = parseIssueState(answer?.data?.[`r${i}`]?.issue)
      if (state) into.set(issueKey(issue), state)
    })
  }

  return {
    async states(issues) {
      const found = new Map<string, IssueSyncState>()
      for (let at = 0; at < issues.length; at += issuesPerQuery) {
        const chunk = issues.slice(at, at + issuesPerQuery)
        try {
          await readChunk(chunk, found)
        } catch (error) {
          if (answered(error)) return undefined
          for (const issue of chunk) {
            try {
              await readChunk([issue], found)
            } catch (one) {
              if (answered(one)) return undefined
            }
          }
        }
      }
      return found
    },
    async comments(issue) {
      let viewer: string | undefined
      let before: string | undefined
      const comments: IssueComments['comments'] = []
      for (let page = 0; page < commentPages; page++) {
        const answer = (await gh.graphql(commentsQuery, {
          owner: issue.owner,
          name: issue.repo,
          number: issue.number,
          ...(before !== undefined && { before }),
        })) as RawCommentPage
        const login = answer?.data?.viewer?.login
        const list = answer?.data?.repository?.issue?.comments
        const nodes = list?.nodes
        if (typeof login !== 'string' || !Array.isArray(nodes)) {
          throw new Error(`couldn’t read the comments of ${issueKey(issue)}`)
        }
        viewer = login
        for (const node of nodes) {
          if (typeof node?.author?.login === 'string' && typeof node.body === 'string')
            comments.push({ author: node.author.login, body: node.body })
        }
        const cursor = list?.pageInfo?.startCursor
        if (list?.pageInfo?.hasPreviousPage !== true) return { viewer, comments, complete: true }
        if (typeof cursor !== 'string') break
        before = cursor
      }
      return { viewer: viewer ?? '', comments, complete: false }
    },
    async comment(issue, body) {
      await gh.api(issuePath(issue, '/comments'), { method: 'POST', body: { body } })
    },
    async close(issue) {
      await gh.api(issuePath(issue, ''), {
        method: 'PATCH',
        body: { state: 'closed', state_reason: 'completed' },
      })
    },
    async pullRequestBody(pr) {
      const answer = (await gh.api(pullPath(pr))) as { body?: unknown } | undefined
      return typeof answer?.body === 'string' ? answer.body : ''
    },
    async setPullRequestBody(pr, body) {
      await gh.api(pullPath(pr), { method: 'PATCH', body: { body } })
    },
  }
}

function issuePath(issue: GitHubIssueUrl, rest: string): string {
  if (![issue.owner, issue.repo].every(safe) || !Number.isSafeInteger(issue.number)) {
    throw new Error('not a GitHub issue')
  }
  return `repos/${issue.owner}/${issue.repo}/issues/${issue.number}${rest}`
}

function pullPath(pr: PullRequestRef): string {
  const [owner = '', repo = '', ...rest] = pr.repo.split('/')
  if (rest.length > 0 || ![owner, repo].every(safe) || !Number.isSafeInteger(pr.number)) {
    throw new Error('not a GitHub pull request')
  }
  return `repos/${owner}/${repo}/pulls/${pr.number}`
}
