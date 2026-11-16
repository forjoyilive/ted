import type {
  AddFactoryRequest,
  AutoStartBacklogRequest,
  CheckRepoRequest,
  CreateFactoryRequest,
  FactoryLayout,
  FactoryLayoutItem,
  NewFactoryRepo,
  RemoveFactoryRequest,
  ReorderFactoriesRequest,
  RepoSource,
  SetFactoryNotificationsRequest,
  SetFactoryPermissionsRequest,
  SetLocalFolderRequest,
  SetRepoFolderRequest,
  StopCheckTryRequest,
} from './factory.ts'
import { factoryGroupNameMax } from './factory.ts'
import {
  type FactoryIcon,
  type FactoryIconColor,
  type FactoryIconSymbol,
  factoryIconColors,
  factoryIconEmoji,
  factoryIconImageMaxBytes,
  factoryIconImagePrefix,
  factoryIconSymbols,
  type SetFactoryIconRequest,
} from './factory-icon.ts'
import type {
  LibraryChanges,
  MergeSettingsRequest,
  RenameFactoryRequest,
  SaveLibraryRequest,
  SaveSettingsRequest,
} from './factory-settings.ts'
import {
  type AgentChoiceInput,
  type AppInput,
  agentRoles,
  appKinds,
  type CheckInput,
  type CheckTryRequest,
  type CleanupSettingsInput,
  type CleanupStepInput,
  type FactorySettingsChanges,
  type RepoSettingsInput,
  type SettingsMergeMethod,
  type SettingsSaveMode,
  type StageSettingsInput,
  settingsMergeMethods,
  type WorktreeCommandInput,
} from './factory-settings.ts'
import { permissionModes } from './run.ts'
import {
  handsOff,
  hasClarifyRounds,
  isBuiltInStage,
  isStageId,
  mergesHere,
  stageFileId,
  validates,
} from './stage.ts'
import {
  type AgentStageId,
  type ClarifyDepth,
  clarifyDepths,
  type Effort,
  efforts,
  type StageId,
} from './task.ts'
import {
  agentChoice,
  bodyObject,
  RequestValidationError as HttpError,
  optionalText,
  text,
} from './validation.ts'

const maxSettingsRepos = 10
const maxListItems = 200
const maxFileChars = 256 * 1024

export function parseCheckTryRequest(given: unknown): CheckTryRequest {
  const body = record(given)
  const name = text(body.name, 'name').trim()
  const run = text(body.run, 'run').trim()
  if (name === '' || run === '') throw new HttpError(400, 'A Check needs a name and a command')
  const repo = optionalText(body.repo, 'repo')?.trim() || undefined
  const timeout = optionalText(body.timeout, 'timeout')?.trim() || undefined
  if (timeout !== undefined && !/^\d+[smh]$/.test(timeout)) {
    throw new HttpError(400, 'timeout must be a duration such as 30s, 15m or 1h')
  }
  return {
    name,
    run,
    ...(repo !== undefined && { repo }),
    ...(timeout !== undefined && { timeout }),
  }
}

const builtInOnlyFields = [
  'enabled',
  'depth',
  'p1OnlyFrom',
  'subAgents',
  'leadClosesFailures',
  'commitTitles',
] as const

function fileText(given: unknown, field: string): string {
  const value = text(given, field)
  if (value.length > maxFileChars) throw new HttpError(400, `${field} is too long`)
  return value
}

function stageSettings(given: unknown): Partial<Record<StageId, StageSettingsInput>> {
  const body = record(given)
  const stages: Partial<Record<StageId, StageSettingsInput>> = {}
  for (const [id, value] of Object.entries(body)) {
    if (!isStageId(id)) throw new HttpError(400, `unknown Stage ${id}`)
    const custom = !isBuiltInStage(id)
    const stage = record(value)
    const builtInOnly = builtInOnlyFields.find((name) => custom && stage[name] !== undefined)
    if (builtInOnly !== undefined) {
      throw new HttpError(400, `${id}.${builtInOnly} can’t be set on a custom Stage`)
    }
    const flag = (name: 'enabled' | 'gate') => {
      const v = stage[name]
      if (v === undefined) return undefined
      if (typeof v !== 'boolean') throw new HttpError(400, `${id}.${name} must be true or false`)
      return v
    }
    const maxBack = stage.maxBack
    if (
      maxBack !== undefined &&
      (typeof maxBack !== 'number' || !Number.isInteger(maxBack) || maxBack < 0)
    ) {
      throw new HttpError(400, `${id}.maxBack must be a whole number, 0 or more`)
    }
    const effort = stage.effort
    if (
      effort !== undefined &&
      (id === 'backlog' || id === 'done' || (effort !== null && !efforts.some((e) => e === effort)))
    ) {
      throw new HttpError(400, `${id}.effort must be an effort level or null on a working Stage`)
    }
    const depth = stage.depth
    if (depth !== undefined && (!hasClarifyRounds(id) || !clarifyDepths.some((d) => d === depth))) {
      throw new HttpError(400, `${id}.depth must be one of ${clarifyDepths.join(', ')}, on Clarify`)
    }
    const enabled = flag('enabled')
    const gate = flag('gate')
    const p1OnlyFrom = stage.p1OnlyFrom
    if (
      p1OnlyFrom !== undefined &&
      (!validates(id) ||
        (p1OnlyFrom !== false &&
          (typeof p1OnlyFrom !== 'number' || !Number.isInteger(p1OnlyFrom) || p1OnlyFrom < 2)))
    ) {
      throw new HttpError(
        400,
        `${id}.p1OnlyFrom must be a round number, 2 or more, or false, on Validate`,
      )
    }
    const subAgents = stage.subAgents
    if (subAgents !== undefined && (!validates(id) || typeof subAgents !== 'boolean')) {
      throw new HttpError(400, `${id}.subAgents must be true or false, on Validate`)
    }
    const leadClosesFailures = stage.leadClosesFailures
    if (
      leadClosesFailures !== undefined &&
      (!handsOff(id) || typeof leadClosesFailures !== 'boolean')
    ) {
      throw new HttpError(400, `${id}.leadClosesFailures must be true or false, on Work`)
    }
    const commitTitles = stage.commitTitles
    if (commitTitles !== undefined && (!mergesHere(id) || typeof commitTitles !== 'boolean')) {
      throw new HttpError(400, `${id}.commitTitles must be true or false, on Merge`)
    }
    stages[id] = {
      ...(effort !== undefined && { effort: effort as Effort | null }),
      ...(enabled !== undefined && { enabled }),
      ...(gate !== undefined && { gate }),
      ...(typeof maxBack === 'number' && { maxBack }),
      ...(depth !== undefined && { depth: depth as ClarifyDepth }),
      ...(p1OnlyFrom !== undefined && { p1OnlyFrom: p1OnlyFrom as number | false }),
      ...(subAgents !== undefined && { subAgents: subAgents as boolean }),
      ...(leadClosesFailures !== undefined && {
        leadClosesFailures: leadClosesFailures as boolean,
      }),
      ...(commitTitles !== undefined && { commitTitles: commitTitles as boolean }),
    }
  }
  return stages
}

function keepStageFiles(given: unknown): AgentStageId[] {
  return list(given, 'keepStageFiles').map((id) => {
    const found = stageFileId(`stages/${String(id)}.md`)
    if (found === undefined) throw new HttpError(400, `unknown Stage ${String(id)}`)
    return found
  })
}

function stageFiles(given: unknown): Partial<Record<AgentStageId, string | null>> {
  const files: Partial<Record<AgentStageId, string | null>> = {}
  for (const [id, value] of Object.entries(record(given))) {
    const found = stageFileId(`stages/${id}.md`)
    if (found === undefined) throw new HttpError(400, `unknown Stage ${id}`)
    files[found] = value === null ? null : fileText(value, `${id} Stage file`)
  }
  return files
}

function checkInput(given: unknown): CheckInput {
  const body = record(given)
  const was = body.was
  if (was !== undefined && (typeof was !== 'number' || !Number.isInteger(was) || was < 0)) {
    throw new HttpError(400, 'a Check’s was must be a list position')
  }
  const repo = optionalText(body.repo, 'Check repo')
  const timeout = optionalText(body.timeout, 'Check timeout')
  return {
    ...(typeof was === 'number' && { was }),
    name: text(body.name, 'Check name'),
    run: text(body.run, 'Check command'),
    ...(repo !== undefined && { repo }),
    ...(timeout !== undefined && { timeout }),
  }
}

function cleanupSettings(given: unknown): CleanupSettingsInput {
  const body = record(given)
  if (typeof body.enabled !== 'boolean')
    throw new HttpError(400, 'cleanup.enabled must be true or false')
  return { enabled: body.enabled, steps: list(body.steps, 'cleanup.steps').map(cleanupStep) }
}

function cleanupStep(given: unknown): CleanupStepInput {
  const body = record(given)
  const name = text(body.name, 'Cleanup step name').trim()
  const instruction = optionalText(body.instruction, 'Cleanup step instruction')
  const command = optionalText(body.command, 'Cleanup step command')
  const timeout = optionalText(body.timeout, 'Cleanup step timeout')?.trim() || undefined
  if ((instruction === undefined) === (command === undefined)) {
    throw new HttpError(400, 'a Cleanup step needs an instruction or a command, not both')
  }
  if (instruction !== undefined) {
    if (timeout !== undefined) {
      throw new HttpError(400, 'only a Cleanup step with a command takes a timeout')
    }
    return { name, instruction: fileText(instruction, 'Cleanup step instruction').trim() }
  }
  return {
    name,
    command: fileText(command, 'Cleanup step command').trim(),
    ...(timeout !== undefined && { timeout }),
  }
}

function roleChoice(given: unknown, role: string): AgentChoiceInput | null {
  if (given === null) return null
  const set = Object.entries(bodyObject(given, role)).filter(
    ([, value]) => value !== '' && value !== null,
  )
  return agentChoice(Object.fromEntries(set), role)
}

function record(given: unknown): Record<string, unknown> {
  return typeof given === 'object' && given !== null && !Array.isArray(given)
    ? (given as Record<string, unknown>)
    : {}
}

function list(given: unknown, field: string): unknown[] {
  if (!Array.isArray(given)) throw new HttpError(400, `${field} must be a list`)
  if (given.length > maxListItems) throw new HttpError(400, `${field} is too long`)
  return given
}

function command(given: unknown, field: string): WorktreeCommandInput | undefined {
  if (given === undefined || given === null) return undefined
  const body = record(given)
  const timeout = optionalText(body.timeout, `${field}.timeout`)
  return { run: text(body.run, `${field}.run`), ...(timeout !== undefined && { timeout }) }
}

export function parseFactorySettingsChanges(given: unknown): FactorySettingsChanges {
  const repos = list(record(given).repos, 'repos')
  if (repos.length === 0 || repos.length > maxSettingsRepos) {
    throw new HttpError(400, `a Factory has 1 to ${maxSettingsRepos} repos`)
  }
  const body = record(given)
  const changes: FactorySettingsChanges = { repos: repos.map(settingsRepo) }
  if (body.stages !== undefined) changes.stages = stageSettings(body.stages)
  if (body.stageFiles !== undefined) changes.stageFiles = stageFiles(body.stageFiles)
  if (body.keepStageFiles !== undefined) {
    changes.keepStageFiles = keepStageFiles(body.keepStageFiles)
  }
  if (body.checks !== undefined) changes.checks = list(body.checks, 'checks').map(checkInput)
  if (body.cleanup !== undefined) changes.cleanup = cleanupSettings(body.cleanup)
  if (body.agents !== undefined) {
    const given = record(body.agents)
    changes.agents = {}
    for (const role of agentRoles) {
      if (given[role] !== undefined) changes.agents[role] = roleChoice(given[role], role)
    }
  }
  if (body.permissions !== undefined) {
    const mode = permissionModes.find((m) => m === body.permissions)
    if (mode === undefined) throw new HttpError(400, 'permissions must be auto or bypass')
    changes.permissions = mode
  }
  if (body.maxWorkingRuns !== undefined) {
    const limit = body.maxWorkingRuns
    if (limit !== null && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) {
      throw new HttpError(400, 'maxWorkingRuns must be a whole number above 0, or null')
    }
    changes.maxWorkingRuns = limit
  }
  if (body.notes !== undefined) changes.notes = fileText(body.notes, 'notes')
  return changes
}

function settingsRepo(given: unknown): RepoSettingsInput {
  const body = record(given)
  const was = optionalText(body.was, 'was')
  const remote = optionalText(body.remote, 'remote')
  const baseBranch = optionalText(body.baseBranch, 'baseBranch')
  const mergeMethod = optionalText(body.mergeMethod, 'mergeMethod')
  if (mergeMethod !== undefined && !settingsMergeMethods.some((m) => m === mergeMethod)) {
    throw new HttpError(400, 'mergeMethod must be squash, merge or rebase')
  }
  const setup = command(body.setup, 'setup')
  const teardown = command(body.teardown, 'teardown')
  return {
    ...(was !== undefined && { was }),
    repo: text(body.repo, 'repo'),
    ...(remote !== undefined && { remote }),
    name: text(body.name, 'name'),
    ...(baseBranch !== undefined && { baseBranch }),
    ...(mergeMethod !== undefined && { mergeMethod: mergeMethod as SettingsMergeMethod }),
    ...(setup && { setup }),
    ...(teardown && { teardown }),
    env: list(body.env, 'env').map((v) => {
      const variable = record(v)
      return { name: text(variable.name, 'env name'), value: text(variable.value, 'env value') }
    }),
    copy: list(body.copy, 'copy').map((c) => text(c, 'copy')),
    apps: list(body.apps, 'apps').map(settingsApp),
  }
}

function settingsApp(given: unknown): AppInput {
  const body = record(given)
  const kind = appKinds.find((k) => k === body.kind)
  if (kind === undefined)
    throw new HttpError(400, 'an App kind must be web, command, ios-simulator or android-emulator')
  const was = body.was
  if (was !== undefined && (typeof was !== 'number' || !Number.isInteger(was) || was < 0)) {
    throw new HttpError(400, 'an App’s was must be a list position')
  }
  const url = optionalText(body.url, 'url')
  const device = optionalText(body.device, 'device')
  return {
    ...(typeof was === 'number' && { was }),
    name: text(body.name, 'App name'),
    kind,
    run: text(body.run, 'App run'),
    ...(url !== undefined && { url }),
    ...(device !== undefined && { device }),
  }
}

function repoSource(given: unknown): RepoSource {
  const source = (typeof given === 'object' && given !== null ? given : {}) as Record<
    string,
    unknown
  >
  if (typeof source.folder === 'string') return { folder: source.folder }
  return { remote: typeof source.remote === 'string' ? source.remote : '' }
}

function newRepo(given: unknown): NewFactoryRepo {
  const repo = (typeof given === 'object' && given !== null ? given : {}) as Record<string, unknown>
  return { source: repoSource(repo.source), name: typeof repo.name === 'string' ? repo.name : '' }
}

export function parseAutoStartBacklogRequest(value: unknown): AutoStartBacklogRequest {
  const body = record(value)
  if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false')
  return { enabled: body.enabled }
}

export function parseCreateFactoryRequest(value: unknown): CreateFactoryRequest {
  const body = value as Partial<CreateFactoryRequest> | null
  const repos = Array.isArray(body?.repos) ? body.repos.map(newRepo) : []
  return {
    name: typeof body?.name === 'string' ? body.name : '',
    key: typeof body?.key === 'string' ? body.key.trim() : '',
    repos,
  }
}

export function parseReorderFactoriesRequest(value: unknown): ReorderFactoriesRequest {
  const body = record(value)
  const ids = list(body.factoryIds, 'factoryIds').map((id) => text(id, 'a Factory id'))
  return { factoryIds: ids }
}

const groupIdPattern = /^[A-Za-z0-9-]{1,64}$/

function layoutItem(given: unknown): FactoryLayoutItem {
  const item = record(given)
  if (item.group === undefined) return { factoryId: text(item.factoryId, 'a Factory id') }
  const group = record(item.group)
  const id = text(group.id, 'a group id')
  if (!groupIdPattern.test(id)) throw new HttpError(400, 'a group id must be letters, digits or -')
  const name = text(group.name, 'a group name').trim()
  if (name.length === 0) throw new HttpError(400, 'name the group')
  if ([...name].length > factoryGroupNameMax) {
    throw new HttpError(400, `a group name is at most ${factoryGroupNameMax} characters`)
  }
  const factoryIds = list(group.factoryIds, 'factoryIds').map((f) => text(f, 'a Factory id'))
  return { group: { id, name, factoryIds } }
}

export function parseFactoryLayout(value: unknown): FactoryLayout {
  const body = record(value)
  const items = list(body.items, 'items')
  if (items.length > maxListItems) throw new HttpError(400, 'too many items')
  return { items: items.map(layoutItem) }
}

export function parseRemoveFactoryRequest(value: unknown): RemoveFactoryRequest {
  const body = record(value)
  return { key: text(body.key, 'key'), closePullRequests: body.closePullRequests !== false }
}

export function parseCheckRepoRequest(value: unknown): CheckRepoRequest {
  const body = value as Partial<CheckRepoRequest> | null
  return { source: repoSource(body?.source), primary: body?.primary === true }
}

export function parseSetLocalFolderRequest(value: unknown): SetLocalFolderRequest {
  const body = value as Partial<SetLocalFolderRequest> | null
  const folder = typeof body?.path === 'string' ? body.path : ''
  if (folder === '') throw new HttpError(400, 'path is required')
  return { path: folder }
}

export function parseMergeSettingsRequest(value: unknown): MergeSettingsRequest {
  const body = record(value)
  if (typeof body.receipt !== 'string' || !/^[a-f0-9]{32}$/.test(body.receipt)) {
    throw new HttpError(400, 'receipt must be a settings save receipt')
  }
  return { receipt: body.receipt }
}

export function parseSaveSettingsRequest(value: unknown): SaveSettingsRequest {
  const body = record(value)
  const mode: SettingsSaveMode = body.mode === 'pull-request' ? 'pull-request' : 'merge'
  if (body.mode !== 'merge' && body.mode !== 'pull-request') {
    throw new HttpError(400, 'mode must be merge or pull-request')
  }
  if (typeof body.version !== 'string') throw new HttpError(400, 'version is required')
  return {
    changes: parseFactorySettingsChanges(body.changes),
    mode,
    version: body.version,
    confirmBypass: body.confirmBypass === true,
  }
}

export function parseRenameFactoryRequest(value: unknown): RenameFactoryRequest {
  const body = record(value)
  if (typeof body.name !== 'string') throw new HttpError(400, 'name is required')
  return { name: body.name }
}

export function parseSetFactoryIconRequest(value: unknown): SetFactoryIconRequest {
  const body = record(value)
  if (body.icon === null) return { icon: null }
  return { icon: parseFactoryIcon(body.icon) }
}

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function parseFactoryIcon(value: unknown): FactoryIcon {
  const icon = record(value)
  const color = (): FactoryIconColor => {
    const found = factoryIconColors.find((known) => known === icon.color)
    if (found === undefined) throw new HttpError(400, 'icon.color is not a known colour')
    return found
  }
  if (icon.kind === 'letter') return { kind: 'letter', color: color() }
  if (icon.kind === 'symbol') {
    const name = factoryIconSymbols.find((known): known is FactoryIconSymbol => known === icon.name)
    if (name === undefined) throw new HttpError(400, 'icon.name is not a known icon')
    return { kind: 'symbol', name, color: color() }
  }
  if (icon.kind === 'emoji') {
    if (typeof icon.emoji !== 'string' || !factoryIconEmoji.includes(icon.emoji)) {
      throw new HttpError(400, 'icon.emoji is not one of the offered emoji')
    }
    return { kind: 'emoji', emoji: icon.emoji }
  }
  if (icon.kind === 'image') {
    const { dataUrl } = icon
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith(factoryIconImagePrefix)) {
      throw new HttpError(400, 'icon.dataUrl must be a PNG data URL')
    }
    const encoded = dataUrl.slice(factoryIconImagePrefix.length)
    if (encoded.length > Math.ceil(factoryIconImageMaxBytes / 3) * 4) {
      throw new HttpError(400, 'icon image is too large')
    }
    let bytes: string
    try {
      bytes = atob(encoded)
    } catch {
      throw new HttpError(400, 'icon.dataUrl is not valid base64')
    }
    if (bytes.length > factoryIconImageMaxBytes) throw new HttpError(400, 'icon image is too large')
    if (pngSignature.some((byte, index) => bytes.charCodeAt(index) !== byte)) {
      throw new HttpError(400, 'icon image must be a PNG')
    }
    return { kind: 'image', dataUrl }
  }
  throw new HttpError(400, 'icon.kind must be letter, symbol, emoji or image')
}

export function parseSetRepoFolderRequest(value: unknown): SetRepoFolderRequest {
  const body = record(value)
  if (typeof body.path !== 'string' || body.path === '') {
    throw new HttpError(400, 'path is required')
  }
  return { path: body.path }
}

export function parseStopCheckTryRequest(value: unknown): StopCheckTryRequest {
  const body = record(value)
  return { name: text(body.name, 'name') }
}

export function parseAddFactoryRequest(value: unknown): AddFactoryRequest {
  const body = value as Partial<AddFactoryRequest> | null
  const repo = typeof body?.repo === 'string' ? body.repo.trim() : ''
  const key = typeof body?.key === 'string' ? body.key.trim() : ''
  if (repo === '' || key === '') throw new HttpError(400, 'repo and key are required')
  const localFolder = typeof body?.localFolder === 'string' ? body.localFolder : undefined
  return { repo, key, ...(localFolder !== undefined && { localFolder }) }
}

export function parseLibraryChanges(given: unknown): LibraryChanges {
  const body = record(given)
  const changes: LibraryChanges = {}
  if (body.stages !== undefined) changes.stages = stageSettings(body.stages)
  if (body.stageFiles !== undefined) changes.stageFiles = stageFiles(body.stageFiles)
  if (body.keepStageFiles !== undefined) {
    changes.keepStageFiles = keepStageFiles(body.keepStageFiles)
  }
  if (body.agents !== undefined) {
    const agents = record(body.agents)
    changes.agents = {}
    for (const role of agentRoles) {
      if (agents[role] !== undefined) changes.agents[role] = roleChoice(agents[role], role)
    }
  }
  return changes
}

export function parseSaveLibraryRequest(value: unknown): SaveLibraryRequest {
  const body = record(value)
  if (typeof body.version !== 'string') throw new HttpError(400, 'version is required')
  return { changes: parseLibraryChanges(body.changes), version: body.version }
}

export function parseSetFactoryNotificationsRequest(
  value: unknown,
): SetFactoryNotificationsRequest {
  const body = record(value)
  const { inboxItems, taskMerged } = body
  if (inboxItems === undefined && taskMerged === undefined) {
    throw new HttpError(400, 'give inboxItems or taskMerged')
  }
  if (inboxItems !== undefined && typeof inboxItems !== 'boolean') {
    throw new HttpError(400, 'inboxItems must be true or false')
  }
  if (taskMerged !== undefined && typeof taskMerged !== 'boolean') {
    throw new HttpError(400, 'taskMerged must be true or false')
  }
  return {
    ...(inboxItems !== undefined && { inboxItems }),
    ...(taskMerged !== undefined && { taskMerged }),
  }
}

export function parseSetFactoryPermissionsRequest(value: unknown): SetFactoryPermissionsRequest {
  const body = record(value)
  const mode = permissionModes.find((mode) => mode === body.mode)
  if (!mode) throw new HttpError(400, 'mode must be auto or bypass')
  return {
    mode,
    ...(body.confirmBypass !== undefined && { confirmBypass: body.confirmBypass === true }),
  }
}
