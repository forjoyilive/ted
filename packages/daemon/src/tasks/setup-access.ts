import type { SandboxGroup, SetupAppTried, SetupCheckTried, SetupProposal } from '@ted/protocol'
import type { AppDeclaration } from '../apps/declared.ts'
import {
  type CheckSettings,
  type CommandCheckSettings,
  githubRepoOf,
  type RepoSettings,
} from '../workflow/check.ts'

export function approvedGroups(
  declared: readonly SandboxGroup[] | undefined,
  approved: readonly SandboxGroup[] | undefined,
): SandboxGroup[] | undefined {
  const kept = (declared ?? []).filter((g) => approved?.includes(g) === true)
  return kept.length > 0 ? kept : undefined
}

export function approvedChecks(
  declared: readonly CheckSettings[],
  tried: readonly SetupCheckTried[],
  primaryName: string,
): CommandCheckSettings[] {
  return declared.flatMap((c) => {
    if (c.run === undefined) return []
    const match = tried.find(
      (t) =>
        t.passed &&
        t.name === c.name &&
        t.command === c.run &&
        (t.repo ?? primaryName) === (c.repo ?? primaryName),
    )
    if (!match) return []
    const { sandbox_access: branchAccess, ...check } = c
    const groups = approvedGroups(branchAccess, match.sandboxAccess)
    return [{ ...check, run: c.run, ...(groups && { sandbox_access: groups }) }]
  })
}

export function approvedApps(
  declared: readonly AppDeclaration[],
  tried: readonly SetupAppTried[],
  repoNames: readonly string[],
  primaryName: string,
): AppDeclaration[] {
  return declared.flatMap(({ sandboxAccess: branchAccess, ...app }) => {
    const match = tried.find(
      (t) =>
        t.passed &&
        t.name === app.name &&
        t.run === app.run &&
        repoNames.includes(t.repo ?? primaryName),
    )
    if (!match) return []
    const groups = approvedGroups(branchAccess, match.sandboxAccess)
    return [{ ...app, ...(groups && { sandboxAccess: groups }) }]
  })
}

export function setupWorktreeDifferences(
  proposal: Pick<SetupProposal, 'worktree'>,
  repos: readonly RepoSettings[],
  primaryName: string,
): string[] {
  const nameOf = (repo: string | undefined) =>
    repo === undefined || repo === repos[0]?.name ? primaryName : repo
  const key = (repo: string, step: string) => `${repo}\0${step}`
  const proposed = new Map(
    (proposal.worktree ?? []).map((line) => [
      key(nameOf(line.repo), line.step),
      [...line.sandboxAccess],
    ]),
  )
  const declared = new Map<string, SandboxGroup[]>()
  repos.forEach((repo, i) => {
    const remoteName =
      repo.remote === undefined
        ? undefined
        : githubRepoOf(repo.remote)?.split('/')[1]?.toLowerCase()
    const name = i === 0 ? primaryName : (repo.name ?? remoteName ?? `repo ${i + 1} (no name)`)
    for (const step of ['setup', 'teardown'] as const) {
      const groups = repo.worktree?.[step]?.sandbox_access ?? []
      if (groups.length > 0) declared.set(key(name, step), [...groups])
    }
  })
  const differences: string[] = []
  for (const k of new Set([...proposed.keys(), ...declared.keys()])) {
    const want = [...(proposed.get(k) ?? [])].sort()
    const have = [...(declared.get(k) ?? [])].sort()
    if (want.join(',') === have.join(',')) continue
    const [repo = '', step = ''] = k.split('\0')
    const list = (groups: readonly string[]) => (groups.length === 0 ? 'none' : groups.join(', '))
    differences.push(
      `${repo}’s worktree ${step} asks for sandbox access ${list(have)}; the approved proposal lists ${list(want)}`,
    )
  }
  return differences
}
