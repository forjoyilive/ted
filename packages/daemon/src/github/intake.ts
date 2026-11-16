import { type GitHubIssueUrl, parseGitHubIssueUrl } from '@ted/protocol'
import {
  isArray,
  isBoolean,
  isInteger,
  isObject,
  isString,
  type Json,
  type JsonObject,
  type Untyped,
} from '@ted/protocol/parse'
import { clean } from '../tasks/github-activity.ts'
import type { Gh } from './gh.ts'
import { type GitHubUnreadable, inFactory, unreadableReason } from './issues.ts'

export interface IntakeIssue {
  url: string
  repo: string
  number: number
  title: string
  parent?: GitHubIssueUrl
}

export interface IntakeListing {
  issues: IntakeIssue[]
  unlisted: { repo: string; reason: GitHubUnreadable }[]
  incomplete: string[]
}

export const intakePageSize = 100
export const maxIntakePages = 5
const maxTitle = 500

const listQuery = `query TedGitHubIntake($owner: String!, $name: String!, $label: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issues(states: OPEN, labels: [$label], first: ${intakePageSize}, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number title url parent { url } }
    }
  }
}`

export async function listIntakeIssues(
  gh: Pick<Gh, 'graphql'>,
  repos: readonly string[],
  label: string,
): Promise<IntakeListing> {
  const listing: IntakeListing = { issues: [], unlisted: [], incomplete: [] }
  for (const repo of repos) {
    const [owner, name] = repo.split('/')
    if (owner === undefined || name === undefined) continue
    let after: string | null = null
    let pages = 0
    try {
      while (true) {
        const page = parsePage(await gh.graphql(listQuery, { owner, name, label, after }), repos)
        if (!page) {
          listing.unlisted.push({ repo, reason: 'failed' })
          break
        }
        listing.issues.push(...page.issues)
        pages++
        if (!page.next) break
        if (pages >= maxIntakePages) {
          listing.incomplete.push(repo)
          break
        }
        after = page.next
      }
    } catch (error) {
      listing.unlisted.push({ repo, reason: unreadableReason(error) })
    }
  }
  return listing
}

function field(object: JsonObject | undefined, name: string): Json | undefined {
  return object?.[name]
}

function objectOf(value: Json | undefined): JsonObject | undefined {
  return isObject(value) ? value : undefined
}

function parsePage(
  answer: Untyped,
  repos: readonly string[],
): { issues: IntakeIssue[]; next: string | undefined } | undefined {
  const root = isObject(answer) ? answer : undefined
  const repository = objectOf(field(objectOf(field(root, 'data')), 'repository'))
  const repo = field(repository, 'nameWithOwner')
  const issues = objectOf(field(repository, 'issues'))
  const pageInfo = objectOf(field(issues, 'pageInfo'))
  const nodes = field(issues, 'nodes')
  const more = field(pageInfo, 'hasNextPage')
  const cursor = field(pageInfo, 'endCursor')
  if (!isString(repo) || !inFactory(repo, repos) || !isArray(nodes) || !isBoolean(more)) {
    return undefined
  }
  return {
    issues: nodes.flatMap((node) => {
      const issue = parseIssue(objectOf(node), repo)
      return issue ? [issue] : []
    }),
    next: more && isString(cursor) ? cursor : undefined,
  }
}

function parseIssue(node: JsonObject | undefined, repo: string): IntakeIssue | undefined {
  const number = field(node, 'number')
  const title = field(node, 'title')
  const url = field(node, 'url')
  if (!isInteger(number) || number <= 0 || !isString(title) || !isString(url)) return undefined
  const link = parseGitHubIssueUrl(url)
  if (
    !link ||
    link.number !== number ||
    `${link.owner}/${link.repo}`.toLowerCase() !== repo.toLowerCase()
  ) {
    return undefined
  }
  const parentUrl = field(objectOf(field(node, 'parent')), 'url')
  const parent = isString(parentUrl) ? parseGitHubIssueUrl(parentUrl) : undefined
  return {
    url: link.url,
    repo,
    number,
    title: clean(title, maxTitle).replace(/\s+/g, ' ').trim() || `Issue #${number}`,
    ...(parent && { parent }),
  }
}
