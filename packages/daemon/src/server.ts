import { timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { CreateTaskRequest } from '@ted/protocol'
import type { TedStore } from './store/index.ts'

export interface ServerOptions {
  version: string
  token: string
  store: TedStore
  onRequest?: () => void
}

const maxBodyBytes = 1024 * 1024

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function listen(
  options: ServerOptions,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    options.onRequest?.()
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
  { version, token, store }: ServerOptions,
): Promise<void> {
  if (!isLoopbackHost(req.headers.host)) throw new HttpError(403, 'host not allowed')
  if (req.headers.origin !== undefined) throw new HttpError(403, 'browser requests not allowed')

  const route = `${req.method} ${req.url}`
  if (route === 'GET /healthz') return sendJson(res, 200, { status: 'ok', version })

  if (!hasToken(req.headers.authorization, token))
    throw new HttpError(401, 'missing or wrong token')

  if (route === 'GET /tasks') return sendJson(res, 200, store.listTasks())
  if (route === 'POST /tasks') {
    const body = (await readJson(req)) as Partial<CreateTaskRequest> | null
    const title = typeof body?.title === 'string' ? body.title.trim() : ''
    if (title === '') throw new HttpError(400, 'title is required')
    return sendJson(res, 201, await store.createTask({ title }))
  }
  throw new HttpError(404, 'not found')
}

function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false
  const hostname = host.replace(/:\d+$/, '')
  return hostname === '127.0.0.1' || hostname === 'localhost'
}

function hasToken(authorization: string | undefined, token: string): boolean {
  const given = Buffer.from(authorization?.replace(/^Bearer /, '') ?? '')
  const expected = Buffer.from(token)
  return given.length === expected.length && timingSafeEqual(given, expected)
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
