import { agentKinds, integrationFixes, isLinearTeamKey, type RunFixRequest } from '@ted/protocol'
import { RequestError as HttpError } from '../errors.ts'
import { type Route, readJson } from './route.ts'

export const integrationRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/agents\/health$/,
    handle: async (_, { health }) => [200, health.list()],
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
  {
    method: 'POST',
    path: /^\/integrations\/fix$/,
    async handle({ req }, { integrations }) {
      const body = (await readJson(req)) as Partial<RunFixRequest> | null
      const fix = integrationFixes.find((f) => f === body?.fix)
      if (fix === undefined) throw new HttpError(400, `fix must be ${integrationFixes.join(', ')}`)
      const host = body?.host
      if (host !== undefined && typeof host !== 'string') {
        throw new HttpError(400, 'host must be text')
      }
      return [200, await integrations.fix({ fix, ...(host !== undefined && { host }) })]
    },
  },
  {
    method: 'GET',
    path: /^\/integrations\/linear$/,
    handle: async (_, { linear }) => [200, await linear.status()],
  },
  {
    method: 'PUT',
    path: /^\/integrations\/linear\/key$/,
    async handle({ req }, { linear }) {
      const body = (await readJson(req)) as Partial<Record<'key' | 'inFile', unknown>> | null
      if (typeof body?.key !== 'string') throw new HttpError(400, 'key must be text')
      if (body.inFile !== undefined && typeof body.inFile !== 'boolean') {
        throw new HttpError(400, 'inFile must be true or false')
      }
      return [200, await linear.save({ key: body.key, inFile: body.inFile === true })]
    },
  },
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
  {
    method: 'POST',
    path: /^\/integrations\/linear\/lookup$/,
    fileToken: true,
    async handle({ req }, { linear }) {
      const body = (await readJson(req)) as Partial<Record<'url', unknown>> | null
      if (typeof body?.url !== 'string') throw new HttpError(400, 'url must be text')
      return [200, await linear.lookup(body.url)]
    },
  },
  {
    method: 'POST',
    path: /^\/integrations\/linear\/teams$/,
    async handle({ req }, { tasks }) {
      const body = (await readJson(req)) as Partial<Record<'factoryId' | 'team', unknown>> | null
      if (typeof body?.factoryId !== 'string') throw new HttpError(400, 'factoryId must be text')
      if (typeof body.team !== 'string' || !isLinearTeamKey(body.team)) {
        throw new HttpError(400, 'team must be a Linear team key like ENG')
      }
      return [200, tasks.allowLinearTeam(body.factoryId, body.team)]
    },
  },
]
