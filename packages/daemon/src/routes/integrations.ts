import {
  agentKinds,
  parseAllowLinearTeamRequest,
  parseLinearLookupRequest,
  parseRunFixRequest,
  parseSaveLinearKeyRequest,
} from '@ted/protocol'
import { RequestError as HttpError } from '../errors.ts'
import { jsonRoute, type Route } from './route.ts'

export const integrationRoutes: Route[] = [
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
