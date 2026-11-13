import type {
  CoordinatorAction,
  CoordinatorCreate,
  CoordinatorMessage,
  CoordinatorOperation,
} from './coordinator.ts'
import type { RoundAnswerInput } from './task.ts'
import { parseCreateTaskRequest, parseSetTaskParentRequest } from './task-parsers.ts'
import { agentChoice, bodyObject, RequestValidationError as HttpError } from './validation.ts'

const maxMessageLength = 8000
const maxAnswers = 50
const maxTitleLength = 300
const maxBlockers = 50
function roundAnswers(value: unknown): RoundAnswerInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxAnswers)
    throw new HttpError(400, 'answers must be a list with one answer per question')
  let length = 0
  const answers = value.map((entry): RoundAnswerInput => {
    const { answer, note } = bodyObject(entry, 'answer')
    if (typeof answer !== 'string' || (note !== undefined && typeof note !== 'string'))
      throw new HttpError(400, 'each answer needs answer text and may have a note')
    length += answer.length + (note?.length ?? 0)
    return {
      answer: answer.trim(),
      ...(note !== undefined && note.trim() !== '' && { note: note.trim() }),
    }
  })
  if (length > maxMessageLength)
    throw new HttpError(400, `answers are limited to ${maxMessageLength} characters in all`)
  return answers
}
function rows(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    !value.every((n) => Number.isSafeInteger(n) && n > 0)
  )
    throw new HttpError(400, 'skipRows must be a list of proposal row numbers')
  return value as number[]
}
function operationId(body: Record<string, unknown>): string {
  if (typeof body.operation !== 'string' || !/^[\w-]{1,100}$/.test(body.operation))
    throw new HttpError(400, 'operation must be a unique ID of up to 100 characters')
  return body.operation
}
function placement(body: Record<string, unknown>): Record<string, string> {
  for (const name of ['after', 'before'])
    if (body[name] !== undefined && (typeof body[name] !== 'string' || body[name] === ''))
      throw new HttpError(400, `${name} must be a Task ID`)
  const neighbours: Record<string, string> = {}
  if (body.neighbours !== undefined) {
    for (const [key, value] of Object.entries(bodyObject(body.neighbours, 'neighbours'))) {
      if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
        throw new HttpError(400, 'neighbour versions must come from current Task reads')
      neighbours[key] = value
    }
  }
  return neighbours
}
const createFields = new Set([
  'operation',
  'title',
  'description',
  'parentId',
  'blockedBy',
  'source',
  'priority',
  'clarifyDepth',
  'lead',
  'start',
  'after',
  'before',
  'neighbours',
])
export function parseCoordinatorCreate(value: unknown): CoordinatorCreate {
  const body = bodyObject(value)
  for (const name of Object.keys(body))
    if (!createFields.has(name))
      throw new HttpError(400, `${name} can’t be set when the Coordinator creates a Task`)
  const operation = operationId(body)
  const { title, description, source, priority, clarifyDepth, lead, blockedBy, start } =
    parseCreateTaskRequest({
      title: body.title,
      description: body.description,
      source: body.source,
      priority: body.priority,
      clarifyDepth: body.clarifyDepth,
      lead: body.lead,
      blockedBy: body.blockedBy,
      start: body.start,
    })
  const name = title?.trim() ?? ''
  if (name === '') throw new HttpError(400, 'title is required')
  if (name.length > maxTitleLength)
    throw new HttpError(400, `title is limited to ${maxTitleLength} characters`)
  const text = description?.trim() ?? ''
  if (text.length > maxMessageLength)
    throw new HttpError(400, `description is limited to ${maxMessageLength} characters`)
  if (blockedBy !== undefined && (blockedBy.length > maxBlockers || blockedBy.includes('')))
    throw new HttpError(400, `blockedBy lists up to ${maxBlockers} Task IDs`)
  if (body.parentId !== undefined && (typeof body.parentId !== 'string' || body.parentId === ''))
    throw new HttpError(400, 'parentId must be a Task ID')
  const neighbours = placement(body)
  return {
    operation,
    title: name,
    ...(text !== '' && { description: text }),
    ...(typeof body.parentId === 'string' && { parentId: body.parentId }),
    ...(blockedBy !== undefined && blockedBy.length > 0 && { blockedBy: [...new Set(blockedBy)] }),
    ...(source !== undefined && { source }),
    ...(priority !== undefined && { priority }),
    ...(clarifyDepth !== undefined && { clarifyDepth }),
    ...(lead !== undefined && { lead }),
    ...(start === true && { start: true }),
    ...(typeof body.after === 'string' && { after: body.after }),
    ...(typeof body.before === 'string' && { before: body.before }),
    ...(Object.keys(neighbours).length > 0 && { neighbours }),
  }
}
export function parseCoordinatorAction(
  value: unknown,
  kind: CoordinatorOperation,
): CoordinatorAction {
  const body = bodyObject(value)
  const operation = operationId(body)
  if (typeof body.version !== 'string' || !/^[a-f0-9]{64}$/.test(body.version))
    throw new HttpError(400, 'version must come from a current Task read')
  const neighbours = placement(body)
  const base = { operation, version: body.version }
  if (kind === 'parent') {
    const parent = parseSetTaskParentRequest({
      parentId: body.parentId,
      revision: body.hierarchyRevision,
    })
    return { ...base, parentId: parent.parentId, hierarchyRevision: parent.revision }
  }
  if (kind === 'start' || kind === 'move')
    return {
      ...base,
      ...(typeof body.after === 'string' && { after: body.after }),
      ...(typeof body.before === 'string' && { before: body.before }),
      neighbours,
    }
  if (body.message !== undefined && typeof body.message !== 'string')
    throw new HttpError(400, 'message must be text')
  const typed = typeof body.message === 'string' ? body.message.trim() : ''
  if (typed.length > maxMessageLength)
    throw new HttpError(400, `message is limited to ${maxMessageLength} characters`)
  const message = typed
  if (kind === 'resume') return { ...base, ...(message !== '' && { message }) }
  if (kind === 'tell') {
    if (message === '') throw new HttpError(400, 'message is required')
    return { ...base, message }
  }
  if (typeof body.request !== 'string' || body.request === '')
    throw new HttpError(400, 'request must be the request’s Comment ID')
  if (body.choice !== undefined && (typeof body.choice !== 'string' || body.choice === ''))
    throw new HttpError(400, 'choice must be one of the request’s choices')
  if (
    body.decision !== undefined &&
    body.decision !== 'approve' &&
    body.decision !== 'request-changes'
  )
    throw new HttpError(400, 'decision must be approve or request-changes')
  for (const name of ['recommended', 'startUnblocked'])
    if (body[name] !== undefined && typeof body[name] !== 'boolean')
      throw new HttpError(400, `${name} must be true or false`)
  const ways = [
    body.decision !== undefined,
    body.answers !== undefined || body.recommended === true,
    body.choice !== undefined,
  ].filter(Boolean).length
  if (ways > 1 || (body.answers !== undefined && body.recommended === true))
    throw new HttpError(400, 'give one of: a decision, round answers or recommended, or a choice')
  if (ways === 0 && message === '')
    throw new HttpError(400, 'pick a choice, give a decision or answers, or write an answer')
  if (body.decision === 'request-changes' && message === '')
    throw new HttpError(400, 'Request changes needs a message')
  return {
    ...base,
    request: body.request,
    ...(typeof body.choice === 'string' && { choice: body.choice }),
    ...(body.decision !== undefined && { decision: body.decision }),
    ...(body.answers !== undefined && { answers: roundAnswers(body.answers) }),
    ...(body.recommended === true && { recommended: true }),
    ...(body.skipRows !== undefined && { skipRows: rows(body.skipRows) }),
    ...(body.startUnblocked === true && { startUnblocked: true }),
    ...(message !== '' && { message }),
  }
}
export function parseCoordinatorMessage(value: unknown): CoordinatorMessage {
  const body = bodyObject(value)
  if (typeof body.text !== 'string') throw new HttpError(400, 'text is required')
  return { text: body.text, ...agentChoice(body) }
}
