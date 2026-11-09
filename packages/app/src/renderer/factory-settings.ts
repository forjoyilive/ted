import type { RepoSettingsInput, RepoSettingsView } from '@ted/protocol/factory-settings'
import { settingsInput } from '@ted/protocol/factory-settings'

export type RepoField =
  | 'name'
  | 'baseBranch'
  | 'mergeMethod'
  | 'setup'
  | 'teardown'
  | 'env'
  | 'copy'
  | 'apps'

const fields: RepoField[] = [
  'name',
  'baseBranch',
  'mergeMethod',
  'setup',
  'teardown',
  'env',
  'copy',
  'apps',
]

export function draftFrom(repos: readonly RepoSettingsView[]): RepoSettingsInput[] {
  return repos.map((repo) => structuredClone(settingsInput(repo)))
}

function value(repo: RepoSettingsInput, field: RepoField): unknown {
  switch (field) {
    case 'name':
      return repo.name.trim()
    case 'baseBranch':
      return repo.baseBranch?.trim() || undefined
    case 'mergeMethod':
      return repo.mergeMethod ?? 'squash'
    case 'setup':
    case 'teardown': {
      const run = repo[field]?.run.trim() ?? ''
      return run === '' ? undefined : { run, timeout: repo[field]?.timeout?.trim() || undefined }
    }
    case 'env':
      return repo.env.filter((v) => v.name.trim() !== '' || v.value !== '')
    case 'copy':
      return repo.copy
    case 'apps':
      return repo.apps
  }
}

export function editedFields(
  repo: RepoSettingsInput,
  loaded: readonly RepoSettingsInput[],
): Set<RepoField> {
  const before = loaded.find((r) => r.was !== undefined && r.was === repo.was)
  if (!before) return new Set()
  return new Set(
    fields.filter(
      (field) => JSON.stringify(value(repo, field)) !== JSON.stringify(value(before, field)),
    ),
  )
}

export function changeCount(
  draft: readonly RepoSettingsInput[],
  loaded: readonly RepoSettingsInput[],
): number {
  let count = 0
  for (const repo of draft) {
    count += repo.was === undefined ? 1 : editedFields(repo, loaded).size
  }
  count += loaded.filter((r) => !draft.some((d) => d.was === r.was)).length
  const order = (repos: readonly RepoSettingsInput[]) =>
    repos.flatMap((r) => (r.was === undefined ? [] : [r.was])).join('\n')
  const kept = loaded.filter((r) => draft.some((d) => d.was === r.was))
  if (order(draft) !== order(kept)) count += 1
  return count
}

export function unsavedLine(count: number): string {
  return `${count} unsaved ${count === 1 ? 'change' : 'changes'} to .ted/workflow.yaml`
}

export function remoteFor(repo: string, given: string | undefined): string {
  const ssh = given !== undefined && /^(?:ssh:\/\/|[^@/:]+@github\.com:)/i.test(given.trim())
  return ssh ? `git@github.com:${repo}.git` : `https://github.com/${repo}.git`
}

export function missingCopies(copies: readonly string[]): string {
  const named = copies.filter((c) => c.trim() !== '')
  if (named.length === 0)
    return 'Files to copy won’t be copied into new worktrees until you locate it.'
  const list =
    named.length === 1
      ? named[0]
      : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`
  return `${list} won’t be copied into new worktrees until you locate it.`
}
