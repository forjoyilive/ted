#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

interface StubState {
  version?: string
  hosts?: Record<string, unknown[]>
  api?: { result: 'ok' | 'rate-limit' | 'auth'; body?: unknown }
  paths?: Record<string, { status?: number; message?: string; body?: unknown }>
  pr?: { number?: number; createFails?: string }
  heads?: Record<string, string>
  merge?: StubMerge
}

interface StubCheck {
  name: string
  status?: string
  conclusion?: string | null
  state?: string
  required?: boolean
}

interface StubMerge {
  origin?: string
  mergeState?: string
  mergeable?: string
  reviewDecision?: string | null
  checks?: StubCheck[]
  allowed?: string[]
  autoMergeAllowed?: boolean
  deleteBranchOnMerge?: boolean
  rebaseConflict?: boolean
  rebaseAddsCommit?: boolean
  rebaseChangesMode?: boolean
  isDraft?: boolean
  merged?: boolean
  autoMerge?: string
  mergedWith?: string
  updateBase?: boolean
}

const readyHosts = {
  'github.com': [
    {
      state: 'success',
      active: true,
      host: 'github.com',
      login: 'stub-user',
      tokenSource: 'keyring',
      scopes: 'gist, read:org, repo, workflow',
      gitProtocol: 'https',
    },
  ],
}

const statePath = process.env.TED_STUB_GH
const state: StubState = statePath ? JSON.parse(readFileSync(statePath, 'utf8')) : {}
const args = process.argv.slice(2)
const stdin =
  args.includes('--input') || args.includes('--body-file') ? readFileSync(0, 'utf8') : undefined

const save = () => {
  if (statePath) writeFileSync(statePath, JSON.stringify(state))
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'GitHub',
  GIT_AUTHOR_EMAIL: 'noreply@github.com',
  GIT_COMMITTER_NAME: 'GitHub',
  GIT_COMMITTER_EMAIL: 'noreply@github.com',
}

const runGit = (cwd: string, ...gitArgs: string[]) =>
  execFileSync('git', gitArgs, { cwd, env: gitEnv, encoding: 'utf8' }).trim()

const headOf = (number: string): string => {
  const branch = state.heads?.[number] ?? ''
  const origin = state.merge?.origin
  return origin && branch ? runGit(origin, 'rev-parse', `refs/heads/${branch}`) : ''
}

const logPath = process.env.TED_STUB_GH_LOG
if (logPath) {
  appendFileSync(
    logPath,
    `${JSON.stringify({
      args,
      env: {
        GH_PROMPT_DISABLED: process.env.GH_PROMPT_DISABLED,
        GH_NO_UPDATE_NOTIFIER: process.env.GH_NO_UPDATE_NOTIFIER,
        GH_HOST: process.env.GH_HOST,
      },
      ...(stdin !== undefined && { stdin }),
    })}\n`,
  )
}

function checkNode(c: StubCheck) {
  return c.state !== undefined
    ? { __typename: 'StatusContext', context: c.name, state: c.state, isRequired: !!c.required }
    : {
        __typename: 'CheckRun',
        name: c.name,
        status: c.status ?? 'COMPLETED',
        conclusion: c.conclusion ?? null,
        isRequired: !!c.required,
      }
}

function pullRequests(variables: Record<string, unknown>) {
  const merge = state.merge ?? {}
  const allowed = merge.allowed ?? ['squash', 'merge', 'rebase']
  const data: Record<string, unknown> = {}
  for (let i = 0; `p${i}` in variables; i++) {
    const number = String(variables[`p${i}`])
    data[`r${i}`] = {
      squashMergeAllowed: allowed.includes('squash'),
      mergeCommitAllowed: allowed.includes('merge'),
      rebaseMergeAllowed: allowed.includes('rebase'),
      autoMergeAllowed: merge.autoMergeAllowed ?? false,
      deleteBranchOnMerge: merge.deleteBranchOnMerge ?? false,
      pullRequest: {
        id: `PR_${number}`,
        state: merge.merged ? 'MERGED' : 'OPEN',
        isDraft: merge.isDraft ?? false,
        headRefOid: headOf(number),
        mergeable: merge.mergeable ?? 'MERGEABLE',
        mergeStateStatus: merge.mergeState ?? 'CLEAN',
        reviewDecision: merge.reviewDecision ?? null,
        autoMergeRequest: merge.autoMerge ? { enabledAt: '2026-11-09T00:00:00Z' } : null,
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: { contexts: { nodes: (merge.checks ?? []).map(checkNode) } },
              },
            },
          ],
        },
      },
    }
  }
  return { data }
}

function rebaseBranch(): string {
  const merge = state.merge ?? {}
  if (merge.rebaseConflict) {
    process.stderr.write(
      'GraphQL: merge conflict between base and head (updatePullRequestBranch)\n',
    )
    process.exit(1)
  }
  const number = Object.keys(state.heads ?? {})[0] ?? '7'
  const branch = state.heads?.[number] ?? ''
  const work = mkdtempSync(path.join(tmpdir(), 'stub-gh-rebase-'))
  try {
    runGit(work, 'clone', '-q', merge.origin ?? '', 'repo')
    const repo = path.join(work, 'repo')
    runGit(repo, 'checkout', '-q', branch)
    runGit(repo, 'rebase', '-q', 'origin/main')
    if (merge.rebaseAddsCommit) {
      writeFileSync(path.join(repo, 'extra.txt'), 'not signed off\n')
      runGit(repo, 'add', 'extra.txt')
      runGit(repo, 'commit', '-qm', 'extra')
    }
    if (merge.rebaseChangesMode) {
      runGit(repo, 'update-index', '--chmod=+x', 'work.txt')
      runGit(repo, 'commit', '-q', '--amend', '--no-edit')
    }
    runGit(repo, 'push', '-q', '--force', 'origin', `HEAD:refs/heads/${branch}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  merge.mergeState = 'CLEAN'
  state.merge = merge
  save()
  return headOf(number)
}

function mergePullRequest(): void {
  const merge = state.merge ?? {}
  const method = ['squash', 'merge', 'rebase'].find((m) => args.includes(`--${m}`)) ?? ''
  const expected = args[args.indexOf('--match-head-commit') + 1]
  if (expected !== headOf(args[2] ?? '')) {
    process.stderr.write('GraphQL: Head branch was modified. Review and try the merge again.\n')
    process.exit(1)
  }
  if (args.includes('--auto')) merge.autoMerge = method
  else {
    merge.merged = true
    merge.mergedWith = method
    if (merge.updateBase && merge.origin && expected) {
      runGit(merge.origin, 'update-ref', 'refs/heads/main', expected)
    }
  }
  state.merge = merge
  save()
}

const graphql = args[0] === 'api' && args[1] === 'graphql' && stdin !== undefined

if (args[0] === '--version') {
  const version = state.version ?? '2.89.0'
  process.stdout.write(
    `gh version ${version} (2026-03-26)\nhttps://github.com/cli/cli/releases/tag/v${version}\n`,
  )
} else if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(`${JSON.stringify({ hosts: state.hosts ?? readyHosts })}\n`)
} else if (graphql && state.merge && stdin.includes('mergeStateStatus')) {
  if (state.api?.result === 'auth') {
    process.stderr.write('gh: Bad credentials (HTTP 401)\n')
    process.exit(1)
  }
  const { variables } = JSON.parse(stdin) as { variables: Record<string, unknown> }
  process.stdout.write(`${JSON.stringify(pullRequests(variables))}\n`)
} else if (graphql && stdin.includes('updatePullRequestBranch')) {
  const head = rebaseBranch()
  process.stdout.write(
    `${JSON.stringify({ data: { updatePullRequestBranch: { pullRequest: { headRefOid: head } } } })}\n`,
  )
} else if (args[0] === 'api' && state.paths) {
  const route = args.find((arg, i) => i > 0 && !arg.startsWith('-') && args[i - 1] !== '--method')
  const answer = route === undefined ? undefined : state.paths[route]
  if (!answer || (answer.status ?? 200) >= 400) {
    const status = answer?.status ?? 404
    process.stderr.write(`gh: ${answer?.message ?? 'Not Found'} (HTTP ${status})\n`)
    process.exit(1)
  }
  process.stdout.write(`${JSON.stringify(answer.body ?? {})}\n`)
} else if (args[0] === 'api') {
  const result = state.api?.result ?? 'ok'
  if (result === 'rate-limit') {
    process.stderr.write('gh: API rate limit exceeded for user ID 1. (HTTP 403)\n')
    process.exit(1)
  }
  if (result === 'auth') {
    process.stderr.write('gh: Bad credentials (HTTP 401)\n')
    process.exit(1)
  }
  process.stdout.write(`${JSON.stringify(state.api?.body ?? {})}\n`)
} else if (args[0] === 'pr') {
  const repo = args[args.indexOf('--repo') + 1] ?? 'acme/widgets'
  const number = state.pr?.number ?? 7
  if (args[1] === 'create' && state.pr?.createFails) {
    process.stderr.write(`${state.pr.createFails}\n`)
    process.exit(1)
  }
  if (args[1] === 'create') {
    state.heads = { ...state.heads, [String(number)]: args[args.indexOf('--head') + 1] ?? '' }
    save()
    process.stdout.write(`https://github.com/${repo}/pull/${number}\n`)
  } else if (args[1] === 'list') process.stdout.write('[]\n')
  else if (args[1] === 'merge') mergePullRequest()
  else if (!['ready', 'edit', 'close'].includes(args[1] ?? '')) {
    process.stderr.write(`stub gh: unknown command ${args.join(' ')}\n`)
    process.exit(1)
  }
} else {
  process.stderr.write(`stub gh: unknown command ${args.join(' ')}\n`)
  process.exit(1)
}
