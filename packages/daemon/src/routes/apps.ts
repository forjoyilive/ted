import type { AppRef, RecordAppRequest, StartAppRequest } from '@ted/protocol'
import { RequestError as HttpError } from '../errors.ts'
import { type Route, readJson } from './route.ts'

function appRef(body: unknown): AppRef {
  const fields = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const name = typeof fields.name === 'string' ? fields.name.trim() : ''
  if (name === '') throw new HttpError(400, 'name the App')
  if (fields.repo !== undefined && typeof fields.repo !== 'string') {
    throw new HttpError(400, 'repo must be a repo name')
  }
  return {
    name,
    ...(typeof fields.repo === 'string' && fields.repo !== '' && { repo: fields.repo }),
  }
}

function startRequest(body: unknown): StartAppRequest {
  const fields = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (fields.shutDown !== undefined && typeof fields.shutDown !== 'string') {
    throw new HttpError(400, 'shutDown must name a simulator')
  }
  if (fields.reason !== undefined && typeof fields.reason !== 'string') {
    throw new HttpError(400, 'reason must be text')
  }
  const reason = typeof fields.reason === 'string' ? fields.reason.trim().slice(0, 500) : ''
  return {
    ...appRef(body),
    ...(typeof fields.shutDown === 'string' && { shutDown: fields.shutDown }),
    ...(reason !== '' && { reason }),
  }
}

function recordRequest(body: unknown): RecordAppRequest {
  const fields = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (fields.action !== 'start' && fields.action !== 'stop') {
    throw new HttpError(400, 'action must be start or stop')
  }
  return { ...appRef(body), action: fields.action }
}

export const appRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/simulators$/,
    async handle(_, { tasks }) {
      return [200, tasks.simulators()]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/apps\/show$/,
    async handle({ req, params: [ref = ''] }, { tasks }) {
      return [200, await tasks.showApp(ref, appRef(await readJson(req)))]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/apps\/screenshot$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      return [200, await tasks.screenshotApp(ref, caller, appRef(await readJson(req)))]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/apps\/record$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      return [200, await tasks.recordApp(ref, caller, recordRequest(await readJson(req)))]
    },
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/apps$/,
    runToken: true,
    async handle({ params: [ref = ''], caller }, { tasks }) {
      return [200, await tasks.listApps(ref, caller)]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/apps\/start$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      return [200, await tasks.startApp(ref, caller, startRequest(await readJson(req)))]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/apps\/stop$/,
    async handle({ req, params: [ref = ''] }, { tasks }) {
      return [200, await tasks.stopApp(ref, appRef(await readJson(req)))]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/apps\/restart$/,
    async handle({ req, params: [ref = ''] }, { tasks }) {
      return [200, await tasks.restartApp(ref, appRef(await readJson(req)))]
    },
  },
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
