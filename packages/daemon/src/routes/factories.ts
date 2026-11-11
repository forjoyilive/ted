import {
  agentStageIds,
  parseAddFactoryRequest,
  parseAutoStartBacklogRequest,
  parseCheckRepoRequest,
  parseCheckTryRequest,
  parseCreateFactoryRequest,
  parseFactorySettingsChanges,
  parseMergeSettingsRequest,
  parseRemoveFactoryRequest,
  parseRenameFactoryRequest,
  parseReorderFactoriesRequest,
  parseSaveSettingsRequest,
  parseSetFactoryLinearIntakeRequest,
  parseSetFactoryPermissionsRequest,
  parseSetLocalFolderRequest,
  parseSetRepoFolderRequest,
  parseStopCheckTryRequest,
} from '@ted/protocol'
import { RequestError as HttpError } from '../errors.ts'
import { factoryExport } from '../export.ts'
import { addFactory } from '../factories.ts'
import { acquireFactoryPermissions, factoryPermissions } from '../permissions.ts'
import { jsonRoute, type Route } from './route.ts'

export const factoryRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/factories\/([^/]+)\/export$/,
    handle: async ({ params: [id = ''] }, { store }) => [200, factoryExport(store, id)],
  },
  jsonRoute(parseSetFactoryPermissionsRequest, {
    method: 'PUT',
    path: /^\/factories\/([^/]+)\/permissions$/,
    async handle({ body, params: [id = ''] }, { store, workflows }) {
      const factory = store.getFactory(id)
      if (!factory) throw new HttpError(404, 'no such Factory')
      const { mode } = body
      if (mode === 'bypass' && body.confirmBypass !== true) {
        throw new HttpError(409, 'Confirm Bypass on this computer in Factory settings')
      }
      const release = await acquireFactoryPermissions(store, id)
      try {
        const permissions = { ...store.settings().factoryPermissions }
        if (mode === 'auto') delete permissions[id]
        else permissions[id] = mode
        store.updateSettings({ factoryPermissions: permissions })
        await store.persisted()
        await workflows.resolve(factory, { fetch: false })
        return [200, { mode: factoryPermissions(store, id) }]
      } finally {
        release()
      }
    },
  }),
  jsonRoute(parseSetFactoryLinearIntakeRequest, {
    method: 'PUT',
    path: /^\/factories\/([^/]+)\/linear-intake$/,
    async handle({ body, params: [id = ''] }, { store, linear }) {
      if (!store.listFactories().some((factory) => factory.id === id))
        throw new HttpError(404, 'Factory not found')
      let scope = body.scope
      if (scope !== null) {
        const choices = await linear.intakeChoices()
        const targetId = scope.id
        const target = (scope.kind === 'team' ? choices.teams : choices.projects).find(
          (target) => target.id === targetId,
        )
        if (
          scope.workspaceId !== choices.workspaceId ||
          scope.workspace !== choices.workspace ||
          !target
        )
          throw new HttpError(409, 'Choose a Team or Project from the connected Linear workspace')
        scope = { ...scope, name: target.name }
      }
      if (!store.listFactories().some((factory) => factory.id === id))
        throw new HttpError(404, 'Factory not found')
      const { [id]: previous, ...scopes } = store.settings().linearIntakeScopes
      return [
        200,
        store.updateSettings({ linearIntakeScopes: { ...scopes, ...(scope && { [id]: scope }) } }),
      ]
    },
  }),
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
  jsonRoute(parseMergeSettingsRequest, {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/settings\/merge$/,
    async handle({ body, params: [id = ''] }, { factorySettings }) {
      return [200, await factorySettings.merge(id, body)]
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
