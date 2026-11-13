import { randomUUID } from 'node:crypto'
import type { CoordinatorOperation } from '@ted/protocol'
import {
  type CoordinatorAction,
  type CoordinatorCreate,
  parseCoordinatorAction,
  parseCoordinatorCreate,
  parseCoordinatorMessage,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import { jsonRoute, type Route } from './route.ts'

const offset = (raw: string | undefined) => Number(raw ?? 0)
const context = (value: unknown) => {
  const nonce = randomUUID()
  return {
    context: `<<<TASK CONTEXT ${nonce}>>>\n${JSON.stringify(value)}\n<<<END TASK CONTEXT ${nonce}>>>`,
  }
}
const operations: readonly string[] = ['start', 'move', 'tell', 'answer', 'resume', 'parent']
export const coordinatorRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/factories\/([^/]+)\/coordinator$/,
    handle: async ({ params: [id = ''] }, { coordinators }) => [200, coordinators.get(id)],
  },
  {
    method: 'GET',
    path: /^\/factories\/([^/]+)\/coordinator\/chat$/,
    handle: async ({ params: [id = ''] }, { coordinators, conversations }) => [
      200,
      coordinators.get(id) ? await conversations.coordinatorChat(id) : null,
    ],
  },
  {
    method: 'GET',
    path: /^\/coordinators$/,
    handle: async (_, { coordinators }) => [200, coordinators.statuses()],
  },
  jsonRoute(parseCoordinatorMessage, {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/coordinator\/messages$/,
    async handle({ params: [id = ''], body }, { coordinators }) {
      return [201, await coordinators.message(id, body)]
    },
  }),
  {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/coordinator\/stop$/,
    handle: async ({ params: [id = ''] }, { coordinators }) => [200, await coordinators.stop(id)],
  },
  {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/coordinator\/reset$/,
    async handle({ params: [id = ''] }, { coordinators }) {
      await coordinators.reset(id)
      return [200, null]
    },
  },
  {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/coordinator\/retry$/,
    handle: async ({ params: [id = ''] }, { coordinators }) => [200, await coordinators.retry(id)],
  },
  {
    method: 'GET',
    path: /^\/coordinator\/tasks(?:\?offset=(\d{1,8}))?$/,
    runToken: true,
    handle: async ({ caller, params: [page] }, { coordinators }) => [
      200,
      context(coordinators.list(caller, offset(page))),
    ],
  },
  {
    method: 'GET',
    path: /^\/coordinator\/tasks\/([^/?]+)(?:\?offset=(\d{1,8}))?$/,
    runToken: true,
    handle: async ({ caller, params: [ref = '', page] }, { coordinators }) => [
      200,
      context(coordinators.task(caller, ref, offset(page))),
    ],
  },
  jsonRoute(parseCoordinatorCreate, {
    method: 'POST',
    path: /^\/coordinator\/tasks$/,
    runToken: true,
    async handle({ caller, body }, { coordinators }) {
      return [201, await coordinators.create(caller, redactedCreate(body))]
    },
  }),
  jsonRoute(
    (value, { params: [, kind = ''] }) =>
      parseCoordinatorAction(value, kind as CoordinatorOperation),
    {
      method: 'POST',
      path: /^\/coordinator\/tasks\/([^/]+)\/(start|move|tell|answer|resume|parent)$/,
      runToken: true,
      async handle({ caller, body, params: [ref = '', kind = ''] }, { coordinators }) {
        if (!operations.includes(kind)) throw new RequestError(400, 'unknown action')
        return [
          200,
          await coordinators.act(caller, ref, kind as CoordinatorOperation, redactedAction(body)),
        ]
      },
    },
  ),
]

function redactedAction(action: CoordinatorAction): CoordinatorAction {
  return {
    ...action,
    ...(action.message !== undefined && { message: redactSecrets(action.message) }),
    ...(action.answers !== undefined && {
      answers: action.answers.map(({ answer, note }) => ({
        answer: redactSecrets(answer),
        ...(note !== undefined && { note: redactSecrets(note) }),
      })),
    }),
  }
}

function redactedCreate(input: CoordinatorCreate): CoordinatorCreate {
  return {
    ...input,
    title: redactSecrets(input.title),
    ...(input.description !== undefined && { description: redactSecrets(input.description) }),
  }
}
