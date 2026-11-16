import { randomUUID } from 'node:crypto'
import type { CoordinatorOperation, CoordinatorRemovalKind } from '@ted/protocol'
import {
  type CoordinatorAction,
  type CoordinatorCreate,
  parseCoordinatorAction,
  parseCoordinatorConfirmationAnswer,
  parseCoordinatorCreate,
  parseCoordinatorMessage,
  parseCoordinatorRemoval,
  parseCoordinatorTaskQuery,
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
const operations: readonly string[] = [
  'start',
  'move',
  'tell',
  'answer',
  'resume',
  'parent',
  'done',
]
export const coordinatorRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/factories\/([^/]+)\/coordinator-chats$/,
    handle: async ({ params: [id = ''] }, { coordinators }) => [200, coordinators.chats(id)],
  },
  jsonRoute(parseCoordinatorMessage, {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/coordinator-chats$/,
    async handle({ params: [id = ''], body }, { coordinators }) {
      return [201, await coordinators.start(id, body)]
    },
  }),
  {
    method: 'GET',
    path: /^\/coordinators$/,
    handle: async (_, { coordinators }) => [200, coordinators.statuses()],
  },
  {
    method: 'GET',
    path: /^\/coordinator-chats\/([^/]+)$/,
    handle: async ({ params: [id = ''] }, { coordinators }) => [200, coordinators.get(id)],
  },
  {
    method: 'GET',
    path: /^\/coordinator-chats\/([^/]+)\/chat$/,
    handle: async ({ params: [id = ''] }, { coordinators, conversations }) => {
      coordinators.get(id)
      return [200, await conversations.coordinatorChat(id)]
    },
  },
  jsonRoute(parseCoordinatorMessage, {
    method: 'POST',
    path: /^\/coordinator-chats\/([^/]+)\/messages$/,
    async handle({ params: [id = ''], body }, { coordinators }) {
      return [201, await coordinators.message(id, body)]
    },
  }),
  {
    method: 'POST',
    path: /^\/coordinator-chats\/([^/]+)\/stop$/,
    handle: async ({ params: [id = ''] }, { coordinators }) => [200, await coordinators.stop(id)],
  },
  {
    method: 'POST',
    path: /^\/coordinator-chats\/([^/]+)\/retry$/,
    handle: async ({ params: [id = ''] }, { coordinators }) => [200, await coordinators.retry(id)],
  },
  {
    method: 'POST',
    path: /^\/coordinator-chats\/([^/]+)\/continue$/,
    handle: async ({ params: [id = ''] }, { coordinators }) => [
      200,
      await coordinators.continueChat(id),
    ],
  },
  {
    method: 'DELETE',
    path: /^\/coordinator-chats\/([^/]+)$/,
    async handle({ params: [id = ''] }, { coordinators }) {
      await coordinators.deleteChat(id)
      return [200, null]
    },
  },
  jsonRoute(parseCoordinatorConfirmationAnswer, {
    method: 'POST',
    path: /^\/coordinator-chats\/([^/]+)\/confirmations\/([^/]+)$/,
    async handle({ params: [id = '', confirmation = ''], body }, { coordinators }) {
      return [200, await coordinators.answerConfirmation(id, confirmation, body)]
    },
  }),
  {
    method: 'GET',
    path: /^\/coordinator\/tasks(?:\?[^#]{0,2000})?$/,
    runToken: true,
    handle: async ({ req, caller }, { coordinators }) => [
      200,
      context(
        await coordinators.list(
          caller,
          parseCoordinatorTaskQuery(new URL(req.url ?? '/', 'http://localhost').search),
        ),
      ),
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
    (value, { params: [kind = ''] }) =>
      parseCoordinatorRemoval(value, kind as CoordinatorRemovalKind),
    {
      method: 'POST',
      path: /^\/coordinator\/(archive|unarchive|delete)$/,
      runToken: true,
      async handle({ caller, body, params: [kind = ''] }, { coordinators }) {
        return [200, await coordinators.remove(caller, kind as CoordinatorRemovalKind, body)]
      },
    },
  ),
  jsonRoute(
    (value, { params: [, kind = ''] }) =>
      parseCoordinatorAction(value, kind as CoordinatorOperation),
    {
      method: 'POST',
      path: /^\/coordinator\/tasks\/([^/]+)\/(start|move|tell|answer|resume|parent|done)$/,
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
      answers: action.answers.map(({ answer, choices, note }) => ({
        answer: redactSecrets(answer),
        ...(choices !== undefined && { choices }),
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
