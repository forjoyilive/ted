import type { PullRequestCiMode } from '@ted/protocol'
import { type AppDeclaration, appDeclarations } from '../apps/declared.ts'
import type { StoredFactory } from '../store/index.ts'
import { githubRepoOf, type RepoSettings } from '../workflow/check.ts'
import type { ResolvedWorkflow } from '../workflow/resolve.ts'
import { primaryRepoWorktree, type RepoWorktree, worktreeCommands } from './worktree.ts'

export interface FactoryRepoEntry extends Omit<RepoWorktree, 'baseBranch'> {
  repo: string
  cloneUrl: string
  primary: boolean
  baseBranch?: string
  pullRequestCi?: PullRequestCiMode
  apps?: AppDeclaration[]
}

const safeSegment = /^[A-Za-z0-9_.-]+$/

export function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export function isSafeRepo(repo: string): boolean {
  const parts = repo.split('/')
  return parts.length === 2 && parts.every((p) => safeSegment.test(p) && p !== '.' && p !== '..')
}

function pullRequestCiOf(settings: RepoSettings | undefined): {
  pullRequestCi?: PullRequestCiMode
} {
  const mode = settings?.pull_request_ci
  return mode === undefined ? {} : { pullRequestCi: mode }
}

function safeName(name: string): boolean {
  return safeSegment.test(name) && name !== '.' && name !== '..' && name !== 'sub-agents'
}

export function factoryRepos(
  workflow: ResolvedWorkflow,
  factory: StoredFactory,
): FactoryRepoEntry[] {
  const primary = primaryRepoWorktree(workflow, factory)
  const entries: FactoryRepoEntry[] = [
    {
      ...primary,
      repo: factory.repo,
      cloneUrl: factory.cloneUrl,
      primary: true,
      ...pullRequestCiOf(workflow.settings.repos?.[0]),
      apps: appDeclarations(workflow.settings.repos?.[0]?.apps),
    },
  ]
  const listed = workflow.settings.repos
  const add = (entry: FactoryRepoEntry) => {
    if (!isSafeRepo(entry.repo) || !safeName(entry.name)) return
    if (entries.some((e) => sameRepo(e.repo, entry.repo) || e.name === entry.name)) return
    entries.push(entry)
  }
  if (listed && listed.length > 0) {
    for (const settings of listed.slice(1)) {
      const repo = settings.remote === undefined ? undefined : githubRepoOf(settings.remote)
      if (repo === undefined || settings.remote === undefined) continue
      const stored = factory.repos.find((r) => sameRepo(r.repo, repo))
      if (!stored) continue
      add({
        name: settings.name ?? stored.name,
        repo: stored.repo,
        cloneUrl: stored.cloneUrl,
        primary: false,
        ...(settings.base_branch !== undefined && { baseBranch: settings.base_branch }),
        ...pullRequestCiOf(settings),
        ...worktreeCommands(settings.worktree),
        apps: appDeclarations(settings.apps),
      })
    }
  } else {
    for (const stored of factory.repos.slice(1)) {
      add({
        name: stored.name,
        repo: stored.repo,
        cloneUrl: stored.cloneUrl,
        primary: false,
        env: {},
        copy: [],
      })
    }
  }
  return entries
}

export function findRepo(
  entries: readonly FactoryRepoEntry[],
  ref: string,
): FactoryRepoEntry | undefined {
  const wanted = ref.trim()
  return entries.find((e) => e.name === wanted.toLowerCase() || sameRepo(e.repo, wanted))
}

export function chosenEntries(
  chosen: readonly string[],
  entries: readonly FactoryRepoEntry[],
): FactoryRepoEntry[] {
  const picked = entries.filter((e) => chosen.some((repo) => sameRepo(repo, e.repo)))
  const primary = entries[0]
  return picked.length > 0 ? picked : primary ? [primary] : []
}

export function repoEntry(
  entries: readonly FactoryRepoEntry[],
  taskRepo: { repo: string; name: string },
): FactoryRepoEntry | undefined {
  return entries.find((e) => sameRepo(e.repo, taskRepo.repo))
}
