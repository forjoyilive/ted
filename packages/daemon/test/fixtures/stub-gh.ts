#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

interface StubState {
  healthGate?: { entered: string; release: string }
  mergeGate?: { entered: string; release: string }
  graphqlGate?: { entered: string; release: string; after?: number }
  version?: string
  hosts?: Record<string, unknown[]>
  api?: { result: 'ok' | 'rate-limit' | 'auth'; body?: unknown }
  paths?: Record<string, { status?: number; message?: string; body?: unknown }>
  pr?: {
    number?: number
    numbers?: Record<string, number>
    createFails?: string
    numbered?: boolean
  }
  heads?: Record<string, string>
  prRepos?: Record<string, string>
  merge?: StubMerge
  logs?: Record<string, string>
}

interface StubCheck {
  id?: string
  startedAt?: string
  completedAt?: string
  createdAt?: string
  name: string
  status?: string
  conclusion?: string | null
  state?: string
  required?: boolean
  url?: string
  app?: string
}

interface StubAuthor {
  login: string
  bot?: boolean
  association?: string
}

interface StubMerge {
  origin?: string
  origins?: Record<string, string>
  prs?: Record<string, Omit<StubMerge, 'prs' | 'origins'>>
  mergeFails?: string
  disableAutoFails?: boolean
  rollup?: 'empty' | 'missing' | 'truncated'
  title?: string
  baseRefName?: string
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
  closed?: boolean
  autoMerge?: string
  mergedWith?: string
  threads?: {
    id: string
    resolved?: boolean
    path?: string
    line?: number
    comments: { id: string; author: StubAuthor; body: string; url?: string }[]
  }[]
  reviews?: { id: string; state: string; author: StubAuthor; body: string; url?: string }[]
  deployments?: { environment: string; state: string; url?: string }[]
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
const args = process.argv.slice(2)
const stdin =
  args.includes('--input') || args.includes('--body-file') ? readFileSync(0, 'utf8') : undefined
const mutation =
  (args[0] === 'pr' && (args[1] === 'create' || args[1] === 'merge')) ||
  (args[0] === 'api' && args[1] === 'graphql' && stdin?.includes('updatePullRequestBranch'))
if (statePath && process.env.TED_DEMO === '1' && mutation) {
  const { DatabaseSync } = await import('node:sqlite')
  const lock = new DatabaseSync(`${statePath}.lock.sqlite`, { timeout: 0 })
  process.once('exit', () => lock.close())
  const started = Date.now()
  for (;;) {
    try {
      lock.exec('BEGIN EXCLUSIVE')
      break
    } catch (error) {
      if ((error as { errcode?: number }).errcode !== 5) throw error
      if (Date.now() - started > 60_000) throw new Error('Demo GitHub fixture lock timed out.')
      await sleep(10)
    }
  }
}

// Tests rewrite the state file with a plain write, which empties it first. A read that
// lands in that moment waits for the whole file instead of failing the gh call.
async function readState(file: string): Promise<StubState> {
  const started = Date.now()
  for (;;) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      if (!(error instanceof SyntaxError) || Date.now() - started > 2_000) throw error
      await sleep(5)
    }
  }
}

const state: StubState = statePath ? await readState(statePath) : {}

const save = () => {
  if (!statePath) return
  const temporary = `${statePath}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 })
  renameSync(temporary, statePath)
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

const mergeOf = (number: string): StubMerge => ({
  ...state.merge,
  ...state.merge?.prs?.[number],
})

const headOf = (number: string): string => {
  const branch = state.heads?.[number] ?? ''
  const repo = state.prRepos?.[number] ?? ''
  const origin = state.merge?.origins?.[repo] ?? state.merge?.origin
  return origin && branch ? runGit(origin, 'rev-parse', `refs/heads/${branch}`) : ''
}

const logPath = process.env.TED_STUB_GH_LOG
if (args[0] === '--version' && state.healthGate) {
  writeFileSync(state.healthGate.entered, 'waiting')
  while (!existsSync(state.healthGate.release)) await sleep(5)
}
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
    ? {
        __typename: 'StatusContext',
        id: c.id ?? c.name,
        createdAt: c.createdAt ?? '2026-01-01T00:00:00Z',
        context: c.name,
        state: c.state,
        targetUrl: c.url ?? null,
        isRequired: !!c.required,
      }
    : {
        __typename: 'CheckRun',
        id: c.id ?? c.name,
        startedAt: c.startedAt ?? '2026-01-01T00:00:00Z',
        completedAt: c.completedAt ?? '2026-01-01T00:01:00Z',
        name: c.name,
        status: c.status ?? 'COMPLETED',
        conclusion: c.conclusion ?? null,
        detailsUrl: c.url ?? null,
        checkSuite: { app: { slug: c.app ?? 'github-actions' } },
        isRequired: !!c.required,
      }
}

const author = (a: StubAuthor) => ({ __typename: a.bot ? 'Bot' : 'User', login: a.login })

function pullRequests(variables: Record<string, unknown>) {
  const data: Record<string, unknown> = {}
  for (let i = 0; `p${i}` in variables; i++) {
    const number = String(variables[`p${i}`])
    const merge = mergeOf(number)
    data[`r${i}`] = {
      squashMergeAllowed: (merge.allowed ?? ['squash', 'merge', 'rebase']).includes('squash'),
      mergeCommitAllowed: (merge.allowed ?? ['squash', 'merge', 'rebase']).includes('merge'),
      rebaseMergeAllowed: (merge.allowed ?? ['squash', 'merge', 'rebase']).includes('rebase'),
      autoMergeAllowed: merge.autoMergeAllowed ?? false,
      deleteBranchOnMerge: merge.deleteBranchOnMerge ?? false,
      pullRequest: {
        id: `PR_${number}`,
        title: merge.title ?? 'Stub pull request',
        url: `https://github.com/${String(variables[`o${i}`])}/${String(variables[`n${i}`])}/pull/${number}`,
        baseRefName: merge.baseRefName ?? 'main',
        state: merge.merged ? 'MERGED' : merge.closed ? 'CLOSED' : 'OPEN',
        isDraft: merge.isDraft ?? false,
        headRefOid: headOf(number),
        mergeable: merge.mergeable ?? 'MERGEABLE',
        mergeStateStatus: merge.mergeState ?? 'CLEAN',
        reviewDecision: merge.reviewDecision ?? null,
        autoMergeRequest: merge.autoMerge ? { enabledAt: '2026-11-09T00:00:00Z' } : null,
        reviewThreads: {
          nodes: (merge.threads ?? []).map((t) => ({
            id: t.id,
            isResolved: t.resolved ?? false,
            path: t.path ?? '',
            line: t.line ?? null,
            comments: {
              nodes: t.comments.map((c) => ({
                id: c.id,
                body: c.body,
                url: c.url ?? '',
                authorAssociation: c.author.association ?? 'COLLABORATOR',
                author: author(c.author),
              })),
            },
          })),
        },
        reviews: {
          nodes: (merge.reviews ?? []).map((r) => ({
            id: r.id,
            state: r.state,
            body: r.body,
            url: r.url ?? '',
            authorAssociation: r.author.association ?? 'COLLABORATOR',
            author: author(r.author),
          })),
        },
        commits: {
          nodes: [
            {
              commit: {
                deployments: {
                  nodes: (merge.deployments ?? []).map((d) => ({
                    environment: d.environment,
                    state: d.state,
                    latestStatus: { state: d.state, environmentUrl: d.url ?? null },
                  })),
                },
                statusCheckRollup:
                  merge.rollup === 'empty'
                    ? null
                    : merge.rollup === 'missing'
                      ? undefined
                      : {
                          contexts: {
                            pageInfo: { hasNextPage: merge.rollup === 'truncated' },
                            nodes: (merge.checks ?? []).map(checkNode),
                          },
                        },
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
  const asked = (JSON.parse(stdin ?? '{}') as { variables?: { id?: unknown } }).variables?.id
  const number = /^PR_(\d+)$/.exec(String(asked))?.[1] ?? Object.keys(state.heads ?? {})[0] ?? '7'
  const own = merge.prs?.[number]
  const origin = merge.origins?.[state.prRepos?.[number] ?? ''] ?? merge.origin ?? ''
  const branch = state.heads?.[number] ?? ''
  const work = mkdtempSync(path.join(tmpdir(), 'stub-gh-rebase-'))
  try {
    runGit(work, 'clone', '-q', origin, 'repo')
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
  if (own) own.mergeState = 'CLEAN'
  else merge.mergeState = 'CLEAN'
  state.merge = merge
  save()
  return headOf(number)
}

function mergePullRequest(): void {
  const number = args[2] ?? ''
  const own = state.merge?.prs?.[number]
  const merge = own ?? state.merge ?? {}
  if (args.includes('--disable-auto')) {
    if (merge.disableAutoFails) {
      process.stderr.write('GraphQL: Something went wrong (disablePullRequestAutoMerge)\n')
      process.exit(1)
    }
    delete merge.autoMerge
    if (!own) state.merge = merge
    save()
    return
  }
  const method = ['squash', 'merge', 'rebase'].find((m) => args.includes(`--${m}`)) ?? ''
  const expected = args[args.indexOf('--match-head-commit') + 1]
  if (expected !== headOf(number)) {
    process.stderr.write('GraphQL: Head branch was modified. Review and try the merge again.\n')
    process.exit(1)
  }
  const fails = mergeOf(number).mergeFails
  if (fails !== undefined) {
    process.stderr.write(`${fails}\n`)
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
  if (!own) state.merge = merge
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
  const gate = state.graphqlGate
  if (gate && (gate.after ?? 0) > 0) {
    gate.after = (gate.after ?? 0) - 1
    save()
  } else if (gate) {
    writeFileSync(gate.entered, 'waiting')
    while (!existsSync(gate.release)) await sleep(5)
  }
  const { variables } = JSON.parse(stdin) as { variables: Record<string, unknown> }
  process.stdout.write(`${JSON.stringify(pullRequests(variables))}\n`)
} else if (graphql && stdin.includes('updatePullRequestBranch')) {
  const head = rebaseBranch()
  process.stdout.write(
    `${JSON.stringify({ data: { updatePullRequestBranch: { pullRequest: { headRefOid: head } } } })}\n`,
  )
} else if (args[0] === 'api' && /\/actions\/jobs\/\d+\/logs$/.test(args[1] ?? '')) {
  const job = /\/jobs\/(\d+)\/logs$/.exec(args[1] ?? '')?.[1] ?? ''
  const log = state.logs?.[job]
  if (log === undefined) {
    process.stderr.write('gh: Not Found (HTTP 404)\n')
    process.exit(1)
  }
  process.stdout.write(log)
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
  const number = state.pr?.numbered
    ? 7 + Object.keys(state.heads ?? {}).length
    : (state.pr?.numbers?.[repo] ?? state.pr?.number ?? 7)
  if (args[1] === 'create' && state.pr?.createFails) {
    process.stderr.write(`${state.pr.createFails}\n`)
    process.exit(1)
  }
  if (args[1] === 'create') {
    state.heads = { ...state.heads, [String(number)]: args[args.indexOf('--head') + 1] ?? '' }
    state.prRepos = { ...state.prRepos, [String(number)]: repo }
    save()
    process.stdout.write(`https://github.com/${repo}/pull/${number}\n`)
  } else if (args[1] === 'list') process.stdout.write('[]\n')
  else if (args[1] === 'merge') {
    if (state.mergeGate) {
      writeFileSync(state.mergeGate.entered, 'waiting')
      while (!existsSync(state.mergeGate.release)) await sleep(5)
    }
    mergePullRequest()
  } else if (args[1] === 'view') process.stdout.write('{"isDraft":false}\n')
  else if (!['ready', 'edit', 'close', 'reopen'].includes(args[1] ?? '')) {
    process.stderr.write(`stub gh: unknown command ${args.join(' ')}\n`)
    process.exit(1)
  }
} else {
  process.stderr.write(`stub gh: unknown command ${args.join(' ')}\n`)
  process.exit(1)
}
