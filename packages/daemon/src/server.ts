import { timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import type { CreateTaskRequest, StartDevRunRequest } from '@ted/protocol'
import type { IdleTimer } from './idle.ts'
import type { RunTokens } from './run-token.ts'
import type { RunManager } from './runs/run-manager.ts'
import type { TedStore } from './store/index.ts'

export interface ServerOptions {
  version: string
  token: string
  store: TedStore
  idle?: IdleTimer
  keepaliveMs: number
  runs: RunManager
  runTokens: RunTokens
}

type Caller = { kind: 'daemon' } | { kind: 'run'; runId: string }

interface RequestContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  params: string[]
  caller: Caller
}

interface Route {
  method: string
  path: RegExp
  runToken?: true
  handle(context: RequestContext, options: ServerOptions): Promise<[number, unknown] | undefined>
}

const maxBodyBytes = 1024 * 1024

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const routes: Route[] = [
  {
    method: 'GET',
    path: /^\/events$/,
    async handle({ req, res }, options) {
      streamEvents(req, res, options)
      return undefined
    },
  },
  {
    method: 'GET',
    path: /^\/tasks$/,
    runToken: true,
    handle: async (_, { store }) => [200, store.listTasks()],
  },
  {
    method: 'POST',
    path: /^\/tasks$/,
    async handle({ req }, { store }) {
      const body = (await readJson(req)) as Partial<CreateTaskRequest> | null
      const title = typeof body?.title === 'string' ? body.title.trim() : ''
      if (title === '') throw new HttpError(400, 'title is required')
      return [201, await store.createTask({ title })]
    },
  },
  {
    method: 'POST',
    path: /^\/dev\/runs$/,
    async handle({ req }, { runs }) {
      const body = (await readJson(req)) as Partial<StartDevRunRequest> | null
      const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
      const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
      if (prompt === '') throw new HttpError(400, 'prompt is required')
      if (!path.isAbsolute(cwd)) throw new HttpError(400, 'cwd must be an absolute path')
      return [201, await runs.start({ prompt, cwd })]
    },
  },
  {
    method: 'GET',
    path: /^\/runs\/([^/]+)$/,
    async handle({ params: [id = ''] }, { store }) {
      const run = store.getRun(id)
      if (!run) throw new HttpError(404, 'no such Run')
      return [200, { run, conversation: store.conversation(id) }]
    },
  },
]

export async function listen(
  options: ServerOptions,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    options.idle?.reset()
    handle(req, res, options).catch((error: unknown) => {
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message })
      console.error(error)
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
  options: ServerOptions,
): Promise<void> {
  if (!isLoopbackHost(req.headers.host)) throw new HttpError(403, 'host not allowed')
  if (req.headers.origin !== undefined) throw new HttpError(403, 'browser requests not allowed')

  const url = req.url ?? '/'
  if (req.method === 'GET' && url === '/healthz') {
    return sendJson(res, 200, { status: 'ok', version: options.version })
  }

  const caller = identify(req.headers.authorization, options)
  if (!caller) throw new HttpError(401, 'missing or wrong token')

  for (const route of routes) {
    const match = req.method === route.method ? route.path.exec(url) : null
    if (!match) continue
    if (caller.kind === 'run' && !route.runToken) {
      throw new HttpError(403, 'Not allowed from inside a Run')
    }
    const reply = await route.handle({ req, res, params: match.slice(1), caller }, options)
    if (reply) sendJson(res, ...reply)
    return
  }
  throw new HttpError(404, 'not found')
}

function streamEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  { store, idle, keepaliveMs }: ServerOptions,
): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  res.write('event: ready\ndata: {}\n\n')
  const unsubscribe = store.subscribe((event) => res.write(`data: ${JSON.stringify(event)}\n\n`))
  // Node's fetch fails a response body that sends nothing for 300 seconds.
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), keepaliveMs)
  const release = idle?.hold()
  req.on('close', () => {
    clearInterval(keepalive)
    unsubscribe()
    release?.()
  })
}

function identify(authorization: string | undefined, options: ServerOptions): Caller | undefined {
  const given = authorization?.replace(/^Bearer /, '') ?? ''
  if (equalSecrets(given, options.token)) return { kind: 'daemon' }
  const runId = options.runTokens.verify(given)
  return runId === undefined ? undefined : { kind: 'run', runId }
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

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBodyBytes) throw new HttpError(413, 'body too large')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'body is not JSON')
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
