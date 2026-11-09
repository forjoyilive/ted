import { type GitHubWait, type MergeMethod, mergeMethods } from '@ted/protocol'
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
}

export type CheckState = 'pending' | 'passed' | 'failed'

export interface RemotePullRequest {
  id: string
  title: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  headRefOid: string
  mergeable: string
  mergeStateStatus: string
  reviewDecision: string | null
  autoMerge: boolean
  checks: { name: string; state: CheckState; required: boolean }[]
  allowed: MergeMethod[]
  autoMergeAllowed: boolean
  deleteBranchOnMerge: boolean
}

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

export function ciState(
  target: MergeTarget,
  pr: RemotePullRequest,
  options: { mergeAnyway?: boolean } = {},
): CiState {
  if (!target.hasCi) return 'passed'
  const relevant = relevantChecks(pr)
  if (relevant.some((c) => c.state === 'failed')) return 'failed'
  if (options.mergeAnyway && !pr.checks.some((c) => c.required && c.state === 'pending')) {
    return 'passed'
  }
  if (relevant.length === 0 || relevant.some((c) => c.state === 'pending')) return 'pending'
  return 'passed'
}

export function nextStep(
  target: MergeTarget,
  pr: RemotePullRequest,
  options: { mergeAnyway?: boolean } = {},
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
    const failed = relevantChecks(pr)
      .filter((c) => c.state === 'failed')
      .map((c) => c.name)
    return { kind: 'ci-failed', checks: failed }
  }
  if (reviewMissing(pr)) return { kind: 'wait', on: 'review', autoMerge: canAutoMerge }
  const blocked = pr.mergeStateStatus === 'BLOCKED'
  if (ci === 'pending') return { kind: 'wait', on: 'ci', autoMerge: blocked && canAutoMerge }
  if (mergeableStates.includes(pr.mergeStateStatus)) return { kind: 'merge', noCi: !target.hasCi }
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

export async function readPullRequests(
  gh: Pick<Gh, 'graphql'>,
  targets: readonly MergeTarget[],
): Promise<Map<string, RemotePullRequest>> {
  const found = new Map<string, RemotePullRequest>()
  if (targets.length === 0) return found
  const variables: Record<string, unknown> = {}
  const params: string[] = []
  const fields = targets.map((target, i) => {
    const [owner = '', name = ''] = target.repo.split('/')
    variables[`o${i}`] = owner
    variables[`n${i}`] = name
    variables[`p${i}`] = target.number
    params.push(`$o${i}: String!`, `$n${i}: String!`, `$p${i}: Int!`)
    return repositoryFields(i)
  })
  const result = (await gh.graphql(
    `query(${params.join(', ')}) {\n${fields.join('\n')}\n}`,
    variables,
  )) as { data?: Record<string, RepositoryBody | null> }
  targets.forEach((target, i) => {
    const repository = result?.data?.[`r${i}`]
    const pr = repository?.pullRequest
    if (!repository || !pr || typeof pr.headRefOid !== 'string') return
    const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []
    found.set(target.name, {
      id: String(pr.id ?? ''),
      title: typeof pr.title === 'string' ? pr.title : '',
      state: pr.state === 'MERGED' || pr.state === 'CLOSED' ? pr.state : 'OPEN',
      isDraft: pr.isDraft === true,
      headRefOid: pr.headRefOid,
      mergeable: String(pr.mergeable ?? 'UNKNOWN'),
      mergeStateStatus: String(pr.mergeStateStatus ?? 'UNKNOWN'),
      reviewDecision: typeof pr.reviewDecision === 'string' ? pr.reviewDecision : null,
      autoMerge: pr.autoMergeRequest != null,
      checks: contexts.flatMap((c) => (c ? [checkOf(c)] : [])),
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
  ])
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

export async function deleteBranch(gh: Pick<Gh, 'api'>, target: MergeTarget): Promise<void> {
  const ref = target.branch.split('/').map(encodeURIComponent).join('/')
  const [owner = '', name = ''] = target.repo.split('/').map(encodeURIComponent)
  await gh.api(`repos/${owner}/${name}/git/refs/heads/${ref}`, { method: 'DELETE' })
}

function checkOf(node: ContextBody): RemotePullRequest['checks'][number] {
  const required = node.isRequired === true
  if (node.__typename === 'StatusContext') {
    const state =
      node.state === 'SUCCESS'
        ? 'passed'
        : node.state === 'PENDING' || node.state === 'EXPECTED'
          ? 'pending'
          : 'failed'
    return { name: String(node.context ?? ''), state, required }
  }
  const passed = ['SUCCESS', 'NEUTRAL', 'SKIPPED']
  const state =
    node.status !== 'COMPLETED'
      ? 'pending'
      : passed.includes(String(node.conclusion))
        ? 'passed'
        : 'failed'
  return { name: String(node.name ?? ''), state, required }
}

function repositoryFields(i: number): string {
  return `r${i}: repository(owner: $o${i}, name: $n${i}) {
  squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed autoMergeAllowed deleteBranchOnMerge
  pullRequest(number: $p${i}) {
    id title state isDraft headRefOid mergeable mergeStateStatus reviewDecision
    autoMergeRequest { enabledAt }
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { name status conclusion isRequired(pullRequestNumber: $p${i}) }
      ... on StatusContext { context state isRequired(pullRequestNumber: $p${i}) }
    } } } } } }
  }
}`
}

interface ContextBody {
  __typename?: string
  name?: unknown
  status?: unknown
  conclusion?: unknown
  context?: unknown
  state?: unknown
  isRequired?: unknown
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
    state?: unknown
    isDraft?: unknown
    headRefOid?: unknown
    mergeable?: unknown
    mergeStateStatus?: unknown
    reviewDecision?: unknown
    autoMergeRequest?: unknown
    commits?: {
      nodes?: ({
        commit?: { statusCheckRollup?: { contexts?: { nodes?: (ContextBody | null)[] } } | null }
      } | null)[]
    }
  } | null
}
