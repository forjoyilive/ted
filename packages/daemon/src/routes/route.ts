import type http from 'node:http'
import type { Agents } from '../agents/index.ts'
import type { Attachments } from '../attachments.ts'
import type { CommandLine } from '../command-line.ts'
import type { CpuProfiler } from '../cpu-profile.ts'
import type { Data, Services } from '../data.ts'
import { RequestError as HttpError } from '../errors.ts'
import type { IdleTimer } from '../idle.ts'
import type { Linear } from '../linear/linear.ts'
import type { RunTokens } from '../run-token.ts'
import type { SlowMonitor } from '../slow-moments.ts'
import type { Caller } from '../tasks/tasks.ts'

export interface BaseOptions {
  version: string
  token: string
  appToken: string
  appNonces: Map<string, number>
  data: Data
  idle?: IdleTimer
  keepaliveMs: number
  agents: Agents
  runTokens: RunTokens
  attachments: Attachments
  linear: Linear
  reposDir: string
  appStreams: Set<http.ServerResponse>
  onShutdown: () => void
  home: string
  commandLine: CommandLine
  slow: SlowMonitor
  profiler: CpuProfiler
}

export type ServerOptions = BaseOptions & Services

export interface RequestContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  params: string[]
  caller: Caller
}

export interface Route<O = ServerOptions> {
  method: string
  path: RegExp
  runToken?: true
  fileToken?: true
  waits?: true
  handle(context: RequestContext, options: O): Promise<[number, unknown] | undefined>
}

const patterns = new WeakMap<RegExp, string>()

export function routePattern(path: RegExp): string {
  const known = patterns.get(path)
  if (known !== undefined) return known
  const source = path.source.replace(/^\^/, '').replace(/\$$/, '')
  const query = source.search(/\(\?:\\\?|\(\\\?|\\\?/)
  const pattern = (query === -1 ? source : source.slice(0, query))
    .replaceAll('\\/', '/')
    .replace(/\(\?:(\/[^()]*(?:\([^()]*\)[^()]*)*)\)\?/g, '$1')
    .replace(/\((?!\?)[a-z-]+(?:\|[a-z-]+)+\)/g, ':action')
    .replace(/\((?!\?)[^()]*\)/g, ':id')
  patterns.set(path, pattern)
  return pattern
}

export const maxBodyBytes = 1024 * 1024

export async function readOptionalJson(req: http.IncomingMessage): Promise<unknown> {
  if (req.headers['content-length'] === '0' || req.headers['content-type'] === undefined) {
    return readJson(req).catch(() => null)
  }
  return readJson(req)
}

export async function readJson(req: http.IncomingMessage): Promise<unknown> {
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

export function jsonRoute<T, O = ServerOptions>(
  parser: (value: unknown, context: RequestContext) => T,
  route: Omit<Route<O>, 'handle'> & {
    optionalBody?: true
    handle(context: RequestContext & { body: T }, options: O): ReturnType<Route<O>['handle']>
  },
): Route<O> {
  return {
    ...route,
    async handle(context, options) {
      const value = await (route.optionalBody ? readOptionalJson : readJson)(context.req)
      return route.handle({ ...context, body: parser(value, context) }, options)
    },
  }
}
