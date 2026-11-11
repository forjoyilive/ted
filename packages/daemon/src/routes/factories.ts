import {
  agentStageIds,
  parseAddFactoryRequest,
  parseAutoStartBacklogRequest,
  parseCheckRepoRequest,
  parseCheckTryRequest,
  parseCreateFactoryRequest,
  parseFactorySettingsChanges,
  parseRemoveFactoryRequest,
  parseRenameFactoryRequest,
  parseReorderFactoriesRequest,
  parseSaveSettingsRequest,
  parseSetLocalFolderRequest,
  parseSetRepoFolderRequest,
  parseStopCheckTryRequest,
} from '@ted/protocol'
import { RequestError as HttpError } from '../errors.ts'
import { factoryExport } from '../export.ts'
import { addFactory } from '../factories.ts'
import { jsonRoute, type Route } from './route.ts'

export const factoryRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/factories\/([^/]+)\/export$/,
    handle: async ({ params: [id = ''] }, { store }) => [200, factoryExport(store, id)],
  },
  jsonRoute(parseAutoStartBacklogRequest, {
    method: 'PUT',
    path: /^\/factories\/([^/]+)\/auto-start-backlog$/,
    async handle({ body, params: [id = ''] }, { factories }) {
      return [200, await factories.setAutoStartBacklog(id, body.enabled)]
    },
  }),
  {
    method: 'GET',
    path: /^\/factories$/,
    handle: async (_, { factories }) => [200, await factories.list()],
  },
  jsonRoute(parseCreateFactoryRequest, {
    method: 'POST',
    path: /^\/factories$/,
    async handle({ body }, { factories }) {
      return [201, await factories.create(body)]
    },
  }),
  jsonRoute(parseReorderFactoriesRequest, {
    method: 'PUT',
    path: /^\/factories\/order$/,
    async handle({ body }, { factories }) {
      return [200, await factories.reorder(body.factoryIds)]
    },
  }),
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
  jsonRoute(parseRemoveFactoryRequest, {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/remove$/,
    async handle({ body, params: [id = ''] }, { factoryRemovals }) {
      await factoryRemovals.remove(id, body)
      return [200, {}]
    },
  }),
  {
    method: 'GET',
    path: /^\/factories\/([^/]+)\/repos\/([^/]+)\/removal$/,
    handle: async ({ params: [id = '', name = ''] }, { factoryRemovals }) => [
      200,
      factoryRemovals.repo(id, decodeURIComponent(name)),
    ],
  },
  jsonRoute(parseCheckRepoRequest, {
    method: 'POST',
    path: /^\/factories\/check-repo$/,
    async handle({ body }, { factories }) {
      return [200, await factories.checkRepo(body)]
    },
  }),
  {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/retry-clone$/,
    handle: async ({ params: [id = ''] }, { factories }) => [200, await factories.retry(id)],
  },
  jsonRoute(parseSetLocalFolderRequest, {
    method: 'PUT',
    path: /^\/factories\/([^/]+)\/local-folder$/,
    async handle({ body, params: [key = ''] }, { factories }) {
      return [200, await factories.setLocalFolder(key, body.path)]
    },
  }),
  {
    method: 'GET',
    path: /^\/factories\/([^/]+)\/settings$/,
    handle: async ({ params: [id = ''] }, { factorySettings }) => [
      200,
      await factorySettings.view(id),
    ],
  },
  jsonRoute(parseFactorySettingsChanges, {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/settings\/preview$/,
    async handle({ body, params: [id = ''] }, { factorySettings }) {
      return [200, await factorySettings.preview(id, body)]
    },
  }),
  jsonRoute(parseSaveSettingsRequest, {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/settings\/save$/,
    async handle({ body, params: [id = ''] }, { factorySettings }) {
      return [200, await factorySettings.save(id, body)]
    },
  }),
  {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/stages\/([^/]+)\/merge-inherited$/,
    async handle({ params: [id = '', stage = ''] }, { factorySettings }) {
      const found = agentStageIds.find((s) => s === stage)
      if (found === undefined) throw new HttpError(404, `unknown Stage ${stage}`)
      return [201, await factorySettings.mergeInherited(id, found)]
    },
  },
  jsonRoute(parseCheckTryRequest, {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/checks\/try$/,
    async handle({ body, params: [id = ''] }, { checkTries }) {
      return [200, await checkTries.start(id, body)]
    },
  }),
  jsonRoute(parseStopCheckTryRequest, {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/checks\/try\/stop$/,
    async handle({ body, params: [id = ''] }, { checkTries }) {
      checkTries.stop(id, body.name)
      return [200, {}]
    },
  }),
  {
    method: 'GET',
    path: /^\/factories\/([^/]+)\/checks\/try\/output\?name=([^&]*)$/,
    handle: async ({ params: [id = '', name = ''] }, { checkTries }) => [
      200,
      await checkTries.output(id, decodeURIComponent(name)),
    ],
  },
  jsonRoute(parseRenameFactoryRequest, {
    method: 'PUT',
    path: /^\/factories\/([^/]+)\/name$/,
    async handle({ body, params: [id = ''] }, { factories }) {
      return [200, await factories.rename(id, body.name)]
    },
  }),
  jsonRoute(parseSetRepoFolderRequest, {
    method: 'PUT',
    path: /^\/factories\/([^/]+)\/repos\/([^/]+)\/local-folder$/,
    async handle({ body, params: [id = '', name = ''] }, { factories }) {
      return [200, await factories.setRepoFolder(id, decodeURIComponent(name), body.path)]
    },
  }),
  {
    method: 'DELETE',
    path: /^\/factories\/([^/]+)\/repos\/([^/]+)\/local-folder$/,
    handle: async ({ params: [id = '', name = ''] }, { factories }) => [
      200,
      await factories.setRepoFolder(id, decodeURIComponent(name), undefined),
    ],
  },
  jsonRoute(parseAddFactoryRequest, {
    method: 'POST',
    path: /^\/dev\/factories$/,
    async handle({ body }, { store, reposDir, workflows, factories }) {
      const added = await addFactory({ store, reposDir, workflows }, body)
      await factories.checkLocalFolders()
      return [201, await factories.get(added.id)]
    },
  }),
]
