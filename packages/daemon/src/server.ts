import { timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import {
  type AddFactoryRequest,
  type AgentKind,
  agentKinds,
  appearances,
  type CreateTaskRequest,
  type MachineSettings,
  type PostCommentRequest,
  type ReportOutcomeRequest,
  type SetActivityRequest,
  type StartDevRunRequest,
} from '@ted/protocol'
import type { Agents } from './agents/index.ts'
import { RequestError as HttpError } from './errors.ts'
import { addFactory } from './factories.ts'
import type { IdleTimer } from './idle.ts'
import type { RunTokens } from './run-token.ts'
import type { RunManager } from './runs/run-manager.ts'
import type { TedStore } from './store/index.ts'
import type { Caller, Tasks } from './tasks/tasks.ts'

export interface ServerOptions {
  version: string
  token: string
  store: TedStore
  idle?: IdleTimer
  keepaliveMs: number
  runs: RunManager
  agents: Agents
  runTokens: RunTokens
  tasks: Tasks
  reposDir: string
}

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
const maxActivityLength = 200

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
    async handle({ req }, { tasks }) {
      const body = (await readJson(req)) as Partial<CreateTaskRequest> | null
      const title = typeof body?.title === 'string' ? body.title.trim() : ''
      if (title === '') throw new HttpError(400, 'title is required')
      const factory = typeof body?.factory === 'string' ? body.factory : undefined
      return [201, await tasks.create({ title, ...(factory !== undefined && { factory }) })]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/start$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, await tasks.start(ref)],
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/comments$/,
    async handle({ params: [ref = ''] }, { store }) {
      const task = store.getTask(ref)
      if (!task) throw new HttpError(404, `no Task ${ref}`)
      return [200, store.listComments(task.id)]
    },
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/stage-entries$/,
    async handle({ params: [ref = ''] }, { store }) {
      const task = store.getTask(ref)
      if (!task) throw new HttpError(404, `no Task ${ref}`)
      return [200, store.listStageEntries(task.id)]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/comments$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      const body = (await readJson(req)) as Partial<PostCommentRequest> | null
      const text = typeof body?.body === 'string' ? body.body.trim() : ''
      if (text === '') throw new HttpError(400, 'body is required')
      return [201, tasks.comment(ref, caller, text)]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/activity$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      const body = (await readJson(req)) as Partial<SetActivityRequest> | null
      const text = typeof body?.text === 'string' ? oneLine(body.text) : ''
      if (text === '') throw new HttpError(400, 'text is required')
      if ([...text].length > maxActivityLength) {
        throw new HttpError(400, `the activity line is limited to ${maxActivityLength} characters`)
      }
      return [200, tasks.setActivity(ref, caller, text)]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/outcome$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      const body = (await readJson(req)) as Partial<ReportOutcomeRequest> | null
      if (body?.outcome !== 'advance') throw new HttpError(400, 'outcome must be advance')
      return [200, await tasks.reportOutcome(ref, caller, body.outcome)]
    },
  },
  {
    method: 'GET',
    path: /^\/factories$/,
    handle: async (_, { store }) => [
      200,
      store.listFactories().map(({ cloneUrl: _, ...factory }) => factory),
    ],
  },
  {
    method: 'GET',
    path: /^\/settings$/,
    handle: async (_, { store }) => [200, store.settings()],
  },
  {
    method: 'PATCH',
    path: /^\/settings$/,
    async handle({ req }, { store }) {
      return [200, store.updateSettings(settingsChanges(await readJson(req)))]
    },
  },
  {
    method: 'POST',
    path: /^\/dev\/factories$/,
    async handle({ req }, { store, reposDir }) {
      const body = (await readJson(req)) as Partial<AddFactoryRequest> | null
      const repo = typeof body?.repo === 'string' ? body.repo.trim() : ''
      const key = typeof body?.key === 'string' ? body.key.trim() : ''
      if (repo === '' || key === '') throw new HttpError(400, 'repo and key are required')
      return [201, await addFactory({ store, reposDir }, { repo, key })]
    },
  },
  {
    method: 'POST',
    path: /^\/dev\/runs$/,
    async handle({ req }, { runs, agents }) {
      const body = (await readJson(req)) as Partial<StartDevRunRequest> | null
      const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
      const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
      const agent = body?.agent ?? agents.defaultLead()
      if (prompt === '') throw new HttpError(400, 'prompt is required')
      if (!path.isAbsolute(cwd)) throw new HttpError(400, 'cwd must be an absolute path')
      if (!agentKinds.includes(agent as AgentKind)) {
        throw new HttpError(400, 'agent must be claude or codex')
      }
      return [201, await runs.start({ agent, prompt, cwd })]
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
    const params = match.slice(1).map(decodeParam)
    const reply = await route.handle({ req, res, params, caller }, options)
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

function settingsChanges(body: unknown): Partial<MachineSettings> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'settings must be an object')
  }
  const entries = Object.entries(body)
  if (entries.length === 0) throw new HttpError(400, 'no settings to change')
  const changes: Partial<MachineSettings> = {}
  for (const [name, value] of entries) {
    if (name !== 'appearance') throw new HttpError(400, `unknown setting ${name}`)
    const appearance = appearances.find((a) => a === value)
    if (!appearance) throw new HttpError(400, `appearance must be ${appearances.join(', ')}`)
    changes.appearance = appearance
  }
  return changes
}

function oneLine(text: string): string {
  return [...stripVTControlCharacters(text)]
    .map((c) => (isControl(c) ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
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
