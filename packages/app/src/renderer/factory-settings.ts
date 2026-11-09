import type {
  AgentChoiceInput,
  AgentRole,
  CheckInput,
  CheckTry,
  FactorySettingsChanges,
  FactorySettingsView,
  LibraryInvalid,
  RepoSettingsInput,
  RepoSettingsView,
  StageDrift,
} from '@ted/protocol/factory-settings'
import { agentRoles, settingsInput } from '@ted/protocol/factory-settings'
import type { PermissionMode } from '@ted/protocol/run'
import type { AgentStageId, ClarifyDepth, StageId } from '@ted/protocol/task'

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

export interface StageDraft {
  enabled: boolean
  gate: boolean
  maxBack?: number
  depth?: ClarifyDepth
}

export interface SettingsDraft {
  repos: RepoSettingsInput[]
  stages: Partial<Record<StageId, StageDraft>>
  stageFiles: Partial<Record<AgentStageId, string | null>>
  keepStageFiles: AgentStageId[]
  checks: CheckInput[]
  agents: Record<AgentRole, AgentChoiceInput | null>
  permissions: PermissionMode
  maxWorkingRuns: string
  notes: string
}

export function settingsDraft(view: FactorySettingsView): SettingsDraft {
  const stages: Partial<Record<StageId, StageDraft>> = {}
  const stageFiles: Partial<Record<AgentStageId, string | null>> = {}
  for (const row of view.stages) {
    stages[row.id] = {
      enabled: row.enabled,
      gate: row.gate,
      ...(row.maxBack !== undefined && { maxBack: row.maxBack }),
      ...(row.depth !== undefined && { depth: row.depth }),
    }
    if (row.id !== 'backlog' && row.id !== 'done') stageFiles[row.id] = row.factoryFile ?? null
  }
  const agents: SettingsDraft['agents'] = { lead: null, reviewer: null, planner: null }
  for (const row of view.agents) agents[row.role] = row.own ? { ...row.own } : null
  return {
    repos: draftFrom(view.repos),
    stages,
    stageFiles,
    keepStageFiles: [],
    checks: view.checks.map((check) => ({ ...check })),
    agents,
    permissions: view.permissions,
    maxWorkingRuns: view.maxWorkingRuns === undefined ? '' : String(view.maxWorkingRuns),
    notes: view.notes,
  }
}

const stageFields = ['enabled', 'gate', 'maxBack', 'depth'] as const

function sameChoice(a: AgentChoiceInput | null, b: AgentChoiceInput | null): boolean {
  const norm = (c: AgentChoiceInput | null) =>
    c && {
      agent: c.agent?.trim() || undefined,
      model: c.model?.trim() || undefined,
      effort: c.effort || undefined,
    }
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
}

function checkKey(check: CheckInput): string {
  return JSON.stringify({
    was: check.was,
    name: check.name.trim(),
    run: check.run.trim(),
    repo: check.repo?.trim() || undefined,
    timeout: check.timeout?.trim() || undefined,
  })
}

function limitValue(text: string): number | null {
  const trimmed = text.trim()
  return trimmed === '' ? null : Number(trimmed)
}

export function settingsChanges(
  draft: SettingsDraft,
  loaded: SettingsDraft,
): FactorySettingsChanges {
  const changes: FactorySettingsChanges = { repos: draft.repos }
  for (const [id, stage] of Object.entries(draft.stages) as [StageId, StageDraft][]) {
    const before = loaded.stages[id]
    if (!before) continue
    const changed = stageFields.filter((f) => stage[f] !== before[f] && stage[f] !== undefined)
    if (changed.length === 0) continue
    changes.stages ??= {}
    changes.stages[id] = Object.fromEntries(changed.map((f) => [f, stage[f]]))
  }
  for (const [id, text] of Object.entries(draft.stageFiles) as [AgentStageId, string | null][]) {
    if (text === (loaded.stageFiles[id] ?? null)) continue
    changes.stageFiles ??= {}
    changes.stageFiles[id] = text
  }
  const kept = draft.keepStageFiles.filter((id) => !loaded.keepStageFiles.includes(id))
  if (kept.length > 0) changes.keepStageFiles = kept
  if (draft.checks.map(checkKey).join('\n') !== loaded.checks.map(checkKey).join('\n')) {
    changes.checks = draft.checks
  }
  for (const role of agentRoles) {
    if (sameChoice(draft.agents[role], loaded.agents[role])) continue
    changes.agents ??= {}
    changes.agents[role] = draft.agents[role]
  }
  if (draft.permissions !== loaded.permissions) changes.permissions = draft.permissions
  const limit = limitValue(draft.maxWorkingRuns)
  if (limit !== limitValue(loaded.maxWorkingRuns)) changes.maxWorkingRuns = limit
  if (draft.notes !== loaded.notes) changes.notes = draft.notes
  return changes
}

export interface UnsavedChanges {
  count: number
  files: string[]
}

export function unsavedChanges(draft: SettingsDraft, loaded: SettingsDraft): UnsavedChanges {
  const changes = settingsChanges(draft, loaded)
  let yaml = changeCount(draft.repos, loaded.repos)
  for (const stage of Object.values(changes.stages ?? {})) yaml += Object.keys(stage ?? {}).length
  if (changes.checks) {
    const before = new Map(loaded.checks.map((c) => [c.was, checkKey(c)]))
    const edited =
      draft.checks.filter((c) => c.was === undefined || before.get(c.was) !== checkKey(c)).length +
      loaded.checks.filter((c) => !draft.checks.some((d) => d.was === c.was)).length
    yaml += Math.max(edited, 1)
  }
  yaml += Object.keys(changes.agents ?? {}).length
  yaml += changes.keepStageFiles?.length ?? 0
  if (changes.permissions !== undefined) yaml += 1
  if (changes.maxWorkingRuns !== undefined) yaml += 1
  const stageFiles = Object.entries(changes.stageFiles ?? {}) as [AgentStageId, string | null][]
  const overrides = stageFiles.some(
    ([id, text]) => (text === null) !== ((loaded.stageFiles[id] ?? null) === null),
  )
  const files: string[] = []
  if (yaml > 0 || overrides) files.push('.ted/workflow.yaml')
  for (const [id] of stageFiles) files.push(`.ted/stages/${id}.md`)
  if (changes.notes !== undefined) files.push('.ted/notes.md')
  return { count: yaml + stageFiles.length + (changes.notes !== undefined ? 1 : 0), files }
}

export function unsavedSummary({ count, files }: UnsavedChanges): string {
  const changes = `${count} unsaved ${count === 1 ? 'change' : 'changes'}`
  if (files.length === 1) return `${changes} to ${files[0]}`
  return `${changes} to ${files.length} files in .ted/`
}

export type StageField = 'enabled' | 'gate' | 'maxBack' | 'depth' | 'file' | 'kept'

export function stageEdited(
  draft: SettingsDraft,
  loaded: SettingsDraft,
  id: StageId,
): Set<StageField> {
  const edited = new Set<StageField>()
  const now = draft.stages[id]
  const before = loaded.stages[id]
  if (now && before) for (const f of stageFields) if (now[f] !== before[f]) edited.add(f)
  if (id !== 'backlog' && id !== 'done') {
    if ((draft.stageFiles[id] ?? null) !== (loaded.stageFiles[id] ?? null)) edited.add('file')
    if (draft.keepStageFiles.includes(id) && !loaded.keepStageFiles.includes(id)) edited.add('kept')
  }
  return edited
}

export function agentEdited(draft: SettingsDraft, loaded: SettingsDraft, role: AgentRole): boolean {
  return !sameChoice(draft.agents[role], loaded.agents[role])
}

export function lastRunText(checkTry: CheckTry, now: number): string {
  const ago = timeAgo(Date.parse(checkTry.finishedAt ?? checkTry.startedAt), now)
  const took = checkTry.durationMs === undefined ? '' : `${duration(checkTry.durationMs)} · `
  if (checkTry.setupFailed === true) return `✗ Setup failed · ${ago}`
  switch (checkTry.state) {
    case 'running':
      return `Running · ${duration(now - Date.parse(checkTry.startedAt))}`
    case 'passed':
      return `✓ ${took}${ago}`
    case 'timed-out':
      return `✗ Timed out · ${ago}`
    case 'stopped':
      return `Stopped · ${ago}`
    default:
      return checkTry.exitCode === 127
        ? `✗ Command not found · ${ago}`
        : `✗ Exit ${checkTry.exitCode ?? '?'} · ${ago}`
  }
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function timeAgo(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? '1 day ago' : `${days} days ago`
}

export function driftLine(
  stage: AgentStageId,
  drift: StageDrift,
  label: 'Inherited' | 'Default',
): string {
  const file = `${stage}.md`
  const changed =
    drift.layer === 'library'
      ? `Your Library’s ${file} changed.`
      : `TED’s default ${file} changed${drift.changedIn === undefined ? '' : ` in TED ${drift.changedIn}`}.`
  return `${label} version changed. ${changed} Your copy is based on ${drift.basedOn}.`
}

export function lastValidLine(invalid: LibraryInvalid & { url?: string }, now: number): string {
  if (invalid.url === undefined) {
    if (!invalid.lastValid) {
      return 'TED has no earlier valid version, so TED’s defaults apply. Saving from here replaces the broken file.'
    }
    return `TED is using the last valid version, from ${invalid.lastValid.version}, ${timeAgo(Date.parse(invalid.lastValid.at), now)}. This page shows that version. Saving from here replaces the broken file.`
  }
  if (!invalid.lastValid) {
    return 'TED has no earlier valid version, so the inherited settings apply. Saving from here replaces the broken file.'
  }
  return `TED is using the last valid version, from ${invalid.lastValid.version}, ${timeAgo(Date.parse(invalid.lastValid.at), now)}. This panel shows that version. Saving from here replaces the broken file, and the Save diff shows it.`
}
