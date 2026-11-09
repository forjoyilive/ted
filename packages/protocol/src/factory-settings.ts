import type { WorkflowProblem } from './workflow.ts'

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

export interface FactorySettingsChanges {
  repos: RepoSettingsInput[]
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
}

export type SettingsSaveMode = 'merge' | 'pull-request'

export interface SaveSettingsRequest {
  changes: FactorySettingsChanges
  mode: SettingsSaveMode
  version: string
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
