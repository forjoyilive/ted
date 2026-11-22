import {
  type AgentCommand,
  type AgentPower,
  agentPowers,
  isAgentId,
  maxAgentDraftInstructions,
  maxAgentId,
  maxAgentName,
} from './agent-files.ts'
import type { OutsideCommandAsk } from './outside-command.ts'
import { isOneOf, isString, type JsonObject, reader, type Untyped } from './parse.ts'
import type { AgentKind } from './run.ts'
import type { CommentAnswer, Proposal, ProposalInput, Round, RoundInput } from './task.ts'
import { parsePostCommentRequest, parseProposalInput, parseRoundInput } from './task-parsers.ts'
import { RequestValidationError as HttpError } from './validation.ts'
import type { LayerKind } from './workflow.ts'

export type AgentChatKind = 'coordinator' | 'plan'

export interface AgentSummary {
  id: string
  name: string
  description?: string
  source: LayerKind
  agent?: AgentKind
  model?: string
  powers: AgentPower[]
  commands?: AgentCommand[]
  outsideCommands?: AgentCommand[]
}

export interface ChatAgent extends AgentSummary {
  removed: boolean
}

export const chatRequestKinds = [
  'question',
  'round',
  'proposal',
  'agent',
  'outside-command',
] as const

export type ChatRequestKind = (typeof chatRequestKinds)[number]

export interface ChatRequest {
  id: string
  chatId: string
  runId: string
  kind: ChatRequestKind
  title?: string
  body: string
  choices?: string[]
  multiple?: true
  round?: Round
  proposal?: Proposal
  agentDraft?: AgentDraft
  outsideCommand?: OutsideCommandAsk
  answer?: CommentAnswer
  createdAt: string
}

export interface AgentDraftFields {
  name: string
  instructions: string
  powers: AgentPower[]
}

export interface AgentDraftInput extends AgentDraftFields {
  id: string
  change?: true
  summary?: string
}

export interface AgentDraftCurrent extends AgentDraftFields {
  source: LayerKind
  hash: string
}

export interface AgentDraft extends AgentDraftFields {
  id: string
  current?: AgentDraftCurrent
  place?: AgentDraftPlace
}

export const agentDraftPlaces = ['library', 'factory'] as const

export type AgentDraftPlace = (typeof agentDraftPlaces)[number]

export type AgentDraftAnswer =
  | ({ action: 'create'; where: AgentDraftPlace } & AgentDraftFields)
  | { action: 'dismiss' }

export const maxAgentDraftSummary = 2000

export interface ChatQuestionInput {
  text: string
  choices?: string[]
  multiple?: true
}

export interface PostChatRequest {
  question?: ChatQuestionInput
  round?: RoundInput
  proposal?: ProposalInput
  agent?: AgentDraftInput
  supersedes?: string
}

export const maxChatQuestionLength = 8000

const read = reader((message) => {
  throw new HttpError(400, message)
})

export function parseChatQuestion(value: Untyped): ChatQuestionInput {
  const body = read.object(value, 'question')
  const text = read.string(body, 'text', 'question.text must be text').trim()
  if (text === '' || text.length > maxChatQuestionLength)
    throw new HttpError(400, `a question has 1–${maxChatQuestionLength} characters`)
  const checked = parsePostCommentRequest({
    body: text,
    ...(body.choices !== undefined && { choices: body.choices }),
    ...(body.multiple !== undefined && { multiple: body.multiple }),
  })
  return {
    text,
    ...(checked.choices && { choices: checked.choices }),
    ...(checked.multiple && { multiple: true as const }),
  }
}

export function parsePostChatRequest(value: Untyped): PostChatRequest {
  const body = read.object(value, 'body', 'body must be a JSON object')
  const question = read.optional(body, 'question', (object, field) =>
    parseChatQuestion(object[field]),
  )
  const round = read.optional(body, 'round', (object, field) => parseRoundInput(object[field]))
  const proposal = read.optional(body, 'proposal', (object, field) =>
    parseProposalInput(object[field]),
  )
  const agent = read.optional(body, 'agent', (object, field) => parseAgentDraftInput(object[field]))
  if ([question, round, proposal, agent].filter((part) => part !== undefined).length !== 1)
    throw new HttpError(400, 'send one of question, round, proposal or agent')
  const supersedes = read.optional(body, 'supersedes', (object, field) =>
    read.string(object, field, 'supersedes must be a request’s ID'),
  )
  if (supersedes === '') throw new HttpError(400, 'supersedes must be a request’s ID')
  return {
    ...(question && { question }),
    ...(round && { round }),
    ...(proposal && { proposal }),
    ...(agent && { agent }),
    ...(supersedes !== undefined && { supersedes }),
  }
}

function parseDraftFields(body: JsonObject, where: string): AgentDraftFields {
  const name = read.string(body, 'name', `${where}.name must be text`).trim()
  if (name === '' || name.length > maxAgentName)
    throw new HttpError(400, `${where}.name has 1–${maxAgentName} characters`)
  const instructions = read.string(body, 'instructions', `${where}.instructions must be text`)
  if (instructions.trim() === '' || instructions.length > maxAgentDraftInstructions)
    throw new HttpError(
      400,
      `${where}.instructions has 1–${maxAgentDraftInstructions.toLocaleString('en-US')} characters`,
    )
  const listed = read.list(body, 'powers', `${where}.powers must be a list of powers`)
  const unknown = listed.find((power) => !isOneOf(power, agentPowers))
  if (unknown !== undefined)
    throw new HttpError(
      400,
      `${JSON.stringify(unknown)} isn’t a power; the powers are ${agentPowers.join(', ')}`,
    )
  return {
    name,
    instructions,
    powers: agentPowers.filter((power) => listed.includes(power)),
  }
}

export function parseAgentDraftInput(value: Untyped): AgentDraftInput {
  const body = read.object(value, 'agent')
  const id = read.string(body, 'id', 'agent.id must be text')
  if (!isAgentId(id))
    throw new HttpError(
      400,
      `agent.id uses lowercase letters, digits and hyphens, up to ${maxAgentId} characters`,
    )
  const change = read.optional(body, 'change', (object, field) =>
    read.boolean(object, field, 'agent.change must be true or false'),
  )
  const summary = read.optional(body, 'summary', (object, field) =>
    read.string(object, field, 'agent.summary must be text').trim(),
  )
  if (summary !== undefined && summary.length > maxAgentDraftSummary)
    throw new HttpError(400, `agent.summary has at most ${maxAgentDraftSummary} characters`)
  return {
    id,
    ...parseDraftFields(body, 'agent'),
    ...(change === true && { change: true as const }),
    ...(summary !== undefined && summary !== '' && { summary }),
  }
}

export function parseAgentDraftAnswer(value: Untyped): AgentDraftAnswer {
  const body = read.object(value, 'body', 'body must be a JSON object')
  const action = read.oneOf(body, 'action', ['create', 'dismiss'], 'action is create or dismiss')
  if (action === 'dismiss') return { action }
  return {
    action,
    where: read.oneOf(body, 'where', agentDraftPlaces, 'where is library or factory'),
    ...parseDraftFields(body, 'answer'),
  }
}

export function parseChatAgentId(value: Untyped): string | undefined {
  if (value === undefined) return undefined
  if (!isString(value) || !isAgentId(value))
    throw new HttpError(400, 'agentId must be an Agent id from this Factory’s Agent files')
  return value
}

export interface RunChatCommandRequest {
  name: string
}

export const chatCommandStates = ['waiting', 'running', 'passed', 'failed', 'stopped'] as const

export type ChatCommandState = (typeof chatCommandStates)[number]

export interface ChatCommandResult {
  id: string
  name: string
  state: ChatCommandState
  exitCode?: number
  durationMs?: number
  output?: string
}

export function parseRunChatCommandRequest(value: Untyped): RunChatCommandRequest {
  const body = read.object(value, 'body', 'body must be a JSON object')
  const name = read.string(body, 'name', 'name must be one of this Agent’s command names')
  if (!isAgentId(name)) throw new HttpError(400, 'name must be one of this Agent’s command names')
  return { name }
}
