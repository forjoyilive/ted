import { randomUUID } from 'node:crypto'
import type { CoordinatorAction, CoordinatorOperation } from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import { agentChoice, bodyObject, type Route, readJson } from './route.ts'

const offset = (raw: string | undefined) => Number(raw ?? 0)
const context = (value: unknown) => {
  const nonce = randomUUID()
  return {
    context: `<<<TASK CONTEXT ${nonce}>>>\n${JSON.stringify(value)}\n<<<END TASK CONTEXT ${nonce}>>>`,
  }
}
const maxMessageLength = 8000
const operations: readonly string[] = ['start', 'move', 'tell', 'answer']
function action(value: unknown, kind: CoordinatorOperation): CoordinatorAction {
  const body = bodyObject(value)
  if (typeof body.operation !== 'string' || !/^[\w-]{1,100}$/.test(body.operation))
    throw new RequestError(400, 'operation must be a unique ID of up to 100 characters')
  if (typeof body.version !== 'string' || !/^[a-f0-9]{64}$/.test(body.version))
    throw new RequestError(400, 'version must come from a current Task read')
  for (const name of ['after', 'before'])
    if (body[name] !== undefined && (typeof body[name] !== 'string' || body[name] === ''))
      throw new RequestError(400, `${name} must be a Task ID`)
  const neighbours: Record<string, string> = {}
  if (body.neighbours !== undefined) {
    for (const [key, value] of Object.entries(bodyObject(body.neighbours, 'neighbours'))) {
      if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
        throw new RequestError(400, 'neighbour versions must come from current Task reads')
      neighbours[key] = value
    }
  }
  const base = { operation: body.operation, version: body.version }
  if (kind === 'start' || kind === 'move')
    return {
      ...base,
      ...(typeof body.after === 'string' && { after: body.after }),
      ...(typeof body.before === 'string' && { before: body.before }),
      neighbours,
    }
  if (body.message !== undefined && typeof body.message !== 'string')
    throw new RequestError(400, 'message must be text')
  const typed = typeof body.message === 'string' ? body.message.trim() : ''
  if (typed.length > maxMessageLength)
    throw new RequestError(400, `message is limited to ${maxMessageLength} characters`)
  const message = redactSecrets(typed)
  if (kind === 'tell') {
    if (message === '') throw new RequestError(400, 'message is required')
    return { ...base, message }
  }
  if (typeof body.request !== 'string' || body.request === '')
    throw new RequestError(400, 'request must be the question’s Comment ID')
  if (body.choice !== undefined && (typeof body.choice !== 'string' || body.choice === ''))
    throw new RequestError(400, 'choice must be one of the question’s choices')
  if (body.choice === undefined && message === '')
    throw new RequestError(400, 'pick a choice or write an answer')
  return {
    ...base,
    request: body.request,
    ...(typeof body.choice === 'string' && { choice: body.choice }),
    ...(message !== '' && { message }),
  }
}
export const coordinatorRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/factories\/([^/]+)\/coordinator$/,
    handle: async ({ params: [id = ''] }, { coordinators }) => [200, coordinators.get(id)],
  },
  {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/coordinator\/messages$/,
    async handle({ params: [id = ''], req }, { coordinators }) {
      const body = bodyObject(await readJson(req))
      if (typeof body.text !== 'string') throw new RequestError(400, 'text is required')
      return [201, await coordinators.message(id, { text: body.text, ...agentChoice(body) })]
    },
  },
  {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/coordinator\/stop$/,
    handle: async ({ params: [id = ''] }, { coordinators }) => [200, await coordinators.stop(id)],
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
  {
    method: 'POST',
    path: /^\/coordinator\/tasks\/([^/]+)\/(start|move|tell|answer)$/,
    runToken: true,
    async handle({ caller, req, params: [ref = '', kind = ''] }, { coordinators }) {
      if (!operations.includes(kind)) throw new RequestError(400, 'unknown action')
      const operation = kind as CoordinatorOperation
      return [
        200,
        await coordinators.act(caller, ref, operation, action(await readJson(req), operation)),
      ]
    },
  },
]
