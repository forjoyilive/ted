import { parseAppRef, parseRecordAppRequest, parseStartAppRequest } from '@ted/protocol'
import { jsonRoute, type Route } from './route.ts'

export const appRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/simulators$/,
    async handle(_, { tasks }) {
      return [200, tasks.simulators()]
    },
  },
  jsonRoute(parseAppRef, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/apps\/show$/,
    async handle({ body: request, params: [ref = ''] }, { tasks }) {
      return [200, await tasks.showApp(ref, request)]
    },
  }),
  jsonRoute(parseAppRef, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/apps\/screenshot$/,
    runToken: true,
    async handle({ body: request, params: [ref = ''], caller }, { tasks }) {
      return [200, await tasks.screenshotApp(ref, caller, request)]
    },
  }),
  jsonRoute(parseRecordAppRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/apps\/record$/,
    runToken: true,
    async handle({ body: request, params: [ref = ''], caller }, { tasks }) {
      return [200, await tasks.recordApp(ref, caller, request)]
    },
  }),
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/apps$/,
    runToken: true,
    async handle({ params: [ref = ''], caller }, { tasks }) {
      return [200, await tasks.listApps(ref, caller)]
    },
  },
  jsonRoute(parseStartAppRequest, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/apps\/start$/,
    runToken: true,
    async handle({ body: request, params: [ref = ''], caller }, { tasks }) {
      return [200, await tasks.startApp(ref, caller, request)]
    },
  }),
  jsonRoute(parseAppRef, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/apps\/stop$/,
    async handle({ body: request, params: [ref = ''] }, { tasks }) {
      return [200, await tasks.stopApp(ref, request)]
    },
  }),
  jsonRoute(parseAppRef, {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/apps\/restart$/,
    async handle({ body: request, params: [ref = ''] }, { tasks }) {
      return [200, await tasks.restartApp(ref, request)]
    },
  }),
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/apps\/([^/]+)\/([^/]+)\/log$/,
    runToken: true,
    async handle({ params: [ref = '', repo = '', name = ''], caller }, { tasks }) {
      await tasks.listApps(ref, caller)
      return [200, await tasks.appLog(ref, { repo, name })]
    },
  },
]
