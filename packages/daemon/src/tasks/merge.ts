import {
  type GitHubWait,
  type MergeMethod,
  mergeMethods,
  type PullRequestCiMode,
  type TaskPush,
} from '@ted/protocol'
import type { Gh } from '../github/gh.ts'

export interface MergeTarget {
  name: string
  repo: string
  number: number
  branch: string
  base: string
  expectedHead: string
  hasCi: boolean
  method: MergeMethod
  message?: { subject: string; body?: string }
}

export type CheckState = 'pending' | 'passed' | 'failed'

export interface RemoteCheck {
  identity?: string | undefined
  name: string
  state: CheckState
  required: boolean
  conclusion?: string
  url?: string
  kind?: 'check' | 'status'
  app?: string
}

export interface RemoteAuthor {
  login: string
  bot: boolean
  association?: string
}

export interface RemoteReviewThread {
  id: string
  resolved: boolean
  path: string
  line: number | null
  comments: { id: string; author: RemoteAuthor; body: string; url: string }[]
}

export interface RemoteReview {
  id: string
  state: string
  author: RemoteAuthor
  body: string
  url: string
}

export interface RemoteDeployment {
  environment: string
  state: string
  url?: string
}

export interface RemotePullRequest {
  checksComplete?: boolean
  id: string
  title: string
  url: string
  baseRefName: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  headRefOid: string
  mergeable: string
  mergeStateStatus: string
  reviewDecision: string | null
  autoMerge: boolean
  checks: RemoteCheck[]
  threads: RemoteReviewThread[]
  reviews: RemoteReview[]
  deployments: RemoteDeployment[]
  allowed: MergeMethod[]
  autoMergeAllowed: boolean
  deleteBranchOnMerge: boolean
}

export interface PullRequestRef {
  key: string
  repo: string
  number: number
  host?: string
}

export interface PullRequestRead {
  pulls: Map<string, RemotePullRequest>
  failed: Map<string, unknown>
  hostOf: Map<string, string>
}

export const defaultHost = 'github.com'

export type MergeStep =
  | { kind: 'merged' }
  | { kind: 'closed' }
  | { kind: 'changed'; head: string }
  | { kind: 'ready' }
  | { kind: 'conflict' }
  | { kind: 'behind' }
  | { kind: 'ci-failed'; checks: string[] }
  | { kind: 'wait'; on: GitHubWait; autoMerge: boolean }
  | { kind: 'merge'; noCi: boolean }

const mergeableStates = ['CLEAN', 'UNSTABLE', 'HAS_HOOKS']

export type CiState = 'passed' | 'pending' | 'failed'

export function relevantChecks(pr: RemotePullRequest): RemotePullRequest['checks'] {
  const required = pr.checks.filter((c) => c.required)
  return required.length > 0 ? required : pr.checks
}

export interface CiOptions {
  mergeAnyway?: boolean
  accepted?: ReadonlySet<string>
}

const acceptedCheck = (check: RemoteCheck, options: CiOptions) =>
  check.identity !== undefined && options.accepted?.has(check.identity) === true

export function failingChecks(pr: RemotePullRequest, options: CiOptions = {}): RemoteCheck[] {
  return relevantChecks(pr).filter((c) => c.state === 'failed' && !acceptedCheck(c, options))
}

export function acceptedFailing(pr: RemotePullRequest, options: CiOptions = {}): RemoteCheck[] {
  return relevantChecks(pr).filter((c) => c.state === 'failed' && acceptedCheck(c, options))
}

export function expectsCi(
  mode: PullRequestCiMode | undefined,
  pushed: Pick<TaskPush, 'ci' | 'ciSignals'> | undefined,
): boolean {
  if (mode === 'required') return true
  if (mode === 'none') return pushed?.ciSignals.includes('required-checks') === true
  return pushed?.ci ?? true
}

export function ciState(
  target: MergeTarget,
  pr: RemotePullRequest,
  options: CiOptions = {},
): CiState {
  if (!target.hasCi) return 'passed'
  const relevant = relevantChecks(pr)
  const pending = relevant.some((c) => c.state === 'pending')
  if (failingChecks(pr, options).length > 0) return pending ? 'pending' : 'failed'
  if (options.mergeAnyway && !pr.checks.some((c) => c.required && c.state === 'pending')) {
    return 'passed'
  }
  if (relevant.length === 0 || pending) return 'pending'
  return 'passed'
}

export function nextStep(
  target: MergeTarget,
  pr: RemotePullRequest,
  options: CiOptions = {},
): MergeStep {
  if (pr.state === 'MERGED') return { kind: 'merged' }
  if (pr.state === 'CLOSED') return { kind: 'closed' }
  if (pr.headRefOid !== target.expectedHead) return { kind: 'changed', head: pr.headRefOid }
  if (pr.isDraft) return { kind: 'ready' }
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return { kind: 'conflict' }
  if (pr.mergeStateStatus === 'BEHIND') return { kind: 'behind' }
  const canAutoMerge = pr.autoMergeAllowed && !pr.autoMerge
  const ci = ciState(target, pr, options)
  if (ci === 'failed') {
    return { kind: 'ci-failed', checks: failingChecks(pr, options).map((c) => c.name) }
  }
  if (reviewMissing(pr)) return { kind: 'wait', on: 'review', autoMerge: canAutoMerge }
  const blocked = pr.mergeStateStatus === 'BLOCKED'
  if (ci === 'pending') {
    const failing = target.hasCi && failingChecks(pr, options).length > 0
    return { kind: 'wait', on: 'ci', autoMerge: !failing && blocked && canAutoMerge }
  }
  if (mergeableStates.includes(pr.mergeStateStatus)) return { kind: 'merge', noCi: !target.hasCi }
  if (target.hasCi && acceptedFailing(pr, options).length > 0) {
    return { kind: 'wait', on: 'required-check', autoMerge: false }
  }
  return { kind: 'wait', on: target.hasCi ? 'ci' : 'merge', autoMerge: blocked && canAutoMerge }
}

export function reviewMissing(pr: RemotePullRequest): boolean {
  return pr.reviewDecision === 'REVIEW_REQUIRED' || pr.reviewDecision === 'CHANGES_REQUESTED'
}

export function chooseMethod(
  requested: MergeMethod,
  allowed: readonly MergeMethod[],
): MergeMethod | undefined {
  if (allowed.includes(requested)) return requested
  return mergeMethods.find((m) => allowed.includes(m))
}

export async function readByHost(
  gh: Pick<Gh, 'graphql'>,
  refs: readonly PullRequestRef[],
): Promise<PullRequestRead> {
  const byHost = new Map<string, PullRequestRef[]>()
  const hostOf = new Map<string, string>()
  for (const ref of refs) {
    const host = ref.host ?? defaultHost
    hostOf.set(ref.key, host)
    byHost.set(host, [...(byHost.get(host) ?? []), ref])
  }
  const pulls = new Map<string, RemotePullRequest>()
  const failed = new Map<string, unknown>()
  await Promise.all(
    [...byHost].map(async ([host, group]) => {
      try {
        for (const [key, pr] of await readPullRequests(gh, group, host)) pulls.set(key, pr)
      } catch (error) {
        failed.set(host, error)
      }
    }),
  )
  return { pulls, failed, hostOf }
}

export async function readPullRequests(
  gh: Pick<Gh, 'graphql'>,
  refs: readonly PullRequestRef[],
  host: string = defaultHost,
): Promise<Map<string, RemotePullRequest>> {
  const found = new Map<string, RemotePullRequest>()
  if (refs.length === 0) return found
  const variables: Record<string, unknown> = {}
  const params: string[] = []
  const fields = refs.map((ref, i) => {
    const [owner = '', name = ''] = ref.repo.split('/')
    variables[`o${i}`] = owner
    variables[`n${i}`] = name
    variables[`p${i}`] = ref.number
    params.push(`$o${i}: String!`, `$n${i}: String!`, `$p${i}: Int!`)
    return repositoryFields(i)
  })
  const result = (await gh.graphql(
    `query(${params.join(', ')}) {\n${fields.join('\n')}\n}`,
    variables,
    host === defaultHost ? {} : { host },
  )) as { data?: Record<string, RepositoryBody | null> }
  refs.forEach((ref, i) => {
    const repository = result?.data?.[`r${i}`]
    const pr = repository?.pullRequest
    if (!repository || !pr || typeof pr.headRefOid !== 'string') return
    const commit = pr.commits?.nodes?.[0]?.commit
    const contexts = commit?.statusCheckRollup?.contexts?.nodes ?? []
    found.set(ref.key, {
      id: String(pr.id ?? ''),
      title: text(pr.title),
      url: text(pr.url),
      baseRefName: text(pr.baseRefName),
      state: pr.state === 'MERGED' || pr.state === 'CLOSED' ? pr.state : 'OPEN',
      isDraft: pr.isDraft === true,
      headRefOid: pr.headRefOid,
      mergeable: String(pr.mergeable ?? 'UNKNOWN'),
      mergeStateStatus: String(pr.mergeStateStatus ?? 'UNKNOWN'),
      reviewDecision: typeof pr.reviewDecision === 'string' ? pr.reviewDecision : null,
      autoMerge: pr.autoMergeRequest != null,
      checksComplete:
        commit?.statusCheckRollup === null ||
        (commit?.statusCheckRollup?.contexts?.pageInfo?.hasNextPage === false &&
          Array.isArray(commit.statusCheckRollup.contexts.nodes) &&
          commit.statusCheckRollup.contexts.nodes.every((node) => node !== null)),
      checks: contexts.flatMap((c) => (c ? [checkOf(c)] : [])),
      threads: (pr.reviewThreads?.nodes ?? []).flatMap((t) => (t ? [threadOf(t)] : [])),
      reviews: (pr.reviews?.nodes ?? []).flatMap((r) => (r ? [reviewOf(r)] : [])),
      deployments: (commit?.deployments?.nodes ?? []).flatMap((d) => (d ? [deploymentOf(d)] : [])),
      allowed: [
        ...(repository.squashMergeAllowed ? (['squash'] as const) : []),
        ...(repository.mergeCommitAllowed ? (['merge'] as const) : []),
        ...(repository.rebaseMergeAllowed ? (['rebase'] as const) : []),
      ],
      autoMergeAllowed: repository.autoMergeAllowed === true,
      deleteBranchOnMerge: repository.deleteBranchOnMerge === true,
    })
  })
  return found
}

export async function mergePullRequest(
  gh: Pick<Gh, 'run'>,
  target: MergeTarget,
  method: MergeMethod,
  options: { auto: boolean },
): Promise<void> {
  await gh.run([
    'pr',
    'merge',
    String(target.number),
    '--repo',
    target.repo,
    `--${method}`,
    '--match-head-commit',
    target.expectedHead,
    ...(options.auto ? ['--auto'] : []),
    ...mergeMessage(target.message, method),
  ])
}

export function mergeMessage(message: MergeTarget['message'], method: MergeMethod): string[] {
  if (!message || method === 'rebase') return []
  return [
    '--subject',
    message.subject,
    ...(message.body !== undefined ? ['--body', message.body] : []),
  ]
}

export async function disableAutoMerge(
  gh: Pick<Gh, 'run'>,
  target: Pick<MergeTarget, 'repo' | 'number'>,
): Promise<void> {
  await gh.run(['pr', 'merge', String(target.number), '--repo', target.repo, '--disable-auto'])
}

export async function rebasePullRequest(
  gh: Pick<Gh, 'graphql'>,
  pr: RemotePullRequest,
): Promise<string | undefined> {
  const result = (await gh.graphql(
    `mutation($id: ID!, $head: GitObjectID!) {
  updatePullRequestBranch(input: {pullRequestId: $id, expectedHeadOid: $head, updateMethod: REBASE}) {
    pullRequest { headRefOid }
  }
}`,
    { id: pr.id, head: pr.headRefOid },
  )) as { data?: { updatePullRequestBranch?: { pullRequest?: { headRefOid?: unknown } } } }
  const head = result?.data?.updatePullRequestBranch?.pullRequest?.headRefOid
  return typeof head === 'string' && head !== pr.headRefOid ? head : undefined
}

export async function deleteBranch(
  gh: Pick<Gh, 'api'>,
  target: Pick<MergeTarget, 'repo' | 'branch'>,
): Promise<void> {
  const ref = target.branch.split('/').map(encodeURIComponent).join('/')
  const [owner = '', name = ''] = target.repo.split('/').map(encodeURIComponent)
  await gh.api(`repos/${owner}/${name}/git/refs/heads/${ref}`, { method: 'DELETE' })
}

function checkOf(node: ContextBody): RemoteCheck {
  const required = node.isRequired === true
  if (node.__typename === 'StatusContext') {
    const state =
      node.state === 'SUCCESS'
        ? 'passed'
        : node.state === 'PENDING' || node.state === 'EXPECTED'
          ? 'pending'
          : 'failed'
    return {
      name: String(node.context ?? ''),
      state,
      required,
      conclusion: text(node.state),
      kind: 'status',
      identity:
        text(node.id) && text(node.createdAt)
          ? `${text(node.id)}:${text(node.createdAt)}`
          : undefined,
      ...(typeof node.targetUrl === 'string' && { url: node.targetUrl }),
    }
  }
  const passed = ['SUCCESS', 'NEUTRAL', 'SKIPPED']
  const state =
    node.status !== 'COMPLETED'
      ? 'pending'
      : passed.includes(String(node.conclusion))
        ? 'passed'
        : 'failed'
  return {
    name: String(node.name ?? ''),
    state,
    required,
    ...(typeof node.conclusion === 'string' && { conclusion: node.conclusion }),
    kind: 'check',
    identity:
      text(node.id) && text(node.startedAt)
        ? `${text(node.id)}:${text(node.startedAt)}:${text(node.completedAt)}`
        : undefined,
    ...(typeof node.detailsUrl === 'string' && { url: node.detailsUrl }),
    ...(typeof node.checkSuite?.app?.slug === 'string' && { app: node.checkSuite.app.slug }),
  }
}

function threadOf(node: ThreadBody): RemoteReviewThread {
  return {
    id: text(node.id),
    resolved: node.isResolved === true,
    path: text(node.path),
    line: typeof node.line === 'number' ? node.line : null,
    comments: (node.comments?.nodes ?? []).flatMap((c) =>
      c
        ? [
            {
              id: text(c.id),
              author: authorOf(c.author, c.authorAssociation),
              body: text(c.body),
              url: text(c.url),
            },
          ]
        : [],
    ),
  }
}

function reviewOf(node: ReviewBody): RemoteReview {
  return {
    id: text(node.id),
    state: text(node.state),
    author: authorOf(node.author, node.authorAssociation),
    body: text(node.body),
    url: text(node.url),
  }
}

function deploymentOf(node: DeploymentBody): RemoteDeployment {
  const url = node.latestStatus?.environmentUrl
  return {
    environment: text(node.environment),
    state: text(node.latestStatus?.state ?? node.state),
    ...(typeof url === 'string' && url !== '' && { url }),
  }
}

function authorOf(node: AuthorBody | null | undefined, association: unknown): RemoteAuthor {
  return {
    login: text(node?.login),
    bot: node?.__typename === 'Bot',
    association: text(association),
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function repositoryFields(i: number): string {
  return `r${i}: repository(owner: $o${i}, name: $n${i}) {
  squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed autoMergeAllowed deleteBranchOnMerge
  pullRequest(number: $p${i}) {
    id title url baseRefName state isDraft headRefOid mergeable mergeStateStatus reviewDecision
    autoMergeRequest { enabledAt }
    reviewThreads(last: 100) { nodes { id isResolved path line
      comments(last: 30) { nodes { id body url authorAssociation author { __typename login } } }
    } }
    reviews(last: 50) { nodes { id state body url authorAssociation author { __typename login } } }
    commits(last: 1) { nodes { commit {
      deployments(last: 10) { nodes { environment state latestStatus { state environmentUrl } } }
      statusCheckRollup { contexts(first: 100) { pageInfo { hasNextPage } nodes {
        __typename
        ... on CheckRun { id startedAt completedAt name status conclusion detailsUrl checkSuite { app { slug } }
          isRequired(pullRequestNumber: $p${i}) }
        ... on StatusContext { id createdAt context state targetUrl isRequired(pullRequestNumber: $p${i}) }
      } } }
    } } }
  }
}`
}

interface ContextBody {
  id?: unknown
  startedAt?: unknown
  completedAt?: unknown
  createdAt?: unknown
  __typename?: string
  name?: unknown
  status?: unknown
  conclusion?: unknown
  detailsUrl?: unknown
  context?: unknown
  state?: unknown
  targetUrl?: unknown
  isRequired?: unknown
  checkSuite?: { app?: { slug?: unknown } | null } | null
}

interface AuthorBody {
  __typename?: unknown
  login?: unknown
}

interface ThreadBody {
  id?: unknown
  isResolved?: unknown
  path?: unknown
  line?: unknown
  comments?: {
    nodes?: ({
      id?: unknown
      body?: unknown
      url?: unknown
      authorAssociation?: unknown
      author?: AuthorBody | null
    } | null)[]
  }
}

interface ReviewBody {
  id?: unknown
  state?: unknown
  body?: unknown
  url?: unknown
  authorAssociation?: unknown
  author?: AuthorBody | null
}

interface DeploymentBody {
  environment?: unknown
  state?: unknown
  latestStatus?: { state?: unknown; environmentUrl?: unknown } | null
}

interface RepositoryBody {
  squashMergeAllowed?: boolean
  mergeCommitAllowed?: boolean
  rebaseMergeAllowed?: boolean
  autoMergeAllowed?: boolean
  deleteBranchOnMerge?: boolean
  pullRequest?: {
    id?: unknown
    title?: unknown
    url?: unknown
    baseRefName?: unknown
    state?: unknown
    isDraft?: unknown
    headRefOid?: unknown
    mergeable?: unknown
    mergeStateStatus?: unknown
    reviewDecision?: unknown
    autoMergeRequest?: unknown
    reviewThreads?: { nodes?: (ThreadBody | null)[] }
    reviews?: { nodes?: (ReviewBody | null)[] }
    commits?: {
      nodes?: ({
        commit?: {
          deployments?: { nodes?: (DeploymentBody | null)[] } | null
          statusCheckRollup?: {
            contexts?: {
              pageInfo?: { hasNextPage?: boolean }
              nodes?: (ContextBody | null)[]
            }
          } | null
        }
      } | null)[]
    }
  } | null
}
