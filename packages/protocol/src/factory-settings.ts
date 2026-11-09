import type { PermissionMode } from './run.ts'
import type { AgentStageId, ClarifyDepth, Effort, StageId } from './task.ts'
import type { LayerKind, WorkflowProblem } from './workflow.ts'

export const appKinds = ['web', 'command', 'ios-simulator'] as const
export type AppKind = (typeof appKinds)[number]

export const settingsMergeMethods = ['squash', 'merge', 'rebase'] as const
export type SettingsMergeMethod = (typeof settingsMergeMethods)[number]

export interface WorktreeCommandInput {
  run: string
  timeout?: string
}

export interface EnvVariable {
  name: string
  value: string
}

export interface AppInput {
  was?: number
  name: string
  kind: AppKind
  run: string
  url?: string
}

export interface RepoSettingsInput {
  was?: string
  repo: string
  remote?: string
  name: string
  baseBranch?: string
  mergeMethod?: SettingsMergeMethod
  setup?: WorktreeCommandInput
  teardown?: WorktreeCommandInput
  env: EnvVariable[]
  copy: string[]
  apps: AppInput[]
}

export const agentRoles = ['lead', 'reviewer', 'planner'] as const
export type AgentRole = (typeof agentRoles)[number]

export interface AgentChoiceInput {
  agent?: string
  model?: string
  effort?: Effort
}

export interface CheckInput {
  was?: number
  name: string
  run: string
  repo?: string
  timeout?: string
}

export interface StageSettingsInput {
  enabled?: boolean
  gate?: boolean
  maxBack?: number
  depth?: ClarifyDepth
}

export interface FactorySettingsChanges {
  repos: RepoSettingsInput[]
  stages?: Partial<Record<StageId, StageSettingsInput>>
  stageFiles?: Partial<Record<AgentStageId, string | null>>
  keepStageFiles?: AgentStageId[]
  checks?: CheckInput[]
  agents?: Partial<Record<AgentRole, AgentChoiceInput | null>>
  permissions?: PermissionMode
  maxWorkingRuns?: number | null
  notes?: string
}

export interface StageRowView {
  id: StageId
  inOrder: boolean
  enabled: boolean
  gate: boolean
  maxBack?: number
  depth?: ClarifyDepth
  from: LayerKind
  factoryFile?: string
  inherited?: { layer: LayerKind; text: string }
  basedOn?: string
  drift?: StageDrift
}

export interface StageDrift {
  basedOn: string
  current: string
  layer: LayerKind
  changedIn?: string
  diffOf: 'inherited' | 'yours'
  diff: DiffLine[]
}

export interface DriftCounts {
  factories: Record<string, number>
  library: number
}

export interface AgentRowView {
  role: AgentRole
  own?: AgentChoiceInput
  inherited: AgentChoiceInput
  inheritedFrom: LayerKind
  from: LayerKind
}

export interface CheckView extends CheckInput {
  was: number
}

export type CheckTryState = 'running' | 'passed' | 'failed' | 'timed-out' | 'stopped'

export interface CheckTry {
  factoryId: string
  name: string
  repo: string
  state: CheckTryState
  exitCode?: number
  setupFailed?: boolean
  durationMs?: number
  startedAt: string
  finishedAt?: string
}

export interface CheckTryRequest {
  name: string
  run: string
  repo?: string
  timeout?: string
}

export interface CheckTryOutput {
  text: string
  log: string
}

export interface InvalidSettings {
  file: string
  line: number
  column: number
  message: string
  url: string
  lastValid?: { version: string; at: string }
}

export interface CopyFileState {
  path: string
  found: boolean
}

export interface RepoLocalFolder {
  path: string
  found: boolean
  copies: CopyFileState[]
}

export interface RepoSettingsView extends RepoSettingsInput {
  was: string
  primary: boolean
  localFolder?: RepoLocalFolder
}

export type SettingsSource = 'file' | 'last-valid' | 'none'

export interface FactorySettingsView {
  factoryId: string
  repo: string
  defaultBranch: string
  source: SettingsSource
  version: string
  repos: RepoSettingsView[]
  problems: WorkflowProblem[]
  github: { ready: boolean; login?: string; problem?: string }
  stages: StageRowView[]
  ignoredStageFiles: string[]
  checks: CheckView[]
  tries: CheckTry[]
  agents: AgentRowView[]
  permissions: PermissionMode
  maxWorkingRuns?: number
  machineMaxWorkingRuns: number
  notes: string
  invalid?: InvalidSettings
}

export type DiffLineKind = 'same' | 'added' | 'removed' | 'gap'

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

export interface FileChange {
  path: string
  added: number
  removed: number
  lines: DiffLine[]
}

export interface SettingsPreview {
  files: FileChange[]
  problems: WorkflowProblem[]
  sideEffects: string[]
  valid: boolean
  turnsOnBypass: boolean
}

export type SettingsSaveMode = 'merge' | 'pull-request'

export interface SaveSettingsRequest {
  changes: FactorySettingsChanges
  mode: SettingsSaveMode
  version: string
  confirmBypass?: boolean
}

export interface SaveSettingsResult {
  pullRequest: { number: number; url: string }
  merged: boolean
  reason?: string
}

export interface RenameFactoryRequest {
  name: string
}

export function settingsInput(view: RepoSettingsView): RepoSettingsInput {
  const { primary: _, localFolder: __, ...input } = view
  return input
}

export function sameRepoSettings(a: RepoSettingsInput, b: RepoSettingsInput): boolean {
  return JSON.stringify(normalized(a)) === JSON.stringify(normalized(b))
}

function normalized(repo: RepoSettingsInput) {
  return {
    was: repo.was,
    repo: repo.repo,
    name: repo.name.trim(),
    baseBranch: repo.baseBranch?.trim() || undefined,
    mergeMethod: repo.mergeMethod,
    setup: command(repo.setup),
    teardown: command(repo.teardown),
    env: repo.env.filter((v) => v.name.trim() !== '' || v.value !== ''),
    copy: repo.copy,
    apps: repo.apps,
  }
}

function command(given: WorktreeCommandInput | undefined) {
  const run = given?.run.trim() ?? ''
  if (run === '') return undefined
  return { run, timeout: given?.timeout?.trim() || undefined }
}

export interface LibraryChanges {
  stages?: Partial<Record<StageId, StageSettingsInput>>
  stageFiles?: Partial<Record<AgentStageId, string | null>>
  keepStageFiles?: AgentStageId[]
  agents?: Partial<Record<AgentRole, AgentChoiceInput | null>>
}

export interface LibraryStageRow {
  id: StageId
  inOrder: boolean
  enabled: boolean
  gate: boolean
  maxBack?: number
  depth?: ClarifyDepth
  from: LayerKind
  libraryFile?: string
  defaultText?: string
  basedOn?: string
  drift?: StageDrift
}

export interface LibraryAgentRow {
  role: AgentRole
  own?: AgentChoiceInput
  default: AgentChoiceInput
  from: LayerKind
}

export interface LibraryInvalid {
  file: string
  line: number
  column: number
  message: string
  lastValid?: { version: string; at: string }
}

export interface LibraryView {
  path: string
  version: string
  stages: LibraryStageRow[]
  agents: LibraryAgentRow[]
  problems: WorkflowProblem[]
  invalid?: LibraryInvalid
}

export interface LibraryPreview {
  files: FileChange[]
  problems: WorkflowProblem[]
  valid: boolean
}

export interface SaveLibraryRequest {
  changes: LibraryChanges
  version: string
}
