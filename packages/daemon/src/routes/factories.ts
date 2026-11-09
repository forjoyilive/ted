import {
  type AddFactoryRequest,
  type AppInput,
  appKinds,
  type CheckRepoRequest,
  type CreateFactoryRequest,
  type FactorySettingsChanges,
  type NewFactoryRepo,
  type RepoSettingsInput,
  type RepoSource,
  type SetLocalFolderRequest,
  type SettingsMergeMethod,
  type SettingsSaveMode,
  settingsMergeMethods,
  type WorktreeCommandInput,
} from '@ted/protocol'
import { RequestError as HttpError } from '../errors.ts'
import { addFactory } from '../factories.ts'
import { type Route, readJson } from './route.ts'

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
        }),
      ]
    },
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

function record(given: unknown): Record<string, unknown> {
  return typeof given === 'object' && given !== null && !Array.isArray(given)
    ? (given as Record<string, unknown>)
    : {}
}

function text(given: unknown, field: string): string {
  if (typeof given !== 'string') throw new HttpError(400, `${field} must be text`)
  return given
}

function optionalText(given: unknown, field: string): string | undefined {
  return given === undefined || given === null ? undefined : text(given, field)
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
  return { repos: repos.map(settingsRepo) }
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
