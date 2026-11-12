import {
  parseBrowserPollRequest,
  parseBrowserReplyRequest,
  parseBrowserRequest,
} from '@ted/protocol'
import { jsonRoute, type Route } from './route.ts'

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
  jsonRoute(parseBrowserRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/browser$/,
    waits: true,
    runToken: true,
    async handle({ body, params: [ref = ''], caller }, { tasks }) {
      return [200, await tasks.browserCommand(ref, caller, body)]
    },
  }),
  jsonRoute(parseBrowserPollRequest, {
    method: 'POST',
    path: /^\/browser\/poll$/,
    waits: true,
    async handle({ body }, { tasks }) {
      return [200, await tasks.browserPoll(body.session)]
    },
  }),
  jsonRoute(parseBrowserReplyRequest, {
    method: 'POST',
    path: /^\/browser\/([^/]+)\/reply$/,
    async handle({ body: { session, ...reply }, params: [id = ''] }, { tasks }) {
      tasks.browserReply(session, id, reply)
      return [200, {}]
    },
  }),
  {
    method: 'POST',
    path: /^\/browser\/([^/]+)\/([^/]+)\/capture$/,
    async handle({ req, params: [session = '', id = ''] }, { tasks, attachments }) {
      return [201, await tasks.browserCapture(session, id, () => attachments.save(req))]
    },
  },
]
