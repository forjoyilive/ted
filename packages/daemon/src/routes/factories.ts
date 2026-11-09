import {
  type AddFactoryRequest,
  type AgentChoiceInput,
  type AgentStageId,
  type AppInput,
  agentRoles,
  agentStageIds,
  appKinds,
  type CheckInput,
  type CheckRepoRequest,
  type CheckTryRequest,
  type ClarifyDepth,
  type CreateFactoryRequest,
  clarifyDepths,
  type FactorySettingsChanges,
  type NewFactoryRepo,
  permissionModes,
  type RepoSettingsInput,
  type RepoSource,
  type SetLocalFolderRequest,
  type SettingsMergeMethod,
  type SettingsSaveMode,
  type StageId,
  type StageSettingsInput,
  settingsMergeMethods,
  type WorktreeCommandInput,
} from '@ted/protocol'
import { RequestError as HttpError } from '../errors.ts'
import { addFactory } from '../factories.ts'
import { agentChoice, bodyObject, optionalText, type Route, readJson, text } from './route.ts'

export const factoryRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/factories$/,
    handle: async (_, { factories }) => [200, await factories.list()],
  },
  {
    method: 'POST',
    path: /^\/factories$/,
    async handle({ req }, { factories }) {
      const body = (await readJson(req)) as Partial<CreateFactoryRequest> | null
      const repos = Array.isArray(body?.repos) ? body.repos.map(newRepo) : []
      return [
        201,
        await factories.create({
          name: typeof body?.name === 'string' ? body.name : '',
          key: typeof body?.key === 'string' ? body.key.trim() : '',
          repos,
          showTutorial: body?.showTutorial === true,
        }),
      ]
    },
  },
  {
    method: 'PUT',
    path: /^\/factories\/order$/,
    async handle({ req }, { factories }) {
      const body = record(await readJson(req))
      const ids = list(body.factoryIds, 'factoryIds').map((id) => text(id, 'a Factory id'))
      return [200, await factories.reorder(ids)]
    },
  },
  {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/setup-task$/,
    handle: async ({ params: [id = ''] }, { tasks }) => [201, await tasks.newSetupTask(id)],
  },
  {
    method: 'GET',
    path: /^\/factories\/([^/]+)\/removal$/,
    handle: async ({ params: [id = ''] }, { factoryRemovals }) => [
      200,
      factoryRemovals.summary(id),
    ],
  },
  {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/remove$/,
    async handle({ req, params: [id = ''] }, { factoryRemovals }) {
      const body = record(await readJson(req))
      await factoryRemovals.remove(id, {
        key: text(body.key, 'key'),
        closePullRequests: body.closePullRequests !== false,
      })
      return [200, {}]
    },
  },
  {
    method: 'GET',
    path: /^\/factories\/([^/]+)\/repos\/([^/]+)\/removal$/,
    handle: async ({ params: [id = '', name = ''] }, { factoryRemovals }) => [
      200,
      factoryRemovals.repo(id, decodeURIComponent(name)),
    ],
  },
  {
    method: 'POST',
    path: /^\/factories\/check-repo$/,
    async handle({ req }, { factories }) {
      const body = (await readJson(req)) as Partial<CheckRepoRequest> | null
      return [
        200,
        await factories.checkRepo({
          source: repoSource(body?.source),
          primary: body?.primary === true,
        }),
      ]
    },
  },
  {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/retry-clone$/,
    handle: async ({ params: [id = ''] }, { factories }) => [200, await factories.retry(id)],
  },
  {
    method: 'PUT',
    path: /^\/factories\/([^/]+)\/local-folder$/,
    async handle({ req, params: [key = ''] }, { factories }) {
      const body = (await readJson(req)) as Partial<SetLocalFolderRequest> | null
      const folder = typeof body?.path === 'string' ? body.path : ''
      if (folder === '') throw new HttpError(400, 'path is required')
      return [200, await factories.setLocalFolder(key, folder)]
    },
  },
  {
    method: 'GET',
    path: /^\/factories\/([^/]+)\/settings$/,
    handle: async ({ params: [id = ''] }, { factorySettings }) => [
      200,
      await factorySettings.view(id),
    ],
  },
  {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/settings\/preview$/,
    async handle({ req, params: [id = ''] }, { factorySettings }) {
      return [200, await factorySettings.preview(id, settingsChanges(await readJson(req)))]
    },
  },
  {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/settings\/save$/,
    async handle({ req, params: [id = ''] }, { factorySettings }) {
      const body = record(await readJson(req))
      const mode: SettingsSaveMode = body.mode === 'pull-request' ? 'pull-request' : 'merge'
      if (body.mode !== 'merge' && body.mode !== 'pull-request') {
        throw new HttpError(400, 'mode must be merge or pull-request')
      }
      if (typeof body.version !== 'string') throw new HttpError(400, 'version is required')
      return [
        200,
        await factorySettings.save(id, {
          changes: settingsChanges(body.changes),
          mode,
          version: body.version,
          confirmBypass: body.confirmBypass === true,
        }),
      ]
    },
  },
  {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/stages\/([^/]+)\/merge-inherited$/,
    async handle({ params: [id = '', stage = ''] }, { factorySettings }) {
      const found = agentStageIds.find((s) => s === stage)
      if (found === undefined) throw new HttpError(404, `unknown Stage ${stage}`)
      return [201, await factorySettings.mergeInherited(id, found)]
    },
  },
  {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/checks\/try$/,
    async handle({ req, params: [id = ''] }, { checkTries }) {
      return [200, await checkTries.start(id, tryRequest(await readJson(req)))]
    },
  },
  {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/checks\/try\/stop$/,
    async handle({ req, params: [id = ''] }, { checkTries }) {
      const body = record(await readJson(req))
      checkTries.stop(id, text(body.name, 'name'))
      return [200, {}]
    },
  },
  {
    method: 'GET',
    path: /^\/factories\/([^/]+)\/checks\/try\/output\?name=([^&]*)$/,
    handle: async ({ params: [id = '', name = ''] }, { checkTries }) => [
      200,
      await checkTries.output(id, decodeURIComponent(name)),
    ],
  },
  {
    method: 'PUT',
    path: /^\/factories\/([^/]+)\/name$/,
    async handle({ req, params: [id = ''] }, { factories }) {
      const body = record(await readJson(req))
      if (typeof body.name !== 'string') throw new HttpError(400, 'name is required')
      return [200, await factories.rename(id, body.name)]
    },
  },
  {
    method: 'PUT',
    path: /^\/factories\/([^/]+)\/repos\/([^/]+)\/local-folder$/,
    async handle({ req, params: [id = '', name = ''] }, { factories }) {
      const body = record(await readJson(req))
      if (typeof body.path !== 'string' || body.path === '') {
        throw new HttpError(400, 'path is required')
      }
      return [200, await factories.setRepoFolder(id, decodeURIComponent(name), body.path)]
    },
  },
  {
    method: 'DELETE',
    path: /^\/factories\/([^/]+)\/repos\/([^/]+)\/local-folder$/,
    handle: async ({ params: [id = '', name = ''] }, { factories }) => [
      200,
      await factories.setRepoFolder(id, decodeURIComponent(name), undefined),
    ],
  },
  {
    method: 'POST',
    path: /^\/dev\/factories$/,
    async handle({ req }, { store, reposDir, workflows, factories }) {
      const body = (await readJson(req)) as Partial<AddFactoryRequest> | null
      const repo = typeof body?.repo === 'string' ? body.repo.trim() : ''
      const key = typeof body?.key === 'string' ? body.key.trim() : ''
      if (repo === '' || key === '') throw new HttpError(400, 'repo and key are required')
      const localFolder = typeof body?.localFolder === 'string' ? body.localFolder : undefined
      const added = await addFactory(
        { store, reposDir, workflows },
        { repo, key, ...(localFolder !== undefined && { localFolder }) },
      )
      await factories.checkLocalFolders()
      return [201, await factories.get(added.id)]
    },
  },
]

const maxSettingsRepos = 10
const maxListItems = 200
const maxFileChars = 256 * 1024
const stageIds: readonly StageId[] = ['backlog', ...agentStageIds, 'done']

function tryRequest(given: unknown): CheckTryRequest {
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

function fileText(given: unknown, field: string): string {
  const value = text(given, field)
  if (value.length > maxFileChars) throw new HttpError(400, `${field} is too long`)
  return value
}

export function stageSettings(given: unknown): Partial<Record<StageId, StageSettingsInput>> {
  const body = record(given)
  const stages: Partial<Record<StageId, StageSettingsInput>> = {}
  for (const [id, value] of Object.entries(body)) {
    if (!stageIds.includes(id as StageId)) throw new HttpError(400, `unknown Stage ${id}`)
    const stage = record(value)
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
    const depth = stage.depth
    if (depth !== undefined && !clarifyDepths.some((d) => d === depth)) {
      throw new HttpError(400, `${id}.depth must be one of ${clarifyDepths.join(', ')}`)
    }
    const enabled = flag('enabled')
    const gate = flag('gate')
    stages[id as StageId] = {
      ...(enabled !== undefined && { enabled }),
      ...(gate !== undefined && { gate }),
      ...(typeof maxBack === 'number' && { maxBack }),
      ...(depth !== undefined && { depth: depth as ClarifyDepth }),
    }
  }
  return stages
}

export function keepStageFiles(given: unknown): AgentStageId[] {
  return list(given, 'keepStageFiles').map((id) => {
    const found = agentStageIds.find((s) => s === id)
    if (found === undefined) throw new HttpError(400, `unknown Stage ${String(id)}`)
    return found
  })
}

export function stageFiles(given: unknown): Partial<Record<AgentStageId, string | null>> {
  const files: Partial<Record<AgentStageId, string | null>> = {}
  for (const [id, value] of Object.entries(record(given))) {
    if (!agentStageIds.includes(id as AgentStageId)) throw new HttpError(400, `unknown Stage ${id}`)
    files[id as AgentStageId] = value === null ? null : fileText(value, `${id} Stage file`)
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

export function roleChoice(given: unknown, role: string): AgentChoiceInput | null {
  if (given === null) return null
  const set = Object.entries(bodyObject(given, role)).filter(([, value]) => value !== '' && value !== null)
  return agentChoice(Object.fromEntries(set), role)
}

export function record(given: unknown): Record<string, unknown> {
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

function settingsChanges(given: unknown): FactorySettingsChanges {
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
    throw new HttpError(400, 'an App kind must be web, command or ios-simulator')
  const was = body.was
  if (was !== undefined && (typeof was !== 'number' || !Number.isInteger(was) || was < 0)) {
    throw new HttpError(400, 'an App’s was must be a list position')
  }
  const url = optionalText(body.url, 'url')
  return {
    ...(typeof was === 'number' && { was }),
    name: text(body.name, 'App name'),
    kind,
    run: text(body.run, 'App run'),
    ...(url !== undefined && { url }),
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
