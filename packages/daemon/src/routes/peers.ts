import { RequestError } from '../errors.ts'
import { bodyObject, type Route, readJson } from './route.ts'

export const peerRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/peers(?:\?offset=(\d{1,8}))?$/,
    runToken: true,
    handle: async ({ caller, params: [offset] }, { tasks }) => [
      200,
      tasks.peers.list(caller, Number(offset ?? 0)),
    ],
  },
  {
    method: 'GET',
    path: /^\/peers\/tasks\/([^/?]+)$/,
    runToken: true,
    handle: async ({ caller, params: [ref = ''] }, { tasks }) => [
      200,
      tasks.peers.show(caller, ref),
    ],
  },
  {
    method: 'GET',
    path: /^\/peers\/inbox(?:\?offset=(\d{1,8}))?$/,
    runToken: true,
    handle: async ({ caller, params: [offset] }, { tasks }) => [
      200,
      tasks.peers.inbox(caller, Number(offset ?? 0)),
    ],
  },
  {
    method: 'GET',
    path: /^\/peers\/watch\?cursor=([a-f0-9]{64})&timeout=([\d.]{1,8})$/,
    runToken: true,
    async handle({ caller, params: [cursor = '', timeout = '25'], res }, { tasks }) {
      const controller = new AbortController()
      const abort = () => controller.abort()
      res.once('close', abort)
      try {
        return [200, await tasks.peers.watch(caller, cursor, Number(timeout), controller.signal)]
      } finally {
        res.off('close', abort)
      }
    },
  },
  {
    method: 'POST',
    path: /^\/peers\/tasks\/([^/]+)\/messages$/,
    runToken: true,
    async handle({ caller, params: [ref = ''], req }, { tasks }) {
      const body = bodyObject(await readJson(req))
      if (typeof body.operation !== 'string' || typeof body.text !== 'string')
        throw new RequestError(400, 'operation and text are required')
      return [
        201,
        await tasks.peers.send(caller, ref, { operation: body.operation, text: body.text }),
      ]
    },
  },
]
