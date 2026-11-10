import { randomUUID } from 'node:crypto'
import type { CoordinatorAction, CoordinatorOperation, RoundAnswerInput } from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import { agentChoice, bodyObject, type Route, readJson } from './route.ts'

const offset = (raw: string | undefined) => Number(raw ?? 0)
const context = (value: unknown) => {
  const nonce = randomUUID()
  return {
    context: `<<<TASK CONTEXT ${nonce}>>>\n${JSON.stringify(value)}\n<<<END TASK CONTEXT ${nonce}>>>`,
  }
}
const maxMessageLength = 8000
const maxAnswers = 50
const operations: readonly string[] = ['start', 'move', 'tell', 'answer', 'resume']
function roundAnswers(value: unknown): RoundAnswerInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxAnswers)
    throw new RequestError(400, 'answers must be a list with one answer per question')
  let length = 0
  const answers = value.map((entry): RoundAnswerInput => {
    const { answer, note } = bodyObject(entry, 'answer')
    if (typeof answer !== 'string' || (note !== undefined && typeof note !== 'string'))
      throw new RequestError(400, 'each answer needs answer text and may have a note')
    length += answer.length + (note?.length ?? 0)
    return {
      answer: redactSecrets(answer.trim()),
      ...(note !== undefined && note.trim() !== '' && { note: redactSecrets(note.trim()) }),
    }
  })
  if (length > maxMessageLength)
    throw new RequestError(400, `answers are limited to ${maxMessageLength} characters in all`)
  return answers
}
function rows(value: unknown): number[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    !value.every((n) => Number.isSafeInteger(n) && n > 0)
  )
    throw new RequestError(400, 'skipRows must be a list of proposal row numbers')
  return value as number[]
}
function action(value: unknown, kind: CoordinatorOperation): CoordinatorAction {
  const body = bodyObject(value)
  if (typeof body.operation !== 'string' || !/^[\w-]{1,100}$/.test(body.operation))
    throw new RequestError(400, 'operation must be a unique ID of up to 100 characters')
  if (typeof body.version !== 'string' || !/^[a-f0-9]{64}$/.test(body.version))
    throw new RequestError(400, 'version must come from a current Task read')
  for (const name of ['after', 'before'])
    if (body[name] !== undefined && (typeof body[name] !== 'string' || body[name] === ''))
      throw new RequestError(400, `${name} must be a Task ID`)
  const neighbours: Record<string, string> = {}
  if (body.neighbours !== undefined) {
    for (const [key, value] of Object.entries(bodyObject(body.neighbours, 'neighbours'))) {
      if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
        throw new RequestError(400, 'neighbour versions must come from current Task reads')
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
    throw new RequestError(400, 'message must be text')
  const typed = typeof body.message === 'string' ? body.message.trim() : ''
  if (typed.length > maxMessageLength)
    throw new RequestError(400, `message is limited to ${maxMessageLength} characters`)
  const message = redactSecrets(typed)
  if (kind === 'resume') return { ...base, ...(message !== '' && { message }) }
  if (kind === 'tell') {
    if (message === '') throw new RequestError(400, 'message is required')
    return { ...base, message }
  }
  if (typeof body.request !== 'string' || body.request === '')
    throw new RequestError(400, 'request must be the request’s Comment ID')
  if (body.choice !== undefined && (typeof body.choice !== 'string' || body.choice === ''))
    throw new RequestError(400, 'choice must be one of the request’s choices')
  if (
    body.decision !== undefined &&
    body.decision !== 'approve' &&
    body.decision !== 'request-changes'
  )
    throw new RequestError(400, 'decision must be approve or request-changes')
  for (const name of ['recommended', 'startUnblocked'])
    if (body[name] !== undefined && typeof body[name] !== 'boolean')
      throw new RequestError(400, `${name} must be true or false`)
  const ways = [
    body.decision !== undefined,
    body.answers !== undefined || body.recommended === true,
    body.choice !== undefined,
  ].filter(Boolean).length
  if (ways > 1 || (body.answers !== undefined && body.recommended === true))
    throw new RequestError(
      400,
      'give one of: a decision, round answers or recommended, or a choice',
    )
  if (ways === 0 && message === '')
    throw new RequestError(400, 'pick a choice, give a decision or answers, or write an answer')
  if (body.decision === 'request-changes' && message === '')
    throw new RequestError(400, 'Request changes needs a message')
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
export const coordinatorRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/factories\/([^/]+)\/coordinator$/,
    handle: async ({ params: [id = ''] }, { coordinators }) => [200, coordinators.get(id)],
  },
  {
    method: 'GET',
    path: /^\/factories\/([^/]+)\/coordinator\/chat$/,
    handle: async ({ params: [id = ''] }, { coordinators, conversations }) => [
      200,
      coordinators.get(id) ? await conversations.coordinatorChat(id) : null,
    ],
  },
  {
    method: 'GET',
    path: /^\/coordinators$/,
    handle: async (_, { coordinators }) => [200, coordinators.statuses()],
  },
  {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/coordinator\/messages$/,
    async handle({ params: [id = ''], req }, { coordinators }) {
      const body = bodyObject(await readJson(req))
      if (typeof body.text !== 'string') throw new RequestError(400, 'text is required')
      return [201, await coordinators.message(id, { text: body.text, ...agentChoice(body) })]
    },
  },
  {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/coordinator\/stop$/,
    handle: async ({ params: [id = ''] }, { coordinators }) => [200, await coordinators.stop(id)],
  },
  {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/coordinator\/retry$/,
    handle: async ({ params: [id = ''] }, { coordinators }) => [200, await coordinators.retry(id)],
  },
  {
    method: 'GET',
    path: /^\/coordinator\/tasks(?:\?offset=(\d{1,8}))?$/,
    runToken: true,
    handle: async ({ caller, params: [page] }, { coordinators }) => [
      200,
      context(coordinators.list(caller, offset(page))),
    ],
  },
  {
    method: 'GET',
    path: /^\/coordinator\/tasks\/([^/?]+)(?:\?offset=(\d{1,8}))?$/,
    runToken: true,
    handle: async ({ caller, params: [ref = '', page] }, { coordinators }) => [
      200,
      context(coordinators.task(caller, ref, offset(page))),
    ],
  },
  {
    method: 'POST',
    path: /^\/coordinator\/tasks\/([^/]+)\/(start|move|tell|answer|resume)$/,
    runToken: true,
    async handle({ caller, req, params: [ref = '', kind = ''] }, { coordinators }) {
      if (!operations.includes(kind)) throw new RequestError(400, 'unknown action')
      const operation = kind as CoordinatorOperation
      return [
        200,
        await coordinators.act(caller, ref, operation, action(await readJson(req), operation)),
      ]
    },
  },
]
