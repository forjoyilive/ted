import {
  agentKinds,
  parseAllowLinearTeamRequest,
  parseAsanaChoicesQuery,
  parseAsanaConfiguration,
  parseLinearLookupRequest,
  parseRunFixRequest,
  parseSaveLinearKeyRequest,
} from '@ted/protocol'
import { listAsanaChoices } from '../asana/intake.ts'
import { retryingRead } from '../asana/tree.ts'
import { RequestError as HttpError } from '../errors.ts'
import { jsonRoute, type RequestContext, type Route } from './route.ts'

function asanaChoices(
  path: (params: string[]) => string,
  query: Record<string, string> = {},
): Route['handle'] {
  return async ({ req, params, caller }: RequestContext, { asana }) => {
    if (caller.kind !== 'app')
      throw new HttpError(403, 'only the TED app can list Asana workspaces and projects')
    const { offset } = parseAsanaChoicesQuery(new URL(req.url ?? '/', 'http://localhost').search)
    return [200, await listAsanaChoices(retryingRead(asana.read), path(params), query, offset)]
  }
}

export const integrationRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/integrations\/asana$/,
    handle: async (_, { asana }) => [200, await asana.status()],
  },
  {
    method: 'GET',
    path: /^\/integrations\/asana\/workspaces(?:\?.*)?$/,
    handle: asanaChoices(() => '/workspaces'),
  },
  {
    method: 'GET',
    path: /^\/integrations\/asana\/workspaces\/(\d{1,32})\/projects(?:\?.*)?$/,
    handle: asanaChoices(([workspace]) => `/workspaces/${workspace}/projects`, {
      archived: 'false',
    }),
  },
  {
    method: 'GET',
    path: /^\/integrations\/asana\/projects\/(\d{1,32})\/sections(?:\?.*)?$/,
    handle: asanaChoices(([project]) => `/projects/${project}/sections`),
  },
  jsonRoute(parseAsanaConfiguration, {
    method: 'PUT',
    path: /^\/integrations\/asana\/configuration$/,
    handle: async ({ body }, { asana }) => [200, await asana.configure(body)],
  }),
  {
    method: 'POST',
    path: /^\/integrations\/asana\/connect$/,
    handle: async (_, { asana }) => [200, await asana.connect()],
  },
  {
    method: 'POST',
    path: /^\/integrations\/asana\/cancel$/,
    handle: async (_, { asana }) => [200, await asana.cancel()],
  },
  {
    method: 'POST',
    path: /^\/integrations\/asana\/test$/,
    handle: async (_, { asana }) => [200, await asana.test()],
  },
  {
    method: 'POST',
    path: /^\/integrations\/asana\/disconnect$/,
    handle: async (_, { asana }) => [200, await asana.disconnect()],
  },
  {
    method: 'DELETE',
    path: /^\/integrations\/asana\/configuration$/,
    handle: async (_, { asana }) => [200, await asana.remove()],
  },
  {
    method: 'GET',
    path: /^\/agents\/health$/,
    handle: async (_, { health }) => [200, health.list()],
  },
  {
    method: 'GET',
    path: /^\/agents\/api-cost$/,
    handle: async (_, { store }) => [200, store.apiCost(30)],
  },
  {
    method: 'POST',
    path: /^\/agents\/health\/check$/,
    handle: async (_, { health }) => [200, await health.check(agentKinds, { reloadEnv: true })],
  },
  {
    method: 'POST',
    path: /^\/agents\/([^/]+)\/fix$/,
    async handle({ params: [agent = ''] }, { health }) {
      const kind = agentKinds.find((k) => k === agent)
      if (!kind) throw new HttpError(404, 'no such agent')
      return [200, await health.fix(kind)]
    },
  },
  {
    method: 'GET',
    path: /^\/integrations$/,
    async handle(_, { integrations }) {
      return [200, integrations.current() ?? (await integrations.check())]
    },
  },
  {
    method: 'POST',
    path: /^\/integrations\/check$/,
    fileToken: true,
    handle: async (_, { integrations }) => [200, await integrations.check({ fresh: true })],
  },
  jsonRoute(parseRunFixRequest, {
    method: 'POST',
    path: /^\/integrations\/fix$/,
    async handle({ body }, { integrations }) {
      return [200, await integrations.fix(body)]
    },
  }),
  {
    method: 'GET',
    path: /^\/integrations\/linear\/intake-choices$/,
    handle: async (_, { linear }) => [200, await linear.intakeChoices()],
  },
  {
    method: 'GET',
    path: /^\/integrations\/linear$/,
    handle: async (_, { linear }) => [200, await linear.status()],
  },
  jsonRoute(parseSaveLinearKeyRequest, {
    method: 'PUT',
    path: /^\/integrations\/linear\/key$/,
    async handle({ body }, { linear }) {
      return [200, await linear.save(body)]
    },
  }),
  {
    method: 'DELETE',
    path: /^\/integrations\/linear\/key$/,
    handle: async (_, { linear }) => [200, await linear.remove()],
  },
  {
    method: 'POST',
    path: /^\/integrations\/linear\/test$/,
    handle: async (_, { linear }) => [200, await linear.test()],
  },
  jsonRoute(parseLinearLookupRequest, {
    method: 'POST',
    path: /^\/integrations\/linear\/lookup$/,
    fileToken: true,
    async handle({ body }, { linear }) {
      return [200, await linear.lookup(body.url)]
    },
  }),
  jsonRoute(parseAllowLinearTeamRequest, {
    method: 'POST',
    path: /^\/integrations\/linear\/teams$/,
    async handle({ body }, { tasks }) {
      return [200, tasks.allowLinearTeam(body.factoryId, body.team)]
    },
  }),
]
