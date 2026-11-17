import { parseChatAgentId } from './chat-agent.ts'
import type {
  PostPlanRequest,
  RenamePlanRequest,
  ResumePlanRequest,
  StartPlanRequest,
} from './plan.ts'
import { parseProposalInput, parseRoundInput } from './task-parsers.ts'
import { agentChoice, bodyObject, RequestValidationError as HttpError } from './validation.ts'

export function parseStartPlanRequest(value: unknown): StartPlanRequest {
  const body = bodyObject(value)
  const { factory, message, from } = body
  const agentId = parseChatAgentId(body.agentId)
  if (typeof factory !== 'string' || factory.trim() === '') {
    throw new HttpError(400, 'name the Factory')
  }
  if (typeof message !== 'string') throw new HttpError(400, 'message must be text')
  if (from !== undefined && (typeof from !== 'string' || from === '')) {
    throw new HttpError(400, 'from must be a planning chat ID')
  }
  return {
    factory,
    message,
    ...(typeof from === 'string' && { from }),
    ...agentChoice(body),
    ...(agentId !== undefined && { agentId }),
  }
}

export function parseRenamePlanRequest(value: unknown): RenamePlanRequest {
  const { title } = bodyObject(value)
  if (typeof title !== 'string') throw new HttpError(400, 'title must be text')
  return { title }
}

export function parseResumePlanRequest(value: unknown): ResumePlanRequest {
  const { message } = bodyObject(value)
  if (message !== undefined && typeof message !== 'string') {
    throw new HttpError(400, 'message must be text')
  }
  return typeof message === 'string' ? { message } : {}
}

export function parsePostPlanRequest(value: unknown): PostPlanRequest {
  const body = bodyObject(value)
  const round = body.round === undefined ? undefined : parseRoundInput(body.round)
  const proposal = body.proposal === undefined ? undefined : parseProposalInput(body.proposal)
  const { supersedes } = body
  if (supersedes !== undefined && typeof supersedes !== 'string') {
    throw new HttpError(400, 'supersedes must be a request ID')
  }
  return {
    ...(round && { round }),
    ...(proposal && { proposal }),
    ...(typeof supersedes === 'string' && { supersedes }),
  }
}
