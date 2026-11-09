import type http from 'node:http'
import { type AgentKind, agentKinds, type Effort, efforts, isModelName } from '@ted/protocol'
import type { Agents } from '../agents/index.ts'
import type { Attachments } from '../attachments.ts'
import type { CommandLine } from '../command-line.ts'
import type { Data, Services } from '../data.ts'
import { RequestError as HttpError } from '../errors.ts'
import type { IdleTimer } from '../idle.ts'
import type { Linear } from '../linear/linear.ts'
import type { RunTokens } from '../run-token.ts'
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
  handle(context: RequestContext, options: O): Promise<[number, unknown] | undefined>
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

export function bodyObject(value: unknown, name = 'body'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(
      400,
      name === 'body' ? 'body must be a JSON object' : `${name} must be an object`,
    )
  }
  return value as Record<string, unknown>
}

export function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be text`)
  return value
}

export function optionalText(value: unknown, name: string): string | undefined {
  return value === undefined || value === null ? undefined : text(value, name)
}

export interface AgentChoice {
  agent?: AgentKind
  model?: string
  effort?: Effort
}

export function agentChoice(value: unknown, name?: string): AgentChoice {
  const given = bodyObject(value, name)
  const field = (key: string) => (name === undefined ? key : `${name}.${key}`)
  const set = (key: string) => (given[key] === '' || given[key] === null ? undefined : given[key])
  const agent = set('agent')
  const model = set('model')
  const effort = set('effort')
  if (agent !== undefined && !agentKinds.includes(agent as AgentKind)) {
    throw new HttpError(400, `${field('agent')} must be ${agentKinds.join(' or ')}`)
  }
  if (model !== undefined && !isModelName(model)) {
    throw new HttpError(400, `${field('model')} must be a model name, such as opus or gpt-5.5`)
  }
  if (effort !== undefined && !efforts.includes(effort as Effort)) {
    throw new HttpError(400, `${field('effort')} must be one of ${efforts.join(', ')}`)
  }
  return {
    ...(agent !== undefined && { agent: agent as AgentKind }),
    ...(typeof model === 'string' && { model }),
    ...(effort !== undefined && { effort: effort as Effort }),
  }
}
