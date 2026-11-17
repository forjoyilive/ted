import { timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { performance } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ProfileRequest, RestoreBackupRequest, ShutdownRequest } from '@ted/protocol'
import {
  type AppAuth,
  bodyHash,
  bodyHashHeader,
  type CallerInfo,
  type DaemonEvent,
  daemonProof,
  equalHex,
  parseAppAuth,
  parseProfileRequest,
  parseRestoreBackupRequest,
  parseShutdownRequest,
  RequestValidationError,
  requestMac,
  responseMac,
  responseMacHeader,
  testReporterPrefix,
} from '@ted/protocol'
import { maxAttachmentBytes } from './attachments.ts'
import type { Data } from './data.ts'
import { cantSaveMessage, isDiskFullError } from './disk.ts'
import { RequestError as HttpError } from './errors.ts'
import { redactSecrets } from './redact.ts'
import { appRoutes } from './routes/apps.ts'
import { automationRoutes } from './routes/automations.ts'
import { browserRoutes } from './routes/browser.ts'
import { coordinatorRoutes } from './routes/coordinators.ts'
import { executionRoutes } from './routes/execution.ts'
import { factoryRoutes } from './routes/factories.ts'
import { integrationRoutes } from './routes/integrations.ts'
import { libraryRoutes } from './routes/library.ts'
import { machineRoutes } from './routes/machine.ts'
import { messageDraftRoutes } from './routes/message-drafts.ts'
import { peerRoutes } from './routes/peers.ts'
import { planRoutes } from './routes/plans.ts'
import {
  type BaseOptions,
  jsonRoute,
  maxBodyBytes,
  type RequestContext,
  type Route,
  routePattern,
} from './routes/route.ts'
import { runRoutes } from './routes/runs.ts'
import { searchRoutes } from './routes/search.ts'
import { shellRoutes } from './routes/shells.ts'
import { taskRoutes } from './routes/tasks.ts'
import { testInvocationRoutes } from './routes/test-invocations.ts'
import type { Caller } from './tasks/tasks.ts'

export type { BaseOptions, ServerOptions } from './routes/route.ts'

const dataRoutes: Route<BaseOptions>[] = [
  {
    method: 'GET',
    path: /^\/events(\?app=1)?$/,
    waits: true,
    async handle({ req, res, params: [app] }, options) {
      streamEvents(req, res, options, app === '?app=1')
      return undefined
    },
  },
  {
    method: 'GET',
    path: /^\/caller$/,
    async handle({ req, caller }, { appToken }) {
      const nonce = parseAppAuth(req.headers.authorization)?.nonce
      const info: CallerInfo = {
        kind: caller.kind,
        ...(caller.kind === 'app' &&
          nonce !== undefined && {
            proof: daemonProof(appToken, nonce, req.socket.localPort ?? 0),
          }),
      }
      return [200, info]
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
  jsonRoute<RestoreBackupRequest, BaseOptions>(parseRestoreBackupRequest, {
    method: 'POST',
    path: /^\/backups\/restore$/,
    fileToken: true,
    async handle({ body }, { data }) {
      return [200, await data.restore(body)]
    },
  }),
  jsonRoute<ShutdownRequest, BaseOptions>(parseShutdownRequest, {
    optionalBody: true,
    method: 'POST',
    path: /^\/shutdown$/,
    fileToken: true,
    async handle({ body: { keepRuns }, res, caller }, { data, onShutdown }) {
      if (caller.kind === 'file' && !keepRuns) {
        throw new HttpError(403, 'only the TED app can do this')
      }
      await settled(data)
      if (!keepRuns && data.status().state === 'ready') {
        const services = await data.services()
        services.tasks.stoppingForQuit()
        await services.runs.stopAll()
      }
      if (res.destroyed) setImmediate(onShutdown)
      else res.once('close', () => setImmediate(onShutdown))
      return [200, {}]
    },
  }),
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
    method: 'GET',
    path: /^\/diagnostics\/slow$/,
    handle: async (_, { slow }) => [200, slow.read()],
  },
  jsonRoute<ProfileRequest, BaseOptions>(parseProfileRequest, {
    optionalBody: true,
    method: 'POST',
    path: /^\/diagnostics\/profile$/,
    waits: true,
    async handle({ body }, { profiler }) {
      return [201, await profiler.record(body.seconds)]
    },
  }),
  {
    method: 'POST',
    path: /^\/app\/open$/,
    fileToken: true,
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
  ...testInvocationRoutes,
  ...peerRoutes,
  ...shellRoutes,
  ...appRoutes,
  ...browserRoutes,
  ...factoryRoutes,
  ...machineRoutes,
  ...executionRoutes,
  ...libraryRoutes,
  ...integrationRoutes,
  ...runRoutes,
  ...automationRoutes,
  ...planRoutes,
  ...coordinatorRoutes,
  ...searchRoutes,
  ...messageDraftRoutes,
]

const drainTimeoutMs = 10_000

interface Timing {
  route?: string
  started?: number
  handled?: number
}

export async function listen(options: BaseOptions): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const release = options.idle?.attend()
    if (release) res.on('close', release)
    const timing: Timing = {}
    handle(req, res, options, timing)
      .catch(async (error: unknown) => {
        await drain(req)
        if (error instanceof HttpError || error instanceof RequestValidationError)
          return sendJson(res, error.status, { error: error.message })
        if (isDiskFullError(error)) return sendJson(res, 507, { error: cantSaveMessage })
        console.error(
          redactSecrets(error instanceof Error ? (error.stack ?? error.message) : String(error)),
        )
        sendJson(res, 500, { error: 'internal error' })
      })
      .finally(() => {
        const { route, started } = timing
        if (route === undefined || started === undefined) return
        const now = performance.now()
        options.slow.request({
          method: req.method ?? '',
          route,
          status: res.statusCode,
          handlerMs: (timing.handled ?? now) - started,
          totalMs: now - started,
        })
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
  timing: Timing,
): Promise<void> {
  if (!isLoopbackHost(req.headers.host)) throw new HttpError(403, 'host not allowed')
  if (req.headers.origin !== undefined) throw new HttpError(403, 'browser requests not allowed')

  const url = req.url ?? '/'
  if (req.method === 'GET' && url === '/healthz') {
    return sendJson(res, 200, { status: 'ok', version: options.version })
  }

  const signed = parseAppAuth(req.headers.authorization)
  const caller = signed
    ? signedByApp(signed, req, url, options)
    : identify(req.headers.authorization, options)
  if (!caller) throw new HttpError(401, 'missing or wrong token')
  if (signed) signedResponses.set(res, { key: options.appToken, nonce: signed.nonce })
  const request = signed ? replay(req, await readSignedBody(req, url)) : req

  if (caller.kind === 'run' && caller.runId.startsWith(testReporterPrefix)) {
    const id = caller.runId.slice(testReporterPrefix.length).split(':')[0]
    if (req.method !== 'POST' || url !== `/test-invocations/${id}/reports`)
      throw new HttpError(403, 'test reporters may only report their own invocation')
  } else if (caller.kind === 'run') {
    const services = await options.data.services()
    if (!services.store.getRun(caller.runId)) throw new HttpError(403, 'This Run no longer exists')
    if (services.store.sideChats.forRun(caller.runId))
      throw new HttpError(403, 'Side chats have no Task or tool authority')
    if (services.store.coordinators.forRun(caller.runId)) {
      const ownBoundary = req.method === 'POST' && url === `/runs/${caller.runId}/boundary`
      const coordinatorTool =
        (req.method === 'GET' &&
          (url === '/coordinator/agents' ||
            /^\/coordinator\/tasks\/[^/?]+(?:\?offset=\d{1,8})?$/.test(url) ||
            /^\/coordinator\/tasks(?:\?[^#]{0,2000})?$/.test(url) ||
            /^\/chat-commands\/[a-f0-9-]{36}$/.test(url))) ||
        (req.method === 'POST' &&
          (url === '/coordinator/tasks' ||
            url === '/coordinator/requests' ||
            url === '/chat-commands' ||
            /^\/coordinator\/(archive|unarchive|delete)$/.test(url) ||
            /^\/coordinator\/tasks\/[^/]+\/(start|move|tell|answer|resume|parent|done)$/.test(url)))
      if (!coordinatorTool && !ownBoundary && !(req.method === 'GET' && url === '/caller')) {
        throw new HttpError(403, 'Coordinator Runs may only use their Factory-scoped tools')
      }
    }
  }
  const dataRoute = find(dataRoutes, req, url, caller)
  if (dataRoute) {
    begin(dataRoute.route)
    const reply = await dataRoute.route.handle(context(dataRoute.params), options)
    timing.handled = performance.now()
    if (reply) sendJson(res, ...reply)
    return
  }
  const route = find(routes, req, url, caller)
  if (!route) throw new HttpError(404, 'not found')
  const services = await options.data.services()
  if (services.disk.cantSave() && req.method !== 'GET' && !url.startsWith('/storage/')) {
    throw new HttpError(507, cantSaveMessage)
  }
  begin(route.route)
  const reply = await route.route.handle(context(route.params), { ...options, ...services })
  timing.handled = performance.now()
  if (req.method !== 'GET') await services.store.persisted()
  if (reply) sendJson(res, ...reply)

  function begin(found: { path: RegExp; waits?: true }): void {
    if (found.waits) return
    timing.route = routePattern(found.path)
    timing.started = performance.now()
  }

  function context(params: string[]): RequestContext {
    return { req: request, res, params, caller: caller as Caller }
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
    if (caller.kind === 'file' && route.method !== 'GET' && !route.fileToken) {
      throw new HttpError(403, 'only the TED app can do this')
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
  _req: http.IncomingMessage,
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
  const release = idle?.attend()
  res.on('close', () => {
    clearInterval(keepalive)
    unsubscribe()
    appStreams.delete(res)
    release?.()
  })
}

const appAuthWindowMs = 60_000

const signedResponses = new WeakMap<http.ServerResponse, { key: string; nonce: string }>()

async function readSignedBody(req: http.IncomingMessage, url: string): Promise<Buffer> {
  const limit =
    url === '/attachments' || /^\/browser\/[^/]+\/[^/]+\/capture$/.test(url)
      ? maxAttachmentBytes
      : maxBodyBytes
  if (Number(req.headers['content-length']) > limit) throw new HttpError(413, 'body too large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (req.method === 'GET') throw new HttpError(400, 'a GET request has no body')
    if (size > limit) throw new HttpError(413, 'body too large')
    chunks.push(chunk as Buffer)
  }
  const body = Buffer.concat(chunks)
  if (!equalHex(bodyHash(body), String(req.headers[bodyHashHeader]))) {
    throw new HttpError(400, 'the body doesn’t match its signature')
  }
  return body
}

function signedByApp(
  auth: AppAuth,
  req: http.IncomingMessage,
  url: string,
  { appToken, appNonces }: BaseOptions,
): Caller | undefined {
  const now = Date.now()
  if (Math.abs(now - auth.at) > appAuthWindowMs) return undefined
  const hash = req.headers[bodyHashHeader]
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return undefined
  if (!equalHex(auth.mac, requestMac(appToken, auth, req.method ?? '', url, hash))) return undefined
  for (const [nonce, at] of appNonces) {
    if (now - at > 2 * appAuthWindowMs) appNonces.delete(nonce)
  }
  if (appNonces.has(auth.nonce)) return undefined
  appNonces.set(auth.nonce, now)
  return { kind: 'app' }
}

function replay(req: http.IncomingMessage, body: Buffer): http.IncomingMessage {
  return Object.assign(Readable.from(body.length === 0 ? [] : [body]), {
    headers: req.headers,
    method: req.method,
    url: req.url,
    socket: req.socket,
  }) as unknown as http.IncomingMessage
}

function identify(authorization: string | undefined, options: BaseOptions): Caller | undefined {
  const given = authorization?.replace(/^Bearer /, '') ?? ''
  if (equalSecrets(given, options.token)) return { kind: 'file' }
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
  const text = JSON.stringify(body)
  const signed = signedResponses.get(res)
  res.writeHead(status, {
    'content-type': 'application/json',
    ...(signed && {
      [responseMacHeader]: responseMac(signed.key, signed.nonce, status, bodyHash(text)),
    }),
  })
  res.end(text)
}
