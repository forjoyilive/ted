import { type BrowserRequest, browserActions } from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { bodyObject, type Route, readJson, text } from './route.ts'

function shortText(value: unknown, name: string, limit: number): string {
  const result = text(value, name)
  if (result.length > limit) throw new RequestError(400, `${name} is too long`)
  return result
}

export function browserRequest(value: unknown): BrowserRequest {
  const body = bodyObject(value)
  const action = text(body.action, 'action')
  if (!browserActions.includes(action as BrowserRequest['action'])) {
    throw new RequestError(400, 'Unknown browser action')
  }
  const app = body.app === undefined ? undefined : bodyObject(body.app, 'app')
  const request: BrowserRequest = {
    action: action as BrowserRequest['action'],
    ...(app && {
      app: {
        name: shortText(app.name, 'app.name', 200),
        ...(app.repo !== undefined && { repo: shortText(app.repo, 'app.repo', 200) }),
      },
    }),
    ...(body.value !== undefined && { value: shortText(body.value, 'value', 16_000) }),
    ...(body.ref !== undefined && { ref: shortText(body.ref, 'ref', 100) }),
  }
  if (action === 'open' && !request.app) throw new RequestError(400, 'Name the web App')
  if (['click', 'fill'].includes(action) && !request.ref)
    throw new RequestError(400, 'Name an element reference from snapshot')
  if (['fill', 'press', 'navigate'].includes(action) && request.value === undefined)
    throw new RequestError(400, 'Give a value')
  return request
}

export const browserRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/browser\/apps\/([^/]+)\/([^/]+)$/,
    async handle({ params: [ref = '', repo = '', name = ''], caller }, { tasks }) {
      return [200, await tasks.browserApp(ref, caller, { repo, name })]
    },
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/browser\/captures\/([^/]+)$/,
    runToken: true,
    async handle({ params: [ref = '', hash = ''], caller }, { tasks, attachments }) {
      return [200, await attachments.read(tasks.browserCaptureAccess(ref, caller, hash))]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/browser$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      return [200, await tasks.browserCommand(ref, caller, browserRequest(await readJson(req)))]
    },
  },
  {
    method: 'POST',
    path: /^\/browser\/poll$/,
    async handle({ req }, { tasks }) {
      const body = bodyObject(await readJson(req))
      return [200, await tasks.browserPoll(shortText(body.session, 'session', 100))]
    },
  },
  {
    method: 'POST',
    path: /^\/browser\/([^/]+)\/reply$/,
    async handle({ req, params: [id = ''] }, { tasks }) {
      const body = bodyObject(await readJson(req))
      const result = body.result === undefined ? undefined : bodyObject(body.result, 'result')
      tasks.browserReply(shortText(body.session, 'session', 100), id, {
        ...(body.error !== undefined && { error: shortText(body.error, 'error', 1000) }),
        ...(result && {
          result: {
            ...(result.url !== undefined && { url: shortText(result.url, 'url', 4000) }),
            ...(result.text !== undefined && { text: shortText(result.text, 'text', 64_000) }),
          },
        }),
      })
      return [200, {}]
    },
  },
  {
    method: 'POST',
    path: /^\/browser\/([^/]+)\/([^/]+)\/capture$/,
    async handle({ req, params: [session = '', id = ''] }, { tasks, attachments }) {
      return [201, await tasks.browserCapture(session, id, () => attachments.save(req))]
    },
  },
]
