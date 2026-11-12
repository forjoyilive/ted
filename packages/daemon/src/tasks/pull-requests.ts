import type { CiSignal, TaskRepo } from '@ted/protocol'
import { parse } from 'yaml'
import * as git from '../git.ts'
import type { Gh } from '../github/gh.ts'
import { redactSecrets } from '../redact.ts'
import type { TedStore } from '../store/index.ts'

export interface PullRequestTarget {
  name: string
  repo: string
  branch: string
  worktree: string
  base: string
  url: string
}

export interface PullRequestTask {
  id: string
  displayId: string
  title: string
  goal?: string
  sourceUrl?: string
  fixes?: string
}

export interface PullRequests {
  push(task: PullRequestTask, targets: PullRequestTarget[], mode: 'first' | 'again'): Promise<void>
  ready(task: PullRequestTask, targets: PullRequestTarget[]): Promise<void>
  close(taskId: string): Promise<void>
  reopen(taskId: string): Promise<void>
}

export function createPullRequests(options: { store: TedStore; gh: Gh }): PullRequests {
  const { store, gh } = options
  const repoOf = (taskId: string, name: string): TaskRepo | undefined =>
    store.getTask(taskId)?.repos.find((r) => r.name === name)

  const isOpen = (repo: TaskRepo | undefined) =>
    repo?.pullRequest !== undefined && repo.pullRequest.state !== 'closed'

  async function pushOne(task: PullRequestTask, target: PullRequestTarget): Promise<boolean> {
    if (repoOf(task.id, target.name)?.pullRequest?.state === 'merged') return false
    try {
      const ahead = await git.commitsAhead(target.worktree, `origin/${target.base}`)
      if (ahead === 0) return false
      const head = await git.headCommit(target.worktree)
      const recorded = repoOf(task.id, target.name)?.pushed?.commit
      const commit = await git
        .pushBranch(target.worktree, target.branch, {
          url: target.url,
          commit: head,
          ...(recorded !== undefined && { expected: recorded }),
        })
        .catch((error: unknown) => {
          if (recorded === undefined) throw error
          return pushPastRecord(task, target, { head, recorded }, error)
        })
      const ci = await detectCi({ gh, commit, ...target })
      store.branchPushed(task.id, target.name, { commit, ...ci })
      if (isOpen(repoOf(task.id, target.name))) return false
      const opened = await openDraft(task, target)
      store.pullRequestOpened(task.id, target.name, { ...opened, base: target.base })
      return true
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error))
      console.error(`couldn’t push ${task.displayId}’s ${target.name}: ${message}`)
      store.branchPushFailed(task.id, target.name, message)
      return false
    }
  }

  async function pushPastRecord(
    task: PullRequestTask,
    target: PullRequestTarget,
    { head, recorded }: { head: string; recorded: string },
    refused: unknown,
  ): Promise<string> {
    const remote = await git
      .fetchBranch(target.worktree, { url: target.url, branch: target.branch, haves: [recorded] })
      .catch(() => undefined)
    if (remote === undefined || remote === recorded) throw refused
    if (!(await git.isAncestor(target.worktree, remote, head))) {
      throw new git.GitError(
        `git push refused: the ${target.branch} branch on GitHub is at ${remote.slice(0, 8)}, which the commit being pushed (${head.slice(0, 8)}) does not include. TED last recorded a push of ${recorded.slice(0, 8)} and won’t overwrite commits it didn’t push.`,
      )
    }
    store.pushRecordReconciled(task.id, target.name, { recorded, remote })
    if (remote === head) return head
    return git.pushBranch(target.worktree, target.branch, {
      url: target.url,
      expected: remote,
      commit: head,
    })
  }

  async function openDraft(
    task: PullRequestTask,
    target: PullRequestTarget,
  ): Promise<{ number: number; url: string }> {
    const body = pullRequestBody(task, [])
    try {
      const out = await gh.run(
        [
          'pr',
          'create',
          '--draft',
          '--repo',
          target.repo,
          '--head',
          target.branch,
          '--base',
          target.base,
          '--title',
          task.title,
          '--body-file',
          '-',
        ],
        { input: body },
      )
      const found = parsePullRequestUrl(out)
      if (found) return found
      throw new Error(`gh pr create printed no pull request URL`)
    } catch (error) {
      const existing = await findOpen(target).catch(() => undefined)
      if (existing) return existing
      throw error
    }
  }

  async function findOpen(target: PullRequestTarget) {
    const out = await gh.run([
      'pr',
      'list',
      '--repo',
      target.repo,
      '--head',
      target.branch,
      '--state',
      'open',
      '--json',
      'number,url',
      '--limit',
      '1',
    ])
    const [first] = JSON.parse(out) as { number?: unknown; url?: unknown }[]
    return typeof first?.number === 'number' && typeof first.url === 'string'
      ? { number: first.number, url: first.url }
      : undefined
  }

  async function linkAll(task: PullRequestTask, targets: PullRequestTarget[]): Promise<void> {
    const open = targets.flatMap((target) => {
      const pr = repoOf(task.id, target.name)?.pullRequest
      return pr && pr.state !== 'closed' && pr.state !== 'merged'
        ? [{ target, number: pr.number }]
        : []
    })
    if (open.length < 2) return
    for (const { target, number } of open) {
      const others = open
        .filter((o) => o.target.name !== target.name)
        .map((o) => `${o.target.repo}#${o.number}`)
      await gh
        .run(['pr', 'edit', String(number), '--repo', target.repo, '--body-file', '-'], {
          input: pullRequestBody(task, others),
        })
        .catch((error: unknown) =>
          console.error(
            `couldn’t link ${task.displayId}’s pull requests:`,
            redactSecrets(error instanceof Error ? error.message : String(error)),
          ),
        )
    }
  }

  return {
    async push(task, targets, mode) {
      const chosen =
        mode === 'first' ? targets.filter((t) => !isOpen(repoOf(task.id, t.name))) : targets
      let opened = false
      for (const target of chosen) {
        if (await pushOne(task, target)) opened = true
      }
      if (opened) await linkAll(task, targets)
    },

    async ready(task, targets) {
      for (const target of targets) {
        const before = repoOf(task.id, target.name)
        if (before?.pullRequest?.state !== 'draft') continue
        await pushOne(task, target)
        const repo = repoOf(task.id, target.name)
        const pr = repo?.pullRequest
        if (pr?.state !== 'draft') continue
        if (repo?.pushFailed) {
          console.error(
            `left ${task.displayId}’s pull request ${target.repo}#${pr.number} as a draft: its branch couldn’t be pushed`,
          )
          continue
        }
        try {
          await gh.run(['pr', 'ready', String(pr.number), '--repo', target.repo])
          store.pullRequestMarkedReady(task.id, target.name)
        } catch (error) {
          console.error(
            `couldn’t mark ${task.displayId}’s pull request ready:`,
            redactSecrets(error instanceof Error ? error.message : String(error)),
          )
        }
      }
    },

    async close(taskId) {
      for (const repo of store.getTask(taskId)?.repos ?? []) {
        const pr = repo.pullRequest
        if (!pr || pr.state === 'closed' || pr.state === 'merged') continue
        try {
          await gh.run(['pr', 'close', String(pr.number), '--repo', repo.repo])
          store.pullRequestClosed(taskId, repo.name)
        } catch (error) {
          console.error(
            `couldn’t close pull request ${repo.repo}#${pr.number}:`,
            redactSecrets(error instanceof Error ? error.message : String(error)),
          )
        }
      }
    },

    async reopen(taskId) {
      for (const repo of store.getTask(taskId)?.repos ?? []) {
        const pr = repo.pullRequest
        if (pr?.state !== 'closed') continue
        try {
          await gh.run(['pr', 'reopen', String(pr.number), '--repo', repo.repo])
          const view = await gh
            .run(['pr', 'view', String(pr.number), '--repo', repo.repo, '--json', 'isDraft'])
            .catch(() => '{}')
          const draft = (JSON.parse(view) as { isDraft?: unknown }).isDraft !== false
          store.pullRequestReopened(taskId, repo.name, draft ? 'draft' : 'ready')
        } catch (error) {
          console.error(
            `couldn’t reopen pull request ${repo.repo}#${pr.number}; its branch may be gone:`,
            redactSecrets(error instanceof Error ? error.message : String(error)),
          )
        }
      }
    },
  }
}

export function pullRequestBody(task: PullRequestTask, others: string[]): string {
  const goal = task.goal?.trim() || 'No Task brief yet.'
  const from = task.sourceUrl
    ? `Opened by TED for ${task.displayId} (${task.sourceUrl}).`
    : `Opened by TED for ${task.displayId}.`
  const linked = others.length > 0 ? [`Part of the same Task: ${others.join(', ')}`] : []
  const fixes = task.fixes === undefined ? [] : [`Fixes ${task.fixes}`]
  return [goal, '---', from, ...linked, ...fixes].join('\n\n')
}

export function parsePullRequestUrl(out: string): { number: number; url: string } | undefined {
  const match = /https?:\/\/\S+\/pull\/(\d+)/.exec(out)
  return match?.[1] ? { number: Number(match[1]), url: match[0] } : undefined
}

export async function detectCi(input: {
  gh: Pick<Gh, 'api' | 'graphql'>
  repo: string
  base: string
  worktree: string
  commit: string
}): Promise<{ ci: boolean; ciSignals: CiSignal[] }> {
  const [owner = '', name = ''] = input.repo.split('/')
  const base = encodeURIComponent(input.base)
  const checks: [CiSignal, () => Promise<boolean>][] = [
    [
      'workflow-files',
      async () => {
        const files = (
          await git.listFiles(input.worktree, input.commit, '.github/workflows')
        ).filter((file) => /\.ya?ml$/.test(file))
        const runs = await Promise.all(
          files.map((file) =>
            git.showFile(input.worktree, input.commit, file).then(runsOnChanges, () => true),
          ),
        )
        return runs.includes(true)
      },
    ],
    [
      'required-checks',
      async () => {
        const [branch, rules] = await Promise.all([
          input.gh.api(`repos/${owner}/${name}/branches/${base}`).catch(() => undefined),
          input.gh.api(`repos/${owner}/${name}/rules/branches/${base}`).catch(() => undefined),
        ])
        const required = (branch as BranchBody | undefined)?.protection?.required_status_checks
        const fromProtection =
          (required?.contexts?.length ?? 0) > 0 || (required?.checks?.length ?? 0) > 0
        const fromRules =
          Array.isArray(rules) &&
          rules.some((rule: { type?: unknown }) => rule?.type === 'required_status_checks')
        return fromProtection || fromRules
      },
    ],
    [
      'recent-checks',
      async () => {
        const result = (await input.gh.graphql(recentChecksQuery, {
          owner,
          name,
          ref: `refs/heads/${input.base}`,
        })) as RecentChecksBody
        const nodes = result?.data?.repository?.ref?.target?.history?.nodes ?? []
        return nodes.some((node) => node?.statusCheckRollup != null)
      },
    ],
  ]
  const found = await Promise.all(
    checks.map(async ([signal, check]) => ((await check().catch(() => false)) ? [signal] : [])),
  )
  const ciSignals = found.flat()
  return { ci: ciSignals.length > 0, ciSignals }
}

const changeTriggers = ['pull_request', 'pull_request_target', 'push', 'merge_group']

export function runsOnChanges(workflow: string): boolean {
  let on: unknown
  try {
    on = (parse(workflow) as { on?: unknown } | null)?.on
  } catch {
    return true
  }
  const triggers =
    typeof on === 'string'
      ? [on]
      : Array.isArray(on)
        ? on
        : on !== null && typeof on === 'object'
          ? Object.keys(on)
          : undefined
  if (triggers === undefined) return true
  return triggers.some((trigger) => typeof trigger !== 'string' || changeTriggers.includes(trigger))
}

interface BranchBody {
  protection?: { required_status_checks?: { contexts?: unknown[]; checks?: unknown[] } }
}

interface RecentChecksBody {
  data?: {
    repository?: {
      ref?: {
        target?: { history?: { nodes?: ({ statusCheckRollup?: unknown } | null)[] } }
      } | null
    } | null
  }
}

const recentChecksQuery = `query($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) {
      target {
        ... on Commit {
          history(first: 20) {
            nodes { statusCheckRollup { state } }
          }
        }
      }
    }
  }
}`
