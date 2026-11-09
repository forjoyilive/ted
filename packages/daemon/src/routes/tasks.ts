import { stripVTControlCharacters } from 'node:util'
import {
  type AgentKind,
  type AgentStageId,
  type AnswerRequest,
  agentKinds,
  agentStageIds,
  type BlockTaskRequest,
  type CreateTaskRequest,
  clarifyDepths,
  type Effort,
  efforts,
  type PostCommentRequest,
  priorities,
  type ReportOutcomeRequest,
  type ResumeTaskRequest,
  type RoundInput,
  type RoundQuestion,
  type RunChecksRequest,
  type SetActivityRequest,
  type SetClarifyDepthRequest,
  type TaskLead,
  type WriteBriefRequest,
} from '@ted/protocol'
import type { Attachments } from '../attachments.ts'
import { RequestError as HttpError } from '../errors.ts'
import type { CreateTaskInput } from '../tasks/tasks.ts'
import { type Route, readJson, readOptionalJson } from './route.ts'

const maxActivityLength = 200

export const taskRoutes: Route[] = [
  {
    method: 'GET',
    path: /^\/tasks$/,
    runToken: true,
    handle: async (_, { store }) => [200, store.listTasks()],
  },
  {
    method: 'POST',
    path: /^\/tasks$/,
    async handle({ req }, { tasks, attachments }) {
      return [201, await tasks.create(await createTaskInput(await readJson(req), attachments))]
    },
  },
  {
    method: 'POST',
    path: /^\/attachments$/,
    handle: async ({ req }, { attachments }) => [201, await attachments.save(req)],
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/start$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, await tasks.start(ref)],
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/backlog$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, tasks.moveToBacklog(ref)],
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/stop$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, await tasks.stop(ref)],
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/resume$/,
    async handle({ req, params: [ref = ''] }, { tasks }) {
      const body = (await readJson(req)) as Partial<ResumeTaskRequest> | null
      const comment = body?.comment
      if (comment !== undefined && typeof comment !== 'string') {
        throw new HttpError(400, 'comment must be text')
      }
      return [200, await tasks.resume(ref, { ...(comment !== undefined && { comment }) })]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/move$/,
    async handle({ req, params: [ref = ''] }, { tasks }) {
      const body = (await readJson(req)) as Record<string, unknown> | null
      const side = (name: 'after' | 'before') => {
        const value = body?.[name]
        if (value === undefined || value === null) return undefined
        if (typeof value !== 'string') throw new HttpError(400, `${name} must be a Task ID`)
        return value
      }
      const after = side('after')
      const before = side('before')
      return [
        200,
        tasks.move(ref, {
          ...(after !== undefined && { after }),
          ...(before !== undefined && { before }),
        }),
      ]
    },
  },
  {
    method: 'PUT',
    path: /^\/tasks\/([^/]+)\/priority$/,
    async handle({ req, params: [ref = ''] }, { tasks }) {
      const body = (await readJson(req)) as Record<string, unknown> | null
      const priority = priorities.find((p) => p === body?.priority)
      if (!priority) throw new HttpError(400, `priority must be ${priorities.join(', ')}`)
      return [200, tasks.setPriority(ref, priority)]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/archive$/,
    async handle({ req, params: [ref = ''] }, { tasks }) {
      const body = (await readOptionalJson(req)) as Record<string, unknown> | null
      const close = body?.closePullRequests
      if (close !== undefined && typeof close !== 'boolean') {
        throw new HttpError(400, 'closePullRequests must be true or false')
      }
      return [200, tasks.archive(ref, { closePullRequests: close === true })]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/blockers$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      const body = (await readJson(req)) as Partial<BlockTaskRequest> | null
      const by = typeof body?.by === 'string' ? body.by.trim() : ''
      if (by === '') throw new HttpError(400, 'by is required')
      return [200, await tasks.block(ref, caller, by)]
    },
  },
  {
    method: 'DELETE',
    path: /^\/tasks\/([^/]+)\/blockers(?:\/([^/]+))?$/,
    runToken: true,
    async handle({ params: [ref = '', by], caller }, { tasks }) {
      return [200, tasks.unblock(ref, caller, by === '' ? undefined : by)]
    },
  },
  {
    method: 'GET',
    path: /^\/slots$/,
    handle: async (_, { tasks }) => [200, await tasks.slots()],
  },
  {
    method: 'PUT',
    path: /^\/tasks\/([^/]+)\/lead$/,
    async handle({ req, params: [ref = ''] }, { tasks }) {
      return [200, tasks.setLead(ref, agentChoice(await readJson(req)))]
    },
  },
  {
    method: 'PUT',
    path: /^\/tasks\/([^/]+)\/clarify-depth$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      const body = (await readJson(req)) as Partial<SetClarifyDepthRequest> | null
      const depth = clarifyDepths.find((d) => d === body?.depth)
      if (!depth) throw new HttpError(400, `depth must be ${clarifyDepths.join(', ')}`)
      if (body?.why !== undefined && typeof body.why !== 'string') {
        throw new HttpError(400, 'why must be text')
      }
      const why = typeof body?.why === 'string' ? oneLine(body.why) : ''
      if (caller.kind === 'run' && why === '') {
        throw new HttpError(400, 'say why you picked this depth')
      }
      if ([...why].length > maxActivityLength) {
        throw new HttpError(400, `the reason is limited to ${maxActivityLength} characters`)
      }
      return [200, await tasks.setClarifyDepth(ref, caller, { depth, ...(why !== '' && { why }) })]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/lead\/use-default-model$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, await tasks.useDefaultModel(ref)],
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/comments$/,
    async handle({ params: [ref = ''] }, { store }) {
      const task = store.getTask(ref)
      if (!task) throw new HttpError(404, `no Task ${ref}`)
      return [200, store.listComments(task.id)]
    },
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/stage-entries$/,
    async handle({ params: [ref = ''] }, { store }) {
      const task = store.getTask(ref)
      if (!task) throw new HttpError(404, `no Task ${ref}`)
      return [200, store.listStageEntries(task.id)]
    },
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/repos\/([^/]+)\/setup-log$/,
    async handle({ params: [ref = '', name = ''] }, { tasks }) {
      return [200, { text: await tasks.setupLog(ref, name) }]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/comments$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      const body = (await readJson(req)) as Partial<PostCommentRequest> | null
      const text = typeof body?.body === 'string' ? body.body.trim() : ''
      const round = body?.round === undefined ? undefined : roundInput(body.round)
      if (text === '' && !round) throw new HttpError(400, 'body is required')
      if (round && body?.choices !== undefined) {
        throw new HttpError(400, 'a round has its choices on each question')
      }
      const choices = choiceList(body?.choices)
      const supersedes = body?.supersedes
      if (supersedes !== undefined && (typeof supersedes !== 'string' || supersedes === '')) {
        throw new HttpError(400, 'supersedes must be a request’s ID')
      }
      return [
        201,
        await tasks.comment(ref, caller, {
          body: text,
          ...(choices && { choices }),
          ...(round && { round }),
          ...(supersedes !== undefined && { supersedes }),
        }),
      ]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/read$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, { read: tasks.markRead(ref) }],
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/events$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, tasks.threadEvents(ref)],
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/brief$/,
    runToken: true,
    handle: async ({ params: [ref = ''], caller }, { tasks }) => [200, tasks.brief(ref, caller)],
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/brief$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      const body = (await readJson(req)) as Partial<WriteBriefRequest> | null
      const text = typeof body?.text === 'string' ? body.text.trim() : ''
      if (text === '') throw new HttpError(400, 'text is required')
      return [201, tasks.writeBrief(ref, caller, `${text}\n`)]
    },
  },
  {
    method: 'GET',
    path: /^\/inbox$/,
    handle: async (_, { tasks }) => [200, tasks.inbox()],
  },
  {
    method: 'GET',
    path: /^\/inbox\/answered$/,
    handle: async (_, { tasks }) => [200, tasks.answered()],
  },
  {
    method: 'POST',
    path: /^\/comments\/([^/]+)\/answer$/,
    async handle({ req, params: [id = ''] }, { tasks }) {
      return [200, await tasks.answer(id, answerRequest(await readJson(req)))]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/activity$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      const body = (await readJson(req)) as Partial<SetActivityRequest> | null
      const text = typeof body?.text === 'string' ? oneLine(body.text) : ''
      if (text === '') throw new HttpError(400, 'text is required')
      if ([...text].length > maxActivityLength) {
        throw new HttpError(400, `the activity line is limited to ${maxActivityLength} characters`)
      }
      return [200, tasks.setActivity(ref, caller, text)]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/outcome$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      const outcome = outcomeRequest(await readJson(req))
      return [200, await tasks.reportOutcome(ref, caller, outcome)]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/checks$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      const body = (await readJson(req)) as Partial<RunChecksRequest> | null
      const name = typeof body?.name === 'string' ? body.name.trim() : undefined
      return [201, await tasks.runChecks(ref, caller, name === '' ? undefined : name)]
    },
  },
  {
    method: 'GET',
    path: /^\/check-runs\/([^/]+)$/,
    runToken: true,
    async handle({ params: [id = ''], caller }, { tasks }) {
      return [200, await tasks.checkRun(id, caller)]
    },
  },
  {
    method: 'GET',
    path: /^\/check-runs\/([^/]+)\/checks\/(\d+)\/output$/,
    async handle({ params: [id = '', position = ''] }, { tasks }) {
      return [200, await tasks.checkOutput(id, Number(position))]
    },
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/check-runs$/,
    async handle({ params: [ref = ''] }, { store }) {
      const task = store.getTask(ref)
      if (!task) throw new HttpError(404, `no Task ${ref}`)
      return [200, store.listCheckRuns(task.id)]
    },
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/send-backs$/,
    async handle({ params: [ref = ''] }, { store }) {
      const task = store.getTask(ref)
      if (!task) throw new HttpError(404, `no Task ${ref}`)
      return [200, store.listSendBacks(task.id)]
    },
  },
  {
    method: 'GET',
    path: /^\/factories\/([^/]+)\/task-defaults$/,
    handle: async ({ params: [id = ''] }, { tasks }) => [200, await tasks.defaults(id)],
  },
  {
    method: 'GET',
    path: /^\/factories\/([^/]+)\/board$/,
    handle: async ({ params: [id = ''] }, { tasks }) => [200, await tasks.board(id)],
  },
]

function agentChoice(body: unknown): TaskLead {
  const { agent, model, effort } = (body ?? {}) as Record<string, unknown>
  if (!agentKinds.includes(agent as AgentKind)) {
    throw new HttpError(400, 'agent must be claude or codex')
  }
  if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
    throw new HttpError(400, 'model must be a name')
  }
  if (effort !== undefined && !efforts.includes(effort as Effort)) {
    throw new HttpError(400, `effort must be one of ${efforts.join(', ')}`)
  }
  return {
    agent: agent as AgentKind,
    ...(typeof model === 'string' && { model: model.trim() }),
    ...(effort !== undefined && { effort: effort as Effort }),
  }
}

async function createTaskInput(body: unknown, attachments: Attachments): Promise<CreateTaskInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'a Task must be an object')
  }
  const request = body as Record<keyof CreateTaskRequest, unknown>
  const text = (name: 'title' | 'description' | 'factory' | 'source') => {
    const value = request[name]
    if (value === undefined) return undefined
    if (typeof value !== 'string') throw new HttpError(400, `${name} must be text`)
    return value
  }
  const oneOf = <T extends string>(name: string, value: unknown, allowed: readonly T[]) => {
    if (value === undefined) return undefined
    const found = allowed.find((a) => a === value)
    if (!found) throw new HttpError(400, `${name} must be ${allowed.join(', ')}`)
    return found
  }
  const list = (name: string, value: unknown) => {
    if (value === undefined) return undefined
    if (!Array.isArray(value)) throw new HttpError(400, `${name} must be a list`)
    return value as unknown[]
  }

  const title = text('title')
  const description = text('description')
  const factory = text('factory')
  const source = sourceUrl(text('source'))
  const priority = oneOf('priority', request.priority, priorities)
  const clarifyDepth = oneOf('clarifyDepth', request.clarifyDepth, clarifyDepths)
  const lead = taskLead(request.lead)
  const blockedBy = list('blockedBy', request.blockedBy)?.map((ref) => {
    if (typeof ref !== 'string') throw new HttpError(400, 'blockedBy must list Task IDs')
    return ref
  })
  const attached = await Promise.all(
    (list('attachments', request.attachments) ?? []).map((item) => {
      const { hash, name, mediaType } = (item ?? {}) as Record<string, unknown>
      if (typeof hash !== 'string' || typeof name !== 'string') {
        throw new HttpError(400, 'an attachment needs a hash and a name')
      }
      return attachments.find({
        hash,
        name,
        mediaType: typeof mediaType === 'string' ? mediaType : '',
      })
    }),
  )
  if (request.start !== undefined && typeof request.start !== 'boolean') {
    throw new HttpError(400, 'start must be true or false')
  }
  return {
    ...(title !== undefined && { title }),
    ...(description !== undefined && { description }),
    ...(factory !== undefined && { factory }),
    ...(priority !== undefined && { priority }),
    ...(clarifyDepth !== undefined && { clarifyDepth }),
    ...(lead !== undefined && { lead }),
    ...(blockedBy !== undefined && { blockedBy }),
    ...(attached.length > 0 && { attachments: attached }),
    ...(source !== undefined && { source }),
    ...(request.start !== undefined && { start: request.start }),
  }

  function taskLead(value: unknown) {
    if (value === undefined) return undefined
    if (typeof value !== 'object' || value === null) {
      throw new HttpError(400, 'lead must be an object')
    }
    const { agent, model, effort } = value as Record<string, unknown>
    const kind = oneOf('lead.agent', agent, agentKinds)
    if (kind === undefined) throw new HttpError(400, 'lead.agent is required')
    if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
      throw new HttpError(400, 'lead.model must be text')
    }
    const level = oneOf('lead.effort', effort, efforts)
    return {
      agent: kind,
      ...(typeof model === 'string' && { model: model.trim() }),
      ...(level !== undefined && { effort: level }),
    }
  }
}

function sourceUrl(text: string | undefined): string | undefined {
  if (text === undefined || text.trim() === '') return undefined
  const trimmed = text.trim()
  const parsed = URL.canParse(trimmed) ? new URL(trimmed) : undefined
  if (
    !parsed ||
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    trimmed.length > 2048 ||
    /\s/.test(trimmed)
  ) {
    throw new HttpError(400, 'source must be a web address starting with https://')
  }
  return trimmed
}

const maxChoices = 6

const maxChoiceLength = 200

function choiceList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((c) => typeof c !== 'string')) {
    throw new HttpError(400, 'choices must be a list of strings')
  }
  const choices = (value as string[]).map(oneLine).filter((c) => c !== '')
  if (choices.length > maxChoices) {
    throw new HttpError(400, `a question has at most ${maxChoices} choices`)
  }
  if (choices.some((c) => [...c].length > maxChoiceLength)) {
    throw new HttpError(400, `a choice is limited to ${maxChoiceLength} characters`)
  }
  return choices.length > 0 ? choices : undefined
}

const maxQuestions = 12

const maxQuestionLength = 1000

const maxRecommendedLength = 2000

function roundInput(value: unknown): RoundInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'a round must be an object')
  }
  const { title, summary, questions } = value as Record<string, unknown>
  const heading = typeof title === 'string' ? oneLine(title) : ''
  if (heading === '') throw new HttpError(400, 'a round needs a title')
  if ([...heading].length > maxChoiceLength) {
    throw new HttpError(400, `a round’s title is limited to ${maxChoiceLength} characters`)
  }
  if (summary !== undefined && typeof summary !== 'string') {
    throw new HttpError(400, 'a round’s summary must be text')
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new HttpError(400, 'a round needs at least one question')
  }
  if (questions.length > maxQuestions) {
    throw new HttpError(400, `a round has at most ${maxQuestions} questions`)
  }
  return {
    title: heading,
    ...(typeof summary === 'string' && summary.trim() !== '' && { summary: summary.trim() }),
    questions: questions.map((item: unknown, i) => roundQuestion(item, i + 1)),
  }
}

function roundQuestion(item: unknown, number: number): RoundQuestion {
  const { question, choices, recommended } = (item ?? {}) as Record<string, unknown>
  const text = typeof question === 'string' ? question.trim() : ''
  if (text === '') throw new HttpError(400, `question ${number} needs its question`)
  if ([...text].length > maxQuestionLength) {
    throw new HttpError(400, `question ${number} is limited to ${maxQuestionLength} characters`)
  }
  const options = choiceList(choices)
  const pick = typeof recommended === 'string' ? recommended.trim() : ''
  if (pick === '') throw new HttpError(400, `question ${number} needs a recommended answer`)
  if ([...pick].length > maxRecommendedLength) {
    throw new HttpError(
      400,
      `question ${number}’s recommended answer is limited to ${maxRecommendedLength} characters`,
    )
  }
  if (options && !options.includes(pick)) {
    throw new HttpError(400, `question ${number}’s recommended answer must be one of its choices`)
  }
  return { question: text, ...(options && { choices: options }), recommended: pick }
}

function outcomeRequest(body: unknown): ReportOutcomeRequest {
  const request = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  if (request.outcome === 'advance') {
    return { outcome: 'advance', ...(request.skip === true && { skip: true }) }
  }
  if (request.outcome === 'back') {
    const to = request.to
    if (typeof to !== 'string' || !agentStageIds.includes(to as AgentStageId)) {
      throw new HttpError(400, `to must be one of ${agentStageIds.join(', ')}`)
    }
    const findings = typeof request.findings === 'string' ? request.findings.trim() : ''
    if (findings === '') throw new HttpError(400, '`back` needs Findings')
    return { outcome: 'back', to: to as AgentStageId, findings }
  }
  if (request.outcome === 'ask') {
    const question = typeof request.question === 'string' ? request.question.trim() : ''
    if (question === '') throw new HttpError(400, 'question is required')
    const choices = choiceList(request.choices)
    return { outcome: 'ask', question, ...(choices && { choices }) }
  }
  throw new HttpError(400, 'outcome must be advance, back or ask')
}

function answerRequest(body: unknown): AnswerRequest {
  const request = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const text = typeof request.text === 'string' ? request.text : undefined
  if (request.text !== undefined && text === undefined) {
    throw new HttpError(400, 'text must be a string')
  }
  if (request.action === 'approve') {
    return { action: 'approve', ...(text !== undefined && { text }) }
  }
  if (request.action === 'request-changes') {
    return { action: 'request-changes', text: text ?? '' }
  }
  if (request.action === 'deny') {
    return { action: 'deny', ...(text !== undefined && { text }) }
  }
  if (request.action === 'answer') {
    if (request.choice !== undefined && typeof request.choice !== 'string') {
      throw new HttpError(400, 'choice must be a string')
    }
    return {
      action: 'answer',
      ...(typeof request.choice === 'string' && { choice: request.choice }),
      ...(text !== undefined && { text }),
    }
  }
  if (request.action === 'accept-recommended') return { action: 'accept-recommended' }
  if (request.action === 'answer-round') {
    if (!Array.isArray(request.answers)) throw new HttpError(400, 'answers must be a list')
    return {
      action: 'answer-round',
      answers: request.answers.map((item: unknown) => {
        const { answer, note } = (item ?? {}) as Record<string, unknown>
        if (typeof answer !== 'string') throw new HttpError(400, 'each answer must be text')
        if (note !== undefined && typeof note !== 'string') {
          throw new HttpError(400, 'a note must be text')
        }
        return { answer, ...(typeof note === 'string' && { note }) }
      }),
    }
  }
  throw new HttpError(
    400,
    'action must be approve, request-changes, deny, answer, answer-round or accept-recommended',
  )
}

function oneLine(text: string): string {
  return [...stripVTControlCharacters(text)]
    .map((c) => (isControl(c) ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
}
