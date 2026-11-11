import { type AgentKind, agentKinds } from './run.ts'
import { type Effort, efforts, isModelName } from './task.ts'

export class RequestValidationError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function bodyObject(value: unknown, name = 'body'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RequestValidationError(
      400,
      name === 'body' ? 'body must be a JSON object' : `${name} must be an object`,
    )
  }
  return value as Record<string, unknown>
}

export function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new RequestValidationError(400, `${name} must be text`)
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
  const { agent, model, effort } = given
  if (agent !== undefined && !agentKinds.includes(agent as AgentKind)) {
    throw new RequestValidationError(400, `${field('agent')} must be ${agentKinds.join(' or ')}`)
  }
  if (model !== undefined && !isModelName(model)) {
    throw new RequestValidationError(
      400,
      `${field('model')} must be a model name, such as opus or gpt-5.5`,
    )
  }
  if (effort !== undefined && !efforts.includes(effort as Effort)) {
    throw new RequestValidationError(400, `${field('effort')} must be one of ${efforts.join(', ')}`)
  }
  return {
    ...(agent !== undefined && { agent: agent as AgentKind }),
    ...(typeof model === 'string' && { model }),
    ...(effort !== undefined && { effort: effort as Effort }),
  }
}
