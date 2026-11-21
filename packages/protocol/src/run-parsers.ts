import path from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { SendRunMessageRequest } from './chat.ts'
import { reader, type Untyped } from './parse.ts'
import {
  type AgentKind,
  agentKindList,
  agentKinds,
  type SendSubAgentRequest,
  type StartDevRunRequest,
  type StartSubAgentRequest,
} from './run.ts'
import { type Effort, efforts, isModelName } from './task.ts'
import { parseAttachmentRefs } from './task-parsers.ts'
import { RequestValidationError as HttpError } from './validation.ts'

const read = reader((message) => {
  throw new HttpError(400, message)
})

export function parseStartSubAgentRequest(body: unknown): StartSubAgentRequest {
  const input = (body ?? {}) as Partial<Record<keyof StartSubAgentRequest, unknown>>
  const prompt = typeof input.prompt === 'string' ? input.prompt : ''
  if (prompt.trim() === '') throw new HttpError(400, 'the prompt file is empty')
  const { agent, model, effort, name, ownWorktree, reviewer } = input
  if (agent !== undefined && !agentKinds.includes(agent as AgentKind)) {
    throw new HttpError(400, `agent must be ${agentKindList}`)
  }
  if (model !== undefined && !isModelName(model)) {
    throw new HttpError(400, 'model must be a model name, such as opus or gpt-5.5')
  }
  if (effort !== undefined && !efforts.includes(effort as Effort)) {
    throw new HttpError(400, `effort must be one of ${efforts.join(', ')}`)
  }
  if (name !== undefined && typeof name !== 'string') throw new HttpError(400, 'name must be text')
  if (ownWorktree !== undefined && typeof ownWorktree !== 'boolean') {
    throw new HttpError(400, 'ownWorktree must be true or false')
  }
  if (reviewer !== undefined && typeof reviewer !== 'boolean') {
    throw new HttpError(400, 'reviewer must be true or false')
  }
  return {
    prompt,
    ...(agent !== undefined && { agent: agent as AgentKind }),
    ...(model !== undefined && { model }),
    ...(effort !== undefined && { effort: effort as Effort }),
    ...(typeof name === 'string' && name.trim() !== '' && { name: oneLine(name) }),
    ...(ownWorktree === true && { ownWorktree }),
    ...(reviewer === true && { reviewer }),
  }
}

function oneLine(text: string): string {
  return stripVTControlCharacters(text).replace(/\s+/g, ' ').trim()
}

export function parseSendSubAgentRequest(value: unknown): SendSubAgentRequest {
  const body = value as Partial<SendSubAgentRequest> | null
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (text === '') throw new HttpError(400, 'text is required')
  return { text }
}

export function parseSendRunMessageRequest(value: Untyped): SendRunMessageRequest {
  const body = read.object(value ?? {}, 'message')
  const text = read.optional(body, 'text', read.string)?.trim() ?? ''
  const interrupt = read.optional(body, 'interrupt', (object, field) =>
    read.boolean(object, field, 'interrupt must be true or false'),
  )
  const attachments = parseAttachmentRefs(body.attachments)
  if (text === '' && attachments.length === 0) throw new HttpError(400, 'text is required')
  return {
    text,
    interrupt: interrupt === true,
    ...(attachments.length > 0 && { attachments }),
  }
}

export function parseStartDevRunRequest(value: unknown): StartDevRunRequest {
  const body = value as Partial<StartDevRunRequest> | null
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
  const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
  const agent = body?.agent ?? undefined
  if (prompt === '') throw new HttpError(400, 'prompt is required')
  if (!path.isAbsolute(cwd)) throw new HttpError(400, 'cwd must be an absolute path')
  if (agent !== undefined && !agentKinds.includes(agent as AgentKind))
    throw new HttpError(400, `agent must be ${agentKindList}`)
  return { prompt, cwd, ...(agent !== undefined && { agent }) }
}
