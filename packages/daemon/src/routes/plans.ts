import {
  archivedTaskDayLimits,
  parseAnswerRequest,
  parsePostPlanRequest,
  parseRenamePlanRequest,
  parseResumePlanRequest,
  parseStartPlanRequest,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { messageWithFiles } from '../runs/message-files.ts'
import { jsonRoute, type Route } from './route.ts'

const ref = '([^/?]+)'
const factoryQuery = '(?:\\?factory=([^&]*))?'

const path = (pattern: string) => new RegExp(`^${pattern}$`)

export const planRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/chat-archive-expiry(?:\?.*)?$/,
    handle: async ({ req }, { chatArchiveCleanup }) => {
      const days = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('days'))
      const { min, max } = archivedTaskDayLimits
      if (!Number.isInteger(days) || days < min || days > max) {
        throw new RequestError(400, `days must be a whole number from ${min} to ${max}`)
      }
      return [200, chatArchiveCleanup.preview(days)]
    },
  },
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
  jsonRoute(parseResumePlanRequest, {
    method: 'POST',
    path: path(`/plans/${ref}/resume`),
    async handle({ body, caller, params: [id = ''] }, { plans, attachments }) {
      const message = await messageWithFiles(body.message ?? '', body.attachments, attachments)
      return [200, await plans.resume(id, caller, message)]
    },
  }),
  {
    method: 'POST',
    path: path(`/plans/${ref}/archive`),
    handle: async ({ caller, params: [id = ''] }, { plans }) => [
      200,
      await plans.archive(id, caller),
    ],
  },
  {
    method: 'POST',
    path: path(`/plans/${ref}/unarchive`),
    handle: async ({ caller, params: [id = ''] }, { plans }) => [
      200,
      await plans.unarchive(id, caller),
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
