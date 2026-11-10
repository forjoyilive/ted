import type { CoordinatorAction, CoordinatorMessage, CoordinatorOperation } from './coordinator.ts'
import { agentChoice, bodyObject, RequestValidationError as HttpError } from './validation.ts'

const maxMessageLength = 8000
export function parseCoordinatorAction(
  value: unknown,
  kind: CoordinatorOperation,
): CoordinatorAction {
  const body = bodyObject(value)
  if (typeof body.operation !== 'string' || !/^[\w-]{1,100}$/.test(body.operation))
    throw new HttpError(400, 'operation must be a unique ID of up to 100 characters')
  if (typeof body.version !== 'string' || !/^[a-f0-9]{64}$/.test(body.version))
    throw new HttpError(400, 'version must come from a current Task read')
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
  const base = { operation: body.operation, version: body.version }
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
  if (kind === 'tell') {
    if (message === '') throw new HttpError(400, 'message is required')
    return { ...base, message }
  }
  if (typeof body.request !== 'string' || body.request === '')
    throw new HttpError(400, 'request must be the question’s Comment ID')
  if (body.choice !== undefined && (typeof body.choice !== 'string' || body.choice === ''))
    throw new HttpError(400, 'choice must be one of the question’s choices')
  if (body.choice === undefined && message === '')
    throw new HttpError(400, 'pick a choice or write an answer')
  return {
    ...base,
    request: body.request,
    ...(typeof body.choice === 'string' && { choice: body.choice }),
    ...(message !== '' && { message }),
  }
}

export function parseCoordinatorMessage(value: unknown): CoordinatorMessage {
  const body = bodyObject(value)
  if (typeof body.text !== 'string') throw new HttpError(400, 'text is required')
  return { text: body.text, ...agentChoice(body) }
}
