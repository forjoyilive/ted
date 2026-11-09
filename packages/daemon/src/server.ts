import { timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import type { DaemonEvent, RestoreBackupRequest } from '@ted/protocol'
import type { Data } from './data.ts'
import { cantSaveMessage, isDiskFullError } from './disk.ts'
import { RequestError as HttpError } from './errors.ts'
import { redactSecrets } from './redact.ts'
import { factoryRoutes } from './routes/factories.ts'
import { integrationRoutes } from './routes/integrations.ts'
import { machineRoutes } from './routes/machine.ts'
import { type BaseOptions, type RequestContext, type Route, readJson } from './routes/route.ts'
import { runRoutes } from './routes/runs.ts'
import { taskRoutes } from './routes/tasks.ts'
import type { Caller } from './tasks/tasks.ts'

export type { BaseOptions, ServerOptions } from './routes/route.ts'

const dataRoutes: Route<BaseOptions>[] = [
  {
    method: 'GET',
    path: /^\/events(\?app=1)?$/,
    async handle({ req, res, params: [app] }, options) {
      streamEvents(req, res, options, app === '?app=1')
      return undefined
    },
  },
  {
    method: 'GET',
    path: /^\/data-status$/,
    handle: async (_, { data }) => [200, data.status()],
  },
  {
    method: 'GET',
    path: /^\/backups$/,
    handle: async (_, { data }) => [200, await data.summary()],
  },
  {
    method: 'POST',
    path: /^\/backups\/restore$/,
    async handle({ req }, { data }) {
      const body = (await readJson(req)) as Partial<RestoreBackupRequest> | null
      const name = typeof body?.name === 'string' ? body.name : ''
      const stopRuns = body?.stopRuns === true
      return [200, await data.restore({ name, stopRuns })]
    },
  },
  {
    method: 'POST',
    path: /^\/shutdown$/,
    async handle({ res }, { data, onShutdown }) {
      await settled(data)
      if (data.status().state === 'ready') await (await data.services()).runs.stopAll()
      res.once('finish', () => setImmediate(onShutdown))
      return [200, {}]
    },
  },
  {
    method: 'GET',
    path: /^\/command-line$/,
    handle: async (_, { commandLine }) => [200, await commandLine.status()],
  },
  {
    method: 'POST',
    path: /^\/command-line\/install$/,
    handle: async (_, { commandLine }) => [200, await commandLine.install()],
  },
  {
    method: 'POST',
    path: /^\/app\/open$/,
    async handle(_, { appStreams }) {
      for (const stream of appStreams) send(stream, { type: 'open-requested' })
      return [200, { opened: appStreams.size > 0 }]
    },
  },
]

async function settled(data: Data): Promise<void> {
  const busy = () => data.status().state === 'opening' || data.status().state === 'updating'
  if (!busy()) return
  const { promise, resolve } = Promise.withResolvers<void>()
  const unsubscribe = data.subscribe(() => {
    if (!busy()) resolve()
  })
  if (!busy()) resolve()
  await promise.finally(unsubscribe)
}

const routes: Route[] = [
  ...taskRoutes,
  ...factoryRoutes,
  ...machineRoutes,
  ...integrationRoutes,
  ...runRoutes,
]

const drainTimeoutMs = 10_000

export async function listen(options: BaseOptions): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    options.idle?.reset()
    handle(req, res, options).catch(async (error: unknown) => {
      await drain(req)
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message })
      if (isDiskFullError(error)) return sendJson(res, 507, { error: cantSaveMessage })
      console.error(
        redactSecrets(error instanceof Error ? (error.stack ?? error.message) : String(error)),
      )
      sendJson(res, 500, { error: 'internal error' })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, port: (server.address() as AddressInfo).port }
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: BaseOptions,
): Promise<void> {
  if (!isLoopbackHost(req.headers.host)) throw new HttpError(403, 'host not allowed')
  if (req.headers.origin !== undefined) throw new HttpError(403, 'browser requests not allowed')

  const url = req.url ?? '/'
  if (req.method === 'GET' && url === '/healthz') {
    return sendJson(res, 200, { status: 'ok', version: options.version })
  }

  const caller = identify(req.headers.authorization, options)
  if (!caller) throw new HttpError(401, 'missing or wrong token')

  const dataRoute = find(dataRoutes, req, url, caller)
  if (dataRoute) {
    const reply = await dataRoute.route.handle(context(dataRoute.params), options)
    if (reply) sendJson(res, ...reply)
    return
  }
  const route = find(routes, req, url, caller)
  if (!route) throw new HttpError(404, 'not found')
  const services = await options.data.services()
  if (services.disk.cantSave() && req.method !== 'GET' && !url.startsWith('/storage/')) {
    throw new HttpError(507, cantSaveMessage)
  }
  const reply = await route.route.handle(context(route.params), { ...options, ...services })
  if (reply) sendJson(res, ...reply)

  function context(params: string[]): RequestContext {
    return { req, res, params, caller: caller as Caller }
  }
}

function find<O>(
  list: Route<O>[],
  req: http.IncomingMessage,
  url: string,
  caller: Caller,
): { route: Route<O>; params: string[] } | undefined {
  for (const route of list) {
    const found = req.method === route.method ? route.path.exec(url) : null
    if (!found) continue
    if (caller.kind === 'run' && !route.runToken) {
      throw new HttpError(403, 'Not allowed from inside a Run')
    }
    return {
      route,
      params: found.slice(1).map((param) => (param === undefined ? '' : decodeParam(param))),
    }
  }
  return undefined
}

function send(res: http.ServerResponse, event: DaemonEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function streamEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  { data, idle, keepaliveMs, appStreams }: BaseOptions,
  app: boolean,
): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  res.write('event: ready\ndata: {}\n\n')
  const unsubscribe = data.subscribe((event) => send(res, event))
  if (app) appStreams.add(res)
  // Node's fetch fails a response body that sends nothing for 300 seconds.
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), keepaliveMs)
  const release = idle?.hold()
  req.on('close', () => {
    clearInterval(keepalive)
    unsubscribe()
    appStreams.delete(res)
    release?.()
  })
}

function identify(authorization: string | undefined, options: BaseOptions): Caller | undefined {
  const given = authorization?.replace(/^Bearer /, '') ?? ''
  if (equalSecrets(given, options.token)) return { kind: 'daemon' }
  const runId = options.runTokens.verify(given)
  return runId === undefined ? undefined : { kind: 'run', runId }
}

function decodeParam(param: string): string {
  try {
    return decodeURIComponent(param)
  } catch {
    throw new HttpError(400, 'malformed path')
  }
}

function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false
  const hostname = host.replace(/:\d+$/, '')
  return hostname === '127.0.0.1' || hostname === 'localhost'
}

function equalSecrets(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function drain(req: http.IncomingMessage): Promise<void> {
  if (req.complete || req.destroyed) return
  req.resume()
  await Promise.race([
    once(req, 'end'),
    once(req, 'close'),
    sleep(drainTimeoutMs, undefined, { ref: false }),
  ]).catch(() => undefined)
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
