import { parseChatAgentId } from './chat-agent.ts'
import type {
  ConfirmationChoices,
  CoordinatorAction,
  CoordinatorConfirmationAnswer,
  CoordinatorCreate,
  CoordinatorMessage,
  CoordinatorOperation,
  CoordinatorRemoval,
  CoordinatorRemovalKind,
  CoordinatorTaskQuery,
  CoordinatorTransfer,
  RenameCoordinatorChatRequest,
} from './coordinator.ts'
import { isString, reader, type Untyped } from './parse.ts'
import { isStageId } from './stage.ts'
import {
  type RoundAnswerInput,
  type StageId,
  type TaskStatusKind,
  taskStatusKinds,
} from './task.ts'
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
    const { answer, choices, note } = bodyObject(entry, 'answer')
    if (typeof answer !== 'string' || (note !== undefined && typeof note !== 'string'))
      throw new HttpError(400, 'each answer needs answer text and may have a note')
    const picks = choiceStrings(choices)
    length += answer.length + (note?.length ?? 0) + (picks ?? []).join('').length
    return {
      answer: answer.trim(),
      ...(picks && { choices: picks }),
      ...(note !== undefined && note.trim() !== '' && { note: note.trim() }),
    }
  })
  if (length > maxMessageLength)
    throw new HttpError(400, `answers are limited to ${maxMessageLength} characters in all`)
  return answers
}
function choiceStrings(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    value.some((c) => typeof c !== 'string' || c === '')
  )
    throw new HttpError(400, 'choices must be a list of the request’s choices')
  return [...new Set(value as string[])]
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
  if (kind === 'done') return base
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
    throw new HttpError(400, 'request must be the request’s comment ID')
  if (body.choice !== undefined && (typeof body.choice !== 'string' || body.choice === ''))
    throw new HttpError(400, 'choice must be one of the request’s choices')
  const picks = choiceStrings(body.choices)
  if (
    body.decision !== undefined &&
    body.decision !== 'approve' &&
    body.decision !== 'request-changes'
  )
    throw new HttpError(400, 'decision must be approve or request-changes')
  for (const name of ['recommended', 'startUnblocked', 'closePullRequests'])
    if (body[name] !== undefined && typeof body[name] !== 'boolean')
      throw new HttpError(400, `${name} must be true or false`)
  const ways = [
    body.decision !== undefined,
    body.answers !== undefined || body.recommended === true,
    body.choice !== undefined || picks !== undefined,
  ].filter(Boolean).length
  if (body.choice !== undefined && picks !== undefined)
    throw new HttpError(400, 'give choice or choices, not both')
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
    ...(picks && { choices: picks }),
    ...(body.decision !== undefined && { decision: body.decision }),
    ...(body.answers !== undefined && { answers: roundAnswers(body.answers) }),
    ...(body.recommended === true && { recommended: true }),
    ...(body.skipRows !== undefined && { skipRows: rows(body.skipRows) }),
    ...(body.startUnblocked === true && { startUnblocked: true }),
    ...(typeof body.closePullRequests === 'boolean' && {
      closePullRequests: body.closePullRequests,
    }),
    ...(message !== '' && { message }),
  }
}
const maxRemovalTasks = 20
const childChoices: Record<CoordinatorRemovalKind, readonly string[]> = {
  archive: ['archive', 'detach'],
  delete: ['delete', 'unparent'],
  unarchive: [],
}
function removalChoices(
  body: Record<string, unknown>,
  kind: CoordinatorRemovalKind,
): ConfirmationChoices {
  const { children, closePullRequests } = body
  const allowed = childChoices[kind]
  if (children !== undefined && !allowed.includes(children as string))
    throw new HttpError(
      400,
      allowed.length === 0
        ? 'children only applies to archive and delete'
        : `children must be ${allowed.join(' or ')}`,
    )
  if (
    closePullRequests !== undefined &&
    (kind !== 'archive' || typeof closePullRequests !== 'boolean')
  )
    throw new HttpError(400, 'closePullRequests is true or false, and only applies to archive')
  return {
    ...(children !== undefined && {
      children: children as NonNullable<ConfirmationChoices['children']>,
    }),
    ...(closePullRequests === true && { closePullRequests: true }),
  }
}
export function parseCoordinatorRemoval(
  value: unknown,
  kind: CoordinatorRemovalKind,
): CoordinatorRemoval {
  const body = bodyObject(value)
  const operation = operationId(body)
  const tasks = body.tasks
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > maxRemovalTasks)
    throw new HttpError(400, `tasks lists 1 to ${maxRemovalTasks} Tasks, each with its version`)
  const parsed = tasks.map((entry) => {
    const { id, version } = bodyObject(entry, 'task')
    if (typeof id !== 'string' || id === '' || id.length > 100)
      throw new HttpError(400, 'each Task needs its ID')
    if (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version))
      throw new HttpError(400, 'version must come from a current Task read')
    return { id, version }
  })
  if (new Set(parsed.map((t) => t.id)).size !== parsed.length)
    throw new HttpError(400, 'name each Task once')
  return { operation, tasks: parsed, ...removalChoices(body, kind) }
}
const read = reader((message) => {
  throw new HttpError(400, message)
})
export function parseCoordinatorTransfer(value: Untyped): CoordinatorTransfer {
  const body = read.object(value, 'transfer request')
  const operationProblem = 'operation must be a unique ID of up to 100 characters'
  const operation = read.string(body, 'operation', operationProblem)
  if (!/^[\w-]{1,100}$/.test(operation)) throw new HttpError(400, operationProblem)
  const task = read.object(body.task, 'task', 'task needs its ID and version')
  const id = read.string(task, 'id', 'the Task needs its ID')
  if (id === '' || id.length > 100) throw new HttpError(400, 'the Task needs its ID')
  const versionProblem = 'version must come from a current Task read'
  const version = read.string(task, 'version', versionProblem)
  if (!/^[a-f0-9]{64}$/.test(version)) throw new HttpError(400, versionProblem)
  const factoryProblem = 'factory must be a Factory key or ID'
  const factory = read.string(body, 'factory', factoryProblem).trim()
  if (factory === '' || factory.length > 100) throw new HttpError(400, factoryProblem)
  return { operation, task: { id, version }, factory }
}
export function parseCoordinatorConfirmationAnswer(value: unknown): CoordinatorConfirmationAnswer {
  const body = bodyObject(value)
  if (body.decision !== 'confirm' && body.decision !== 'cancel')
    throw new HttpError(400, 'decision must be confirm or cancel')
  if (body.choices === undefined) return { decision: body.decision }
  const entries = Object.entries(bodyObject(body.choices, 'choices'))
  if (entries.length > maxRemovalTasks) throw new HttpError(400, 'too many Tasks in choices')
  const choices: Record<string, ConfirmationChoices> = {}
  for (const [id, raw] of entries) {
    const entry = bodyObject(raw, 'choice')
    const { children } = entry
    const kind = children === 'delete' || children === 'unparent' ? 'delete' : 'archive'
    choices[id] = {
      ...removalChoices(entry, kind),
      ...(entry.closePullRequests === false && { closePullRequests: false }),
    }
  }
  return { decision: body.decision, choices }
}
export function parseCoordinatorMessage(value: unknown): CoordinatorMessage {
  const body = bodyObject(value)
  if (typeof body.text !== 'string') throw new HttpError(400, 'text is required')
  const agentId = parseChatAgentId(body.agentId)
  return { text: body.text, ...agentChoice(body), ...(agentId !== undefined && { agentId }) }
}

export function parseRenameCoordinatorChatRequest(value: Untyped): RenameCoordinatorChatRequest {
  const { title } = bodyObject(value)
  if (!isString(title)) throw new HttpError(400, 'title must be text')
  return { title }
}

const queryStatuses: readonly string[] = taskStatusKinds
const queryKeys = new Set(['offset', 'all', 'stage', 'status', 'waiting', 'search'])
const maxSearchLength = 200

export function parseCoordinatorTaskQuery(search: string): CoordinatorTaskQuery {
  const params = new URLSearchParams(search)
  for (const key of params.keys())
    if (!queryKeys.has(key)) throw new HttpError(400, `unknown Task list filter ${key}`)
  for (const key of ['offset', 'all', 'waiting', 'search'])
    if (params.getAll(key).length > 1) throw new HttpError(400, `${key} may be given once`)
  const query: CoordinatorTaskQuery = {}
  const offset = params.get('offset')
  if (offset !== null) {
    if (!/^\d{1,8}$/.test(offset)) throw new HttpError(400, 'offset must be a whole number')
    query.offset = Number(offset)
  }
  for (const flag of ['all', 'waiting'] as const) {
    const value = params.get(flag)
    if (value === null) continue
    if (value !== '1') throw new HttpError(400, `${flag} takes no value`)
    query[flag] = true
  }
  const stages = [...new Set(params.getAll('stage'))]
  for (const stage of stages)
    if (!isStageId(stage))
      throw new HttpError(
        400,
        `unknown Stage ${stage}; a Stage id is lowercase letters, digits and hyphens`,
      )
  if (stages.length > 0) query.stages = stages as StageId[]
  const statuses = [...new Set(params.getAll('status'))]
  for (const status of statuses)
    if (!queryStatuses.includes(status))
      throw new HttpError(400, `unknown status ${status}; use one of ${queryStatuses.join(', ')}`)
  if (statuses.length > 0) query.statuses = statuses as TaskStatusKind[]
  const text = params.get('search')?.trim()
  if (text !== undefined && text !== '') {
    if (text.length > maxSearchLength)
      throw new HttpError(400, `search is limited to ${maxSearchLength} characters`)
    query.search = text
  }
  return query
}

export function coordinatorTaskSearch(query: CoordinatorTaskQuery): string {
  const params = new URLSearchParams()
  if (query.offset) params.set('offset', String(query.offset))
  if (query.all) params.set('all', '1')
  for (const stage of query.stages ?? []) params.append('stage', stage)
  for (const status of query.statuses ?? []) params.append('status', status)
  if (query.waiting) params.set('waiting', '1')
  if (query.search) params.set('search', query.search)
  const text = params.toString()
  return text === '' ? '' : `?${text}`
}
