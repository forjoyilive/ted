import type {
  AddFactoryRequest,
  CheckRepoRequest,
  CreateFactoryRequest,
  NewFactoryRepo,
  RepoSource,
  SetLocalFolderRequest,
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
