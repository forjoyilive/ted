import type { StartPlanRequest } from '@ted/protocol'
import { RequestError as HttpError } from '../errors.ts'
import { agentChoice, bodyObject, type Route, readJson } from './route.ts'
import { answerRequest, proposalInput, roundInput } from './tasks.ts'

const ref = '([^/?]+)'
const factoryQuery = '(?:\\?factory=([^&]*))?'

const path = (pattern: string) => new RegExp(`^${pattern}$`)

function startInput(value: unknown): StartPlanRequest {
  const body = bodyObject(value)
  const { factory, message, from } = body
  if (typeof factory !== 'string' || factory.trim() === '') {
    throw new HttpError(400, 'name the Factory')
  }
  if (typeof message !== 'string') throw new HttpError(400, 'message must be text')
  if (from !== undefined && (typeof from !== 'string' || from === '')) {
    throw new HttpError(400, 'from must be a planning chat ID')
  }
  return {
    factory,
    message,
    ...(typeof from === 'string' && { from }),
    ...agentChoice(body),
  }
}

export const planRoutes: Route[] = [
  {
    method: 'GET',
    path: path(`/plans${factoryQuery}`),
    handle: async ({ params: [factory = ''] }, { plans }) => [
      200,
      await plans.list(factory === '' ? undefined : decodeURIComponent(factory)),
    ],
  },
  {
    method: 'POST',
    path: path('/plans'),
    async handle({ req, caller }, { plans }) {
      return [201, await plans.start(startInput(await readJson(req)), caller)]
    },
  },
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
  {
    method: 'PATCH',
    path: path(`/plans/${ref}`),
    async handle({ req, caller, params: [id = ''] }, { plans }) {
      const { title } = bodyObject(await readJson(req))
      if (typeof title !== 'string') throw new HttpError(400, 'title must be text')
      return [200, await plans.rename(id, title, caller)]
    },
  },
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
  {
    method: 'POST',
    path: path('/plan-runs/requests'),
    runToken: true,
    async handle({ req, caller }, { plans }) {
      const body = bodyObject(await readJson(req))
      const round = body.round === undefined ? undefined : roundInput(body.round)
      const proposal = body.proposal === undefined ? undefined : proposalInput(body.proposal)
      const { supersedes } = body
      if (supersedes !== undefined && typeof supersedes !== 'string') {
        throw new HttpError(400, 'supersedes must be a request ID')
      }
      return [
        201,
        plans.post(caller, {
          ...(round && { round }),
          ...(proposal && { proposal }),
          ...(typeof supersedes === 'string' && { supersedes }),
        }),
      ]
    },
  },
  {
    method: 'POST',
    path: path(`/plan-requests/${ref}/answer`),
    async handle({ req, params: [id = ''] }, { plans }) {
      return [200, await plans.answer(id, answerRequest(await readJson(req)))]
    },
  },
]
