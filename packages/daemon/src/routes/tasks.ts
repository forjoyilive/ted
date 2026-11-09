import { stripVTControlCharacters } from 'node:util'
import {
  type AgentKind,
  type AgentStageId,
  type AnswerRequest,
  type Attachment,
  agentKinds,
  agentStageIds,
  type BlockedChoice,
  type BlockTaskRequest,
  blockedChoices,
  type CancelMergeRequest,
  type CreateTaskRequest,
  clarifyDepths,
  type EditTaskRequest,
  type Effort,
  efforts,
  type FollowUpRequest,
  isModelName,
  type PostCommentRequest,
  priorities,
  type ResumeTaskRequest,
  type RoundInput,
  type RoundQuestion,
  type RunChecksRequest,
  type SetActivityRequest,
  type SetClarifyDepthRequest,
  type SetTaskReposRequest,
  type TaskLead,
  type ValidateJudgments,
  type WriteBriefRequest,
} from '@ted/protocol'
import type { Attachments } from '../attachments.ts'
import { RequestError as HttpError } from '../errors.ts'
import type {
  CreateTaskInput,
  DesignSubmission,
  DesignSubmissionFile,
  OutcomeInput,
} from '../tasks/tasks.ts'
import { type Route, readJson, readOptionalJson } from './route.ts'

const maxActivityLength = 200

function blockedChoice(body: Record<string, unknown> | null): BlockedChoice {
  const value = body?.blocked
  if (value === undefined) return 'unblock'
  const choice = blockedChoices.find((c) => c === value)
  if (!choice) throw new HttpError(400, `blocked must be ${blockedChoices.join(' or ')}`)
  return choice
}

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
    fileToken: true,
    runToken: true,
    async handle({ req, caller }, { tasks, attachments }) {
      return [
        201,
        await tasks.create(await createTaskInput(await readJson(req), attachments), caller),
      ]
    },
  },
  {
    method: 'POST',
    path: /^\/attachments$/,
    handle: async ({ req }, { attachments }) => [201, await attachments.save(req)],
  },
  {
    method: 'GET',
    path: /^\/attachments\/([^/]+)\/([^/]+)$/,
    async handle({ params: [hash = '', name = ''] }, { attachments }) {
      return [200, await attachments.read({ hash, name })]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/attachments$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks, attachments }) {
      return [201, await tasks.upload(ref, caller, () => attachments.save(req))]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/start$/,
    fileToken: true,
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
    async handle({ req, params: [ref = ''] }, { tasks, attachments }) {
      const body = (await readJson(req)) as Partial<ResumeTaskRequest> | null
      const comment = body?.comment
      if (comment !== undefined && typeof comment !== 'string') {
        throw new HttpError(400, 'comment must be text')
      }
      const files = await attachmentList(body?.attachments, attachments)
      return [
        200,
        await tasks.resume(ref, {
          ...(comment !== undefined && { comment }),
          ...(files.length > 0 && { attachments: files }),
        }),
      ]
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
    method: 'PUT',
    path: /^\/tasks\/([^/]+)$/,
    async handle({ req, params: [ref = ''] }, { tasks }) {
      const body = (await readJson(req)) as Partial<EditTaskRequest> | null
      const { title, description } = body ?? {}
      if (title !== undefined && typeof title !== 'string') {
        throw new HttpError(400, 'title must be text')
      }
      if (description !== undefined && typeof description !== 'string') {
        throw new HttpError(400, 'description must be text')
      }
      if (title === undefined && description === undefined) {
        throw new HttpError(400, 'send a title, a description or both')
      }
      const name = title === undefined ? undefined : oneLine(title)
      if (name === '') throw new HttpError(400, 'a Task needs a title')
      return [
        200,
        await tasks.edit(ref, {
          ...(name !== undefined && { title: name }),
          ...(description !== undefined && { description: description.trim() }),
        }),
      ]
    },
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/descriptions$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, tasks.descriptions(ref)],
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
      return [
        200,
        tasks.archive(ref, { closePullRequests: close === true, blocked: blockedChoice(body) }),
      ]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/follow-up$/,
    async handle({ req, params: [ref = ''] }, { tasks, attachments }) {
      const body = (await readOptionalJson(req)) as Partial<FollowUpRequest> | null
      const comment = body?.comment
      if (comment !== undefined && typeof comment !== 'string') {
        throw new HttpError(400, 'comment must be text')
      }
      const files = await attachmentList(body?.attachments, attachments)
      return [
        201,
        await tasks.followUp(ref, {
          ...(comment !== undefined && { comment }),
          ...(files.length > 0 && { attachments: files }),
        }),
      ]
    },
  },
  {
    method: 'POST',
    path: /^\/factories\/([^/]+)\/archive-done$/,
    handle: async ({ params: [key = ''] }, { tasks }) => [200, tasks.archiveDone(key)],
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/unarchive$/,
    handle: async ({ params: [ref = ''] }, { tasks }) => [200, await tasks.unarchive(ref)],
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/delete$/,
    async handle({ req, params: [ref = ''] }, { tasks }) {
      const body = (await readOptionalJson(req)) as Record<string, unknown> | null
      await tasks.delete(ref, { blocked: blockedChoice(body) })
      return [200, {}]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/blockers$/,
    fileToken: true,
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
    fileToken: true,
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
    fileToken: true,
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
    fileToken: true,
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
    method: 'PUT',
    path: /^\/tasks\/([^/]+)\/repos$/,
    runToken: true,
    async handle({ req, params: [ref = ''], caller }, { tasks }) {
      return [200, await tasks.setRepos(ref, caller, reposRequest(await readJson(req)))]
    },
  },
  {
    method: 'GET',
    path: /^\/tasks\/([^/]+)\/repos\/([^/]+)\/setup$/,
    runToken: true,
    async handle({ params: [ref = '', name = ''], caller }, { tasks }) {
      return [200, await tasks.repoSetup(ref, name, caller)]
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
    async handle({ req, params: [ref = ''], caller }, { tasks, attachments }) {
      const body = (await readJson(req)) as Partial<PostCommentRequest> | null
      const text = typeof body?.body === 'string' ? body.body.trim() : ''
      const round = body?.round === undefined ? undefined : roundInput(body.round)
      const files = await attachmentList(body?.attachments, attachments)
      if (text === '' && !round && files.length === 0) {
        throw new HttpError(400, 'body is required')
      }
      if (
        files.length > 0 &&
        (round || body?.choices !== undefined || body?.supersedes !== undefined)
      ) {
        throw new HttpError(400, 'only a note can carry attachments')
      }
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
          ...(files.length > 0 && { attachments: files }),
        }),
      ]
    },
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/cancel-merge$/,
    async handle({ req, params: [ref = ''] }, { tasks, attachments }) {
      const body = (await readJson(req)) as Partial<CancelMergeRequest> | null
      const text = typeof body?.comment === 'string' ? body.comment.trim() : ''
      if (text === '') throw new HttpError(400, 'comment is required')
      const files = await attachmentList(body?.attachments, attachments)
      return [201, await tasks.cancelMerge(ref, text, files)]
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
    async handle({ req, params: [ref = ''], caller }, { tasks, attachments }) {
      const outcome = await outcomeRequest(await readJson(req), attachments)
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

const maxRepoRefs = 20

function reposRequest(body: unknown): SetTaskReposRequest {
  const given = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const list = (value: unknown, key: string): string[] => {
    if (
      !Array.isArray(value) ||
      value.length > maxRepoRefs ||
      !value.every((v) => typeof v === 'string' && v.trim() !== '' && v.length <= 200)
    ) {
      throw new HttpError(400, `${key} must be a list of repo names`)
    }
    return value.map((v: string) => v.trim())
  }
  if (given.confirm !== undefined && typeof given.confirm !== 'boolean') {
    throw new HttpError(400, 'confirm must be true or false')
  }
  const confirm = given.confirm === true
  const keys = ['set', 'add', 'remove'].filter((k) => given[k] !== undefined)
  if (keys.length !== 1) throw new HttpError(400, 'give exactly one of set, add or remove')
  if (given.set !== undefined) return { set: list(given.set, 'set'), confirm }
  if (given.add !== undefined) return { add: list(given.add, 'add') }
  return { remove: list(given.remove, 'remove'), confirm }
}

function agentChoice(body: unknown): TaskLead {
  const { agent, model, effort } = (body ?? {}) as Record<string, unknown>
  if (!agentKinds.includes(agent as AgentKind)) {
    throw new HttpError(400, 'agent must be claude or codex')
  }
  if (model !== undefined && !isModelName(model)) {
    throw new HttpError(400, 'model must be a model name, such as opus or gpt-5.5')
  }
  if (effort !== undefined && !efforts.includes(effort as Effort)) {
    throw new HttpError(400, `effort must be one of ${efforts.join(', ')}`)
  }
  return {
    agent: agent as AgentKind,
    ...(model !== undefined && { model }),
    ...(effort !== undefined && { effort: effort as Effort }),
  }
}

async function createTaskInput(body: unknown, attachments: Attachments): Promise<CreateTaskInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'a Task must be an object')
  }
  const request = body as Record<keyof CreateTaskRequest, unknown>
  const text = (name: 'title' | 'description' | 'factory' | 'source' | 'followUp') => {
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
  const followUp = text('followUp')?.trim() || undefined
  const priority = oneOf('priority', request.priority, priorities)
  const clarifyDepth = oneOf('clarifyDepth', request.clarifyDepth, clarifyDepths)
  const lead = taskLead(request.lead)
  const blockedBy = list('blockedBy', request.blockedBy)?.map((ref) => {
    if (typeof ref !== 'string') throw new HttpError(400, 'blockedBy must list Task IDs')
    return ref
  })
  const attached = await attachmentList(request.attachments, attachments)
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
    ...(followUp !== undefined && { followUp }),
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
    if (model !== undefined && !isModelName(model)) {
      throw new HttpError(400, 'lead.model must be a model name, such as opus or gpt-5.5')
    }
    const level = oneOf('lead.effort', effort, efforts)
    return {
      agent: kind,
      ...(model !== undefined && { model }),
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

async function outcomeRequest(body: unknown, attachments: Attachments): Promise<OutcomeInput> {
  const request = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const judged = judgments(request.judged)
  if (request.outcome === 'advance') {
    const changes = typeof request.changes === 'string' ? oneLine(request.changes) : ''
    if ([...changes].length > 300) {
      throw new HttpError(400, 'the changes summary is limited to 300 characters')
    }
    const design =
      request.design === undefined ? undefined : await designReview(request.design, attachments)
    if (design && request.skip === true) {
      throw new HttpError(400, 'a skipped Design has no design review')
    }
    return {
      outcome: 'advance',
      ...(request.skip === true && { skip: true }),
      ...(judged && { judged }),
      ...(changes !== '' && { changes }),
      ...(design && { design }),
    }
  }
  if (request.outcome === 'back') {
    const to = request.to
    if (typeof to !== 'string' || !agentStageIds.includes(to as AgentStageId)) {
      throw new HttpError(400, `to must be one of ${agentStageIds.join(', ')}`)
    }
    const findings = typeof request.findings === 'string' ? request.findings.trim() : ''
    if (findings === '') throw new HttpError(400, '`back` needs Findings')
    return { outcome: 'back', to: to as AgentStageId, findings, ...(judged && { judged }) }
  }
  if (request.outcome === 'ask') {
    const question = typeof request.question === 'string' ? request.question.trim() : ''
    if (question === '') throw new HttpError(400, 'question is required')
    const choices = choiceList(request.choices)
    return { outcome: 'ask', question, ...(choices && { choices }) }
  }
  throw new HttpError(400, 'outcome must be advance, back or ask')
}

const maxScreenshots = 12
const maxWorthYourEye = 10
const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']
const videoTypes = ['video/mp4', 'video/webm', 'video/quicktime']

function shortText(value: unknown, what: string, limit: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new HttpError(400, `${what} must be text`)
  const text = oneLine(value)
  if ([...text].length > limit) {
    throw new HttpError(400, `${what} is limited to ${limit} characters`)
  }
  return text === '' ? undefined : text
}

async function designFile(
  value: unknown,
  role: string,
  types: readonly string[],
  attachments: Attachments,
): Promise<DesignSubmissionFile> {
  if (typeof value !== 'object' || value === null) {
    throw new HttpError(400, `the ${role} needs a hash and a name`)
  }
  const { hash, name, mediaType, caption } = value as Record<string, unknown>
  if (typeof hash !== 'string' || typeof name !== 'string') {
    throw new HttpError(400, `the ${role} needs a hash and a name`)
  }
  const file = await attachments.find({
    hash,
    name,
    mediaType: typeof mediaType === 'string' ? mediaType : '',
  })
  if (!types.includes(file.mediaType)) {
    throw new HttpError(400, `${file.name} can’t be the ${role}; ${roleTypes[role] ?? ''}`)
  }
  const text = shortText(caption, `the ${role}’s caption`, 80)
  return { ...file, ...(text !== undefined && { caption: text }) }
}

const roleTypes: Record<string, string> = {
  screenshot: 'a screenshot is a PNG, JPEG, GIF, WebP or SVG image',
  video: 'the video is an MP4, WebM or QuickTime file',
  prototype: 'the prototype is an HTML file',
}

function figmaLink(value: unknown): DesignSubmission['figma'] {
  if (value === undefined) return undefined
  const { url, label } = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >
  const parsed = typeof url === 'string' && URL.canParse(url) ? new URL(url) : undefined
  const host = parsed?.protocol === 'https:' ? parsed.hostname : ''
  if (!parsed || (host !== 'figma.com' && !host.endsWith('.figma.com'))) {
    throw new HttpError(400, 'the Figma link must be an https://www.figma.com/ URL')
  }
  const text = shortText(label, 'the Figma link’s label', 120)
  return { url: parsed.href, ...(text !== undefined && { label: text }) }
}

async function designReview(value: unknown, attachments: Attachments): Promise<DesignSubmission> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'design must be an object')
  }
  const input = value as Record<string, unknown>
  const title = shortText(input.title, 'the design review’s title', 200)
  const summary = typeof input.summary === 'string' ? input.summary.trim() : undefined
  if (input.summary !== undefined && summary === undefined) {
    throw new HttpError(400, 'the summary must be text')
  }
  if (summary !== undefined && [...summary].length > 1000) {
    throw new HttpError(400, 'the summary is limited to 1000 characters')
  }
  if (input.screenshots !== undefined && !Array.isArray(input.screenshots)) {
    throw new HttpError(400, 'screenshots must be a list')
  }
  const shots = (input.screenshots as unknown[] | undefined) ?? []
  if (shots.length > maxScreenshots) {
    throw new HttpError(400, `a design review shows at most ${maxScreenshots} screenshots`)
  }
  const screenshots = await Promise.all(
    shots.map((shot) => designFile(shot, 'screenshot', imageTypes, attachments)),
  )
  const video =
    input.video === undefined
      ? undefined
      : await designFile(input.video, 'video', videoTypes, attachments)
  const prototype =
    input.prototype === undefined
      ? undefined
      : await designFile(input.prototype, 'prototype', ['text/html'], attachments)
  const figma = figmaLink(input.figma)
  if (input.worthYourEye !== undefined && !Array.isArray(input.worthYourEye)) {
    throw new HttpError(400, 'worthYourEye must be a list')
  }
  const points = ((input.worthYourEye as unknown[] | undefined) ?? []).flatMap((point) => {
    const text = shortText(point, 'each Worth your eye point', 300)
    return text === undefined ? [] : [text]
  })
  if (points.length > maxWorthYourEye) {
    throw new HttpError(400, `Worth your eye holds at most ${maxWorthYourEye} points`)
  }
  return {
    ...(title !== undefined && { title }),
    ...(summary !== undefined && summary !== '' && { summary }),
    ...(screenshots.length > 0 && { screenshots }),
    ...(video && { video }),
    ...(prototype && { prototype }),
    ...(figma && { figma }),
    ...(points.length > 0 && { worthYourEye: points }),
  }
}

function judgments(value: unknown): ValidateJudgments | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) {
    throw new HttpError(400, 'judged must be an object')
  }
  const input = value as Record<string, unknown>
  const one = (name: 'review' | 'visual') => {
    const item = input[name]
    if (item === undefined) return undefined
    const { passed, notes } = (typeof item === 'object' && item !== null ? item : {}) as Record<
      string,
      unknown
    >
    if (typeof passed !== 'boolean')
      throw new HttpError(400, `${name}.passed must be true or false`)
    if (notes !== undefined && !(Number.isInteger(notes) && (notes as number) >= 0)) {
      throw new HttpError(400, `${name}.notes must be a whole number`)
    }
    return { passed, ...(typeof notes === 'number' && { notes }) }
  }
  const review = one('review')
  const visual = one('visual')
  if (!review && !visual) return undefined
  return { ...(review && { review }), ...(visual && { visual }) }
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

const maxAttachmentsPerRequest = 50

async function attachmentList(value: unknown, attachments: Attachments): Promise<Attachment[]> {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new HttpError(400, 'attachments must be a list')
  if (value.length > maxAttachmentsPerRequest) {
    throw new HttpError(400, `attach at most ${maxAttachmentsPerRequest} files at once`)
  }
  return Promise.all(
    value.map((item: unknown) => {
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
}
