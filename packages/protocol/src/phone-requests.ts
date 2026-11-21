import type { Json, JsonObject } from './parse.ts'
import { isInteger, isOneOf, isString, ParseError, reader, type Untyped } from './parse.ts'
import { type PhoneTaskAction, phoneTaskActions } from './phone-tasks.ts'
import type { PlanRequestKind } from './plan.ts'
import { type Comment, type Priority, priorities } from './task.ts'

export const phoneRequestSources = ['task', 'plan', 'automation', 'chat'] as const
export type PhoneRequestSource = (typeof phoneRequestSources)[number]

export const phoneRequestKinds = [
  'question',
  'round',
  'permission',
  'signoff',
  'proposal',
  'review',
  'request',
] as const
export type PhoneRequestKind = (typeof phoneRequestKinds)[number]

export const phoneHeadlineMax = 200
export const phoneReplyBodyMax = 40_000

export interface PhoneRequestSummary {
  id: string
  source: PhoneRequestSource
  kind: PhoneRequestKind
  factory: string
  title: string
  ref?: string
  headline: string
  createdAt: string
  failed?: true
  onPhone: boolean
  task?: PhoneRequestTask
}

export interface PhoneRequestTask {
  id: string
  priority: Priority
  actions: PhoneTaskAction[]
}

export interface PhoneRoundQuestion {
  question: string
  choices?: string[]
  multiple?: true
  recommended: string
  recommendedChoices?: string[]
}

export interface PhoneProposalRow {
  title: string
  scope: string
  priority: Priority
  blockedBy: number[]
}

export type PhoneForm =
  | { type: 'choices'; choices: string[]; multiple: boolean; text: boolean }
  | { type: 'text' }
  | { type: 'round'; questions: PhoneRoundQuestion[] }
  | { type: 'permission'; command: string; cut: boolean }
  | { type: 'signoff'; stage: string; brief: string; cut: boolean }
  | { type: 'proposal'; title: string; summary: string; rows: PhoneProposalRow[] }
  | { type: 'mac'; reason: string }

export interface PhoneRequestDetail extends PhoneRequestSummary {
  body: string
  cut: boolean
  attachments: number
  form: PhoneForm
}

export interface PhoneRoundAnswer {
  answer: string
  choices?: string[]
}

export type PhoneAnswer =
  | { action: 'answer'; choice?: string; choices?: string[]; text?: string }
  | { action: 'answer-round'; answers: PhoneRoundAnswer[] }
  | { action: 'approve' }
  | { action: 'deny' }
  | { action: 'request-changes'; text: string }

export interface PhoneRequestsBody {
  requests: PhoneRequestSummary[]
  more: number
}

export interface PhoneRequestBody {
  request: PhoneRequestDetail
}

export interface PhoneAnsweredBody {
  answered: true
}

export type PhoneAnswerSubject =
  | {
      source: 'task'
      request: Pick<
        Comment,
        | 'kind'
        | 'purpose'
        | 'talkRequested'
        | 'talk'
        | 'simulator'
        | 'move'
        | 'linearTeam'
        | 'archive'
        | 'asanaMissing'
        | 'asanaUnfinished'
      >
      tasksUnder: number
      openPullRequests: number
    }
  | { source: 'plan'; kind: PlanRequestKind }
  | { source: 'automation' }
  | { source: 'chat' }

export type PhoneAnswerability = { onPhone: true } | { onPhone: false; reason: string }

const onMac = (reason: string): PhoneAnswerability => ({ onPhone: false, reason })

export function phoneAnswerability(subject: PhoneAnswerSubject): PhoneAnswerability {
  if (subject.source === 'chat')
    return onMac('Requests from Coordinator chats are answered on your Mac.')
  if (subject.source === 'automation') return { onPhone: true }
  if (subject.source === 'plan') {
    return subject.kind === 'round' || subject.kind === 'proposal'
      ? { onPhone: true }
      : onMac('Answer this on your Mac.')
  }
  const { request } = subject
  const purpose = request.purpose?.kind
  if (request.kind === 'review')
    return onMac('A design review has screenshots and files to look at. Review it on your Mac.')
  if (request.kind === 'note') return onMac('Answer this on your Mac.')
  if (request.simulator || purpose === 'simulator')
    return onMac('Choosing a simulator to shut down needs your Mac.')
  if (request.move || purpose === 'move')
    return onMac('Choosing the Factory to move the Task to needs your Mac.')
  if (request.linearTeam || purpose === 'linear-team' || purpose === 'tracker-group')
    return onMac('Choosing the team needs your Mac.')
  if (
    request.asanaMissing ||
    request.asanaUnfinished ||
    purpose === 'asana-missing' ||
    purpose === 'asana-unfinished'
  )
    return onMac('This Asana question needs your Mac.')
  if (request.archive || purpose === 'archive') {
    if (subject.tasksUnder > 0)
      return onMac('Archiving it would archive the Tasks under it too. Answer on your Mac.')
    if (subject.openPullRequests > 0)
      return onMac('Choosing whether to close its pull requests needs your Mac.')
  }
  if (request.talkRequested || request.talk)
    return onMac('This round is being talked through on your Mac.')
  return { onPhone: true }
}

const read = reader()

function strings(object: JsonObject, field: string): string[] {
  return read.list(object, field).map((value, index) => {
    if (!isString(value)) throw new ParseError(field, `${field}[${index}] must be text`)
    return value
  })
}

function integers(object: JsonObject, field: string): number[] {
  return read.list(object, field).map((value, index) => {
    if (!isInteger(value)) throw new ParseError(field, `${field}[${index}] must be a whole number`)
    return value
  })
}

function optionalTrue(object: JsonObject, field: string): true | undefined {
  const value = read.optional(object, field, read.boolean)
  if (value === false) throw new ParseError(field, `${field} must be true when given`)
  return value
}

export function parsePhoneAnswer(value: Untyped): PhoneAnswer {
  const object = read.object(value, 'answer')
  const action = read.oneOf(object, 'action', [
    'answer',
    'answer-round',
    'approve',
    'deny',
    'request-changes',
  ])
  if (action === 'answer') {
    const choice = read.optional(object, 'choice', read.string)
    const choices = read.optional(object, 'choices', strings)
    const text = read.optional(object, 'text', read.string)
    if (choice !== undefined && choices !== undefined)
      throw new ParseError('choices', 'send choice or choices, not both')
    if (choice === undefined && choices === undefined && text === undefined)
      throw new ParseError('answer', 'an answer needs a choice, choices or text')
    return {
      action,
      ...(choice !== undefined && { choice }),
      ...(choices !== undefined && { choices }),
      ...(text !== undefined && { text }),
    }
  }
  if (action === 'answer-round') {
    return {
      action,
      answers: read.list(object, 'answers').map((entry, index) => {
        const answer = read.object(entry, `answers[${index}]`)
        const choices = read.optional(answer, 'choices', strings)
        return {
          answer: read.string(answer, 'answer'),
          ...(choices !== undefined && { choices }),
        }
      }),
    }
  }
  if (action === 'request-changes') return { action, text: read.string(object, 'text') }
  return { action }
}

function parseRequestTask(value: Json): PhoneRequestTask {
  const object = read.object(value, 'task')
  return {
    id: read.string(object, 'id'),
    priority: read.oneOf(object, 'priority', priorities),
    actions: read.list(object, 'actions').map((action) => {
      if (isOneOf(action, phoneTaskActions)) return action
      throw new ParseError(
        'task.actions',
        `task.actions must hold only ${phoneTaskActions.join(', ')}`,
      )
    }),
  }
}

function parseSummaryFields(object: JsonObject): PhoneRequestSummary {
  const ref = read.optional(object, 'ref', read.string)
  const failed = optionalTrue(object, 'failed')
  const task = object.task === undefined ? undefined : parseRequestTask(object.task)
  return {
    id: read.string(object, 'id'),
    source: read.oneOf(object, 'source', phoneRequestSources),
    kind: read.oneOf(object, 'kind', phoneRequestKinds),
    factory: read.string(object, 'factory'),
    title: read.string(object, 'title'),
    ...(ref !== undefined && { ref }),
    headline: read.string(object, 'headline'),
    createdAt: read.string(object, 'createdAt'),
    ...(failed !== undefined && { failed }),
    onPhone: read.boolean(object, 'onPhone'),
    ...(task !== undefined && { task }),
  }
}

export function parsePhoneRequestSummary(value: Untyped): PhoneRequestSummary {
  return parseSummaryFields(read.object(value, 'request'))
}

function parseRoundQuestion(value: Json, index: number): PhoneRoundQuestion {
  const object = read.object(value, `questions[${index}]`)
  const choices = read.optional(object, 'choices', strings)
  const multiple = optionalTrue(object, 'multiple')
  const recommendedChoices = read.optional(object, 'recommendedChoices', strings)
  return {
    question: read.string(object, 'question'),
    ...(choices !== undefined && { choices }),
    ...(multiple !== undefined && { multiple }),
    recommended: read.string(object, 'recommended'),
    ...(recommendedChoices !== undefined && { recommendedChoices }),
  }
}

function parseProposalRow(value: Json, index: number): PhoneProposalRow {
  const object = read.object(value, `rows[${index}]`)
  return {
    title: read.string(object, 'title'),
    scope: read.string(object, 'scope'),
    priority: read.oneOf(object, 'priority', priorities),
    blockedBy: integers(object, 'blockedBy'),
  }
}

export function parsePhoneForm(value: Untyped): PhoneForm {
  const object = read.object(value, 'form')
  const type = read.oneOf(object, 'type', [
    'choices',
    'text',
    'round',
    'permission',
    'signoff',
    'proposal',
    'mac',
  ])
  switch (type) {
    case 'choices':
      return {
        type,
        choices: strings(object, 'choices'),
        multiple: read.boolean(object, 'multiple'),
        text: read.boolean(object, 'text'),
      }
    case 'text':
      return { type }
    case 'round': {
      const questions = read.list(object, 'questions')
      return { type, questions: questions.map(parseRoundQuestion) }
    }
    case 'permission':
      return { type, command: read.string(object, 'command'), cut: read.boolean(object, 'cut') }
    case 'signoff':
      return {
        type,
        stage: read.string(object, 'stage'),
        brief: read.string(object, 'brief'),
        cut: read.boolean(object, 'cut'),
      }
    case 'proposal': {
      const rows = read.list(object, 'rows')
      return {
        type,
        title: read.string(object, 'title'),
        summary: read.string(object, 'summary'),
        rows: rows.map(parseProposalRow),
      }
    }
    case 'mac':
      return { type, reason: read.string(object, 'reason') }
  }
}

export function parsePhoneRequestDetail(value: Untyped): PhoneRequestDetail {
  const object = read.object(value, 'request')
  return {
    ...parseSummaryFields(object),
    body: read.string(object, 'body'),
    cut: read.boolean(object, 'cut'),
    attachments: read.integer(object, 'attachments'),
    form: parsePhoneForm(object.form),
  }
}

export function parsePhoneRequestsBody(value: Untyped): PhoneRequestsBody {
  const object = read.object(value, 'body')
  return {
    requests: read.list(object, 'requests').map(parsePhoneRequestSummary),
    more: read.integer(object, 'more'),
  }
}

export function parsePhoneRequestBody(value: Untyped): PhoneRequestBody {
  const object = read.object(value, 'body')
  return { request: parsePhoneRequestDetail(object.request) }
}

export function parsePhoneAnsweredBody(value: Untyped): PhoneAnsweredBody {
  const object = read.object(value, 'body')
  if (read.boolean(object, 'answered') !== true)
    throw new ParseError('answered', 'answered must be true')
  return { answered: true }
}
