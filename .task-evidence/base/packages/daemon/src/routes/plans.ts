import {
  parseAnswerRequest,
  parsePostPlanRequest,
  parseRenamePlanRequest,
  parseStartPlanRequest,
} from '@ted/protocol'
import { jsonRoute, type Route } from './route.ts'

const ref = '([^/?]+)'
const factoryQuery = '(?:\\?factory=([^&]*))?'

const path = (pattern: string) => new RegExp(`^${pattern}$`)

export const planRoutes: Route[] = [
  {
    method: 'GET',
    path: path(`/plans${factoryQuery}`),
    handle: async ({ params: [factory = ''] }, { plans }) => [
      200,
      await plans.list(factory === '' ? undefined : decodeURIComponent(factory)),
    ],
  },
  jsonRoute(parseStartPlanRequest, {
    method: 'POST',
    path: path('/plans'),
    async handle({ body, caller }, { plans }) {
      return [201, await plans.start(body, caller)]
    },
  }),
  {
    method: 'GET',
    path: path('/plan-requests'),
    handle: async (_, { plans }) => [200, await plans.inbox()],
  },
  {
    method: 'GET',
    path: path(`/plans/${ref}`),
    handle: async ({ params: [id = ''] }, { plans }) => [200, await plans.detail(id)],
  },
  jsonRoute(parseRenamePlanRequest, {
    method: 'PATCH',
    path: path(`/plans/${ref}`),
    async handle({ body, caller, params: [id = ''] }, { plans }) {
      return [200, await plans.rename(id, body.title, caller)]
    },
  }),
  {
    method: 'POST',
    path: path(`/plans/${ref}/stop`),
    handle: async ({ caller, params: [id = ''] }, { plans }) => [200, await plans.stop(id, caller)],
  },
  {
    method: 'POST',
    path: path(`/plans/${ref}/retry`),
    handle: async ({ caller, params: [id = ''] }, { plans }) => [
      200,
      await plans.retry(id, caller),
    ],
  },
  {
    method: 'DELETE',
    path: path(`/plans/${ref}`),
    async handle({ caller, params: [id = ''] }, { plans }) {
      await plans.delete(id, caller)
      return [200, { deleted: true }]
    },
  },
  jsonRoute(parsePostPlanRequest, {
    method: 'POST',
    path: path('/plan-runs/requests'),
    runToken: true,
    async handle({ body, caller }, { plans }) {
      return [201, plans.post(caller, body)]
    },
  }),
  jsonRoute(parseAnswerRequest, {
    method: 'POST',
    path: path(`/plan-requests/${ref}/answer`),
    async handle({ body, params: [id = ''] }, { plans }) {
      return [200, await plans.answer(id, body)]
    },
  }),
]
