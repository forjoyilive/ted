import { randomUUID } from 'node:crypto'
import type { CoordinatorAction } from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { agentChoice, bodyObject, type Route, readJson } from './route.ts'

const offset = (raw: string | undefined) => Number(raw ?? 0)
const context = (value: unknown) => {
  const nonce = randomUUID()
  return {
    context: `<<<TASK CONTEXT ${nonce}>>>\n${JSON.stringify(value)}\n<<<END TASK CONTEXT ${nonce}>>>`,
  }
}
function action(value: unknown): CoordinatorAction {
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
  return {
    operation: body.operation,
    version: body.version,
    ...(typeof body.after === 'string' && { after: body.after }),
    ...(typeof body.before === 'string' && { before: body.before }),
    neighbours,
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
    path: /^\/coordinator\/tasks\/([^/]+)\/(start|move)$/,
    runToken: true,
    async handle({ caller, req, params: [ref = '', kind] }, { coordinators }) {
      if (kind !== 'start' && kind !== 'move') throw new RequestError(400, 'unknown action')
      return [200, await coordinators.act(caller, ref, kind, action(await readJson(req)))]
    },
  },
]
