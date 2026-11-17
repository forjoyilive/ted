import {
  parseApproveExecution,
  parseExecutionEndpoint,
  parseExecutionIdRequest,
} from '@ted/protocol'
import { jsonRoute, type Route } from './route.ts'

export const executionRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/execution\/machines$/,
    handle: async (_, { execution }) => [200, await execution.list()],
  },
  jsonRoute(parseExecutionEndpoint, {
    method: 'POST',
    path: /^\/execution\/configure$/,
    async handle({ body }, { execution }) {
      execution.refuseWhenOff()
      await execution.configure(body)
      return [200, await execution.list()]
    },
  }),
  {
    method: 'POST',
    path: /^\/execution\/cancel-enrollment$/,
    async handle(_, { execution }) {
      execution.refuseWhenOff()
      await execution.cancelEnrollment()
      return [200, {}]
    },
  },
  {
    method: 'POST',
    path: /^\/execution\/enrollment$/,
    async handle(_, { execution }) {
      execution.refuseWhenOff()
      return [200, await execution.createEnrollment()]
    },
  },
  jsonRoute(parseApproveExecution, {
    method: 'POST',
    path: /^\/execution\/approve$/,
    async handle({ body }, { execution }) {
      execution.refuseWhenOff()
      return [200, await execution.approve(body)]
    },
  }),
  jsonRoute(parseExecutionIdRequest, {
    method: 'POST',
    path: /^\/execution\/reject$/,
    async handle({ body }, { execution }) {
      execution.refuseWhenOff()
      execution.reject(body.id)
      return [200, {}]
    },
  }),
  jsonRoute(parseExecutionIdRequest, {
    method: 'POST',
    path: /^\/execution\/revoke$/,
    async handle({ body }, { execution }) {
      execution.refuseWhenOff()
      await execution.revoke(body.id)
      return [200, {}]
    },
  }),
]
