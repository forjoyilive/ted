import type { ChatRequestKind } from './chat-agent.ts'
import type { Json, JsonObject } from './parse.ts'
import { isInteger, isOneOf, isString, ParseError, reader, type Untyped } from './parse.ts'
import {
  type PhoneApproval,
  type PhoneApprovalAnswer,
  parsePhoneApproval,
  parsePhoneApprovalAnswer,
} from './phone-approvals.ts'
import { type PhoneFactoryIcon, parsePhoneFactoryIcon } from './phone-factory-icon.ts'
import { type PhoneImage, parsePhoneImage } from './phone-images.ts'
import { type PhoneTaskAction, phoneTaskActions } from './phone-tasks.ts'
import type { PlanRequestKind } from './plan.ts'
import { type Comment, type Priority, priorities } from './task.ts'
import type { snoozePresetIds } from './time.ts'

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

export type PhoneSnooze = (typeof snoozePresetIds)[number] | 'clear'

export interface PhoneSnoozeBody {
  snoozedUntil: string | null
}

export interface PhoneRequestSummary {
  id: string
  source: PhoneRequestSource
  kind: PhoneRequestKind
  factory: string
  factoryId: string
  factoryIcon?: PhoneFactoryIcon
  title: string
  ref?: string
  headline: string
  createdAt: string
  snoozedUntil?: string
  failed?: true
  onPhone: boolean
  agentName?: string
  approvalChatId?: string
  macReason?: string
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

export interface PhoneDesignFile {
  name: string
  caption?: string
}

export interface PhoneSetupCheck {
  name: string
  command: string
  repo?: string
  passed: boolean
  seconds: number
  reason?: string
}

export interface PhoneSetupApp {
  name: string
  kind: string
  run?: string
  repo?: string
  passed: boolean
  reason?: string
}

export interface PhoneSetupWorktree {
  repo?: string
  step: 'setup' | 'teardown'
  access: string[]
}

export interface PhoneSetup {
  workflow?: { stage: string; setting?: string }[]
  checks?: PhoneSetupCheck[]
  apps?: PhoneSetupApp[]
  agents?: { name: string; about: string }[]
  worktree?: PhoneSetupWorktree[]
  files?: { path: string; about: string }[]
  defaults?: string
}

export interface PhoneFigmaLink {
  url: string
  label?: string
}

export interface PhoneDesign {
  summary?: string
  worthYourEye?: string[]
  screenshots?: PhoneImage[]
  moreScreenshots?: number
  figma?: PhoneFigmaLink
  prototype?: PhoneDesignFile
  video?: PhoneDesignFile
  setup?: PhoneSetup
}

export type PhoneForm =
  | { type: 'approval'; approval: PhoneApproval }
  | { type: 'choices'; choices: string[]; multiple: boolean; text: boolean }
  | { type: 'text' }
  | { type: 'round'; questions: PhoneRoundQuestion[] }
  | { type: 'permission'; command: string; cut: boolean }
  | { type: 'signoff'; stage: string; brief: string; cut: boolean }
  | { type: 'design'; stage: string; brief: string; cut: boolean; design: PhoneDesign }
  | { type: 'proposal'; title: string; summary: string; rows: PhoneProposalRow[] }
  | { type: 'mac'; reason: string }

export interface PhoneContextFile {
  attachment: string
  name: string
}

export interface PhoneContextNote {
  id: string
  body: string
  cut: boolean
  images: PhoneImage[]
  files: PhoneContextFile[]
}

export interface PhoneRequestDetail extends PhoneRequestSummary {
  body: string
  cut: boolean
  attachments: number
  images?: PhoneImage[]
  context?: PhoneContextNote[]
  moreContext?: number
  moreImages?: number
  form: PhoneForm
}

export interface PhoneRoundAnswer {
  answer: string
  choices?: string[]
}

export type PhoneAnswer =
  | PhoneApprovalAnswer
  | { action: 'answer'; choice?: string; choices?: string[]; text?: string }
  | { action: 'answer-round'; answers: PhoneRoundAnswer[] }
  | { action: 'approve' }
  | { action: 'deny' }
  | { action: 'request-changes'; text: string }

export interface PhoneRequestsBody {
  canSnooze?: true
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
  | { source: 'chat'; kind?: ChatRequestKind | 'automation' | 'confirmation' }

export type PhoneAnswerability = { onPhone: true } | { onPhone: false; reason: string }

const onMac = (reason: string): PhoneAnswerability => ({ onPhone: false, reason })

export function phoneAnswerability(subject: PhoneAnswerSubject): PhoneAnswerability {
  if (subject.source === 'chat') {
    switch (subject.kind) {
      case 'question':
      case 'round':
      case 'proposal':
      case 'confirmation':
      case 'outside-command':
        return { onPhone: true }
      case 'agent':
      case 'automation':
        return onMac('Review this on your Mac.')
      default:
        return onMac('Answer this on your Mac.')
    }
  }
  if (subject.source === 'automation') return { onPhone: true }
  if (subject.source === 'plan') {
    return subject.kind === 'question' || subject.kind === 'round' || subject.kind === 'proposal'
      ? { onPhone: true }
      : onMac('Answer this on your Mac.')
  }
  const { request } = subject
  const purpose = request.purpose?.kind
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
    'confirm-tasks',
    'approve-command',
    'stop-command',
  ])
  if (action === 'confirm-tasks' || action === 'approve-command' || action === 'stop-command')
    return parsePhoneApprovalAnswer(object, action)
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

function optionalTextFields(
  object: JsonObject,
): Pick<PhoneRequestSummary, 'agentName' | 'macReason' | 'approvalChatId'> {
  const agentName = read.optional(object, 'agentName', read.string)
  const macReason = read.optional(object, 'macReason', read.string)
  const approvalChatId = read.optional(object, 'approvalChatId', read.string)
  return {
    ...(agentName !== undefined && { agentName }),
    ...(macReason !== undefined && { macReason }),
    ...(approvalChatId !== undefined && { approvalChatId }),
  }
}

function parseSummaryFields(object: JsonObject): PhoneRequestSummary {
  const ref = read.optional(object, 'ref', read.string)
  const failed = optionalTrue(object, 'failed')
  const snoozedUntil = read.optional(object, 'snoozedUntil', read.string)
  const task = object.task === undefined ? undefined : parseRequestTask(object.task)
  const factoryIcon =
    object.factoryIcon === undefined ? undefined : parsePhoneFactoryIcon(object.factoryIcon)
  return {
    id: read.string(object, 'id'),
    source: read.oneOf(object, 'source', phoneRequestSources),
    kind: read.oneOf(object, 'kind', phoneRequestKinds),
    factory: read.string(object, 'factory'),
    factoryId: read.string(object, 'factoryId'),
    ...(factoryIcon !== undefined && { factoryIcon }),
    title: read.string(object, 'title'),
    ...(ref !== undefined && { ref }),
    headline: read.string(object, 'headline'),
    createdAt: read.string(object, 'createdAt'),
    ...(failed !== undefined && { failed }),
    ...(snoozedUntil !== undefined && { snoozedUntil }),
    onPhone: read.boolean(object, 'onPhone'),
    ...optionalTextFields(object),
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
    'approval',
    'choices',
    'text',
    'round',
    'permission',
    'signoff',
    'design',
    'proposal',
    'mac',
  ])
  switch (type) {
    case 'approval':
      return { type, approval: parsePhoneApproval(object.approval) }
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
    case 'design':
      return {
        type,
        stage: read.string(object, 'stage'),
        brief: read.string(object, 'brief'),
        cut: read.boolean(object, 'cut'),
        design: parsePhoneDesign(object.design),
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

function text(object: JsonObject, field: string): string | undefined {
  return read.optional(object, field, read.string)
}

function optionalList<T>(
  object: JsonObject,
  field: string,
  each: (value: Json, index: number) => T,
): T[] | undefined {
  return read.optional(object, field, (o, f) => read.list(o, f).map(each))
}

function parseDesignFile(value: Json | undefined, field: string): PhoneDesignFile {
  const object = read.object(value, field)
  const caption = text(object, 'caption')
  return { name: read.string(object, 'name'), ...(caption !== undefined && { caption }) }
}

function parseSetupCheck(value: Json): PhoneSetupCheck {
  const check = read.object(value, 'checks')
  const repo = text(check, 'repo')
  const reason = text(check, 'reason')
  return {
    name: read.string(check, 'name'),
    command: read.string(check, 'command'),
    ...(repo !== undefined && { repo }),
    passed: read.boolean(check, 'passed'),
    seconds: read.integer(check, 'seconds'),
    ...(reason !== undefined && { reason }),
  }
}

function parseSetupApp(value: Json): PhoneSetupApp {
  const app = read.object(value, 'apps')
  const run = text(app, 'run')
  const repo = text(app, 'repo')
  const reason = text(app, 'reason')
  return {
    name: read.string(app, 'name'),
    kind: read.string(app, 'kind'),
    ...(run !== undefined && { run }),
    ...(repo !== undefined && { repo }),
    passed: read.boolean(app, 'passed'),
    ...(reason !== undefined && { reason }),
  }
}

function parseSetupWorktree(value: Json): PhoneSetupWorktree {
  const line = read.object(value, 'worktree')
  const repo = text(line, 'repo')
  return {
    ...(repo !== undefined && { repo }),
    step: read.oneOf(line, 'step', ['setup', 'teardown'] as const),
    access: strings(line, 'access'),
  }
}

function parseSetup(value: Json | undefined): PhoneSetup {
  const object = read.object(value, 'setup')
  const workflow = optionalList(object, 'workflow', (entry) => {
    const line = read.object(entry, 'workflow')
    const setting = text(line, 'setting')
    return { stage: read.string(line, 'stage'), ...(setting !== undefined && { setting }) }
  })
  const checks = optionalList(object, 'checks', parseSetupCheck)
  const apps = optionalList(object, 'apps', parseSetupApp)
  const agents = optionalList(object, 'agents', (entry) => {
    const agent = read.object(entry, 'agents')
    return { name: read.string(agent, 'name'), about: read.string(agent, 'about') }
  })
  const worktree = optionalList(object, 'worktree', parseSetupWorktree)
  const files = optionalList(object, 'files', (entry) => {
    const file = read.object(entry, 'files')
    return { path: read.string(file, 'path'), about: read.string(file, 'about') }
  })
  const defaults = text(object, 'defaults')
  return {
    ...(workflow !== undefined && { workflow }),
    ...(checks !== undefined && { checks }),
    ...(apps !== undefined && { apps }),
    ...(agents !== undefined && { agents }),
    ...(worktree !== undefined && { worktree }),
    ...(files !== undefined && { files }),
    ...(defaults !== undefined && { defaults }),
  }
}

function parseFigma(value: Json | undefined): PhoneFigmaLink {
  const link = read.object(value, 'figma')
  const label = text(link, 'label')
  return { url: read.string(link, 'url'), ...(label !== undefined && { label }) }
}

function parsePhoneDesign(value: Json | undefined): PhoneDesign {
  const object = read.object(value, 'design')
  const summary = text(object, 'summary')
  const worthYourEye = read.optional(object, 'worthYourEye', strings)
  const screenshots = optionalList(object, 'screenshots', (entry) =>
    parsePhoneImage(entry, 'screenshots'),
  )
  const moreScreenshots = read.optional(object, 'moreScreenshots', read.integer)
  const figma = object.figma === undefined ? undefined : parseFigma(object.figma)
  const prototype =
    object.prototype === undefined ? undefined : parseDesignFile(object.prototype, 'prototype')
  const video = object.video === undefined ? undefined : parseDesignFile(object.video, 'video')
  const setup = object.setup === undefined ? undefined : parseSetup(object.setup)
  return {
    ...(summary !== undefined && { summary }),
    ...(worthYourEye !== undefined && { worthYourEye }),
    ...(screenshots !== undefined && { screenshots }),
    ...(moreScreenshots !== undefined && { moreScreenshots }),
    ...(figma !== undefined && { figma }),
    ...(prototype !== undefined && { prototype }),
    ...(video !== undefined && { video }),
    ...(setup !== undefined && { setup }),
  }
}

export function parsePhoneRequestDetail(value: Untyped): PhoneRequestDetail {
  const object = read.object(value, 'request')
  const moreContext = read.optional(object, 'moreContext', read.integer)
  const context = optionalList(object, 'context', (entry) => {
    const note = read.object(entry, 'context')
    return {
      id: read.string(note, 'id'),
      body: read.string(note, 'body'),
      cut: read.boolean(note, 'cut'),
      images: read.list(note, 'images').map((image) => parsePhoneImage(image)),
      files: read.list(note, 'files').map((entry) => {
        const file = read.object(entry, 'files')
        return { attachment: read.string(file, 'attachment'), name: read.string(file, 'name') }
      }),
    }
  })
  const moreImages = read.optional(object, 'moreImages', read.integer)
  const images = optionalList(object, 'images', (entry) => parsePhoneImage(entry, 'images'))
  return {
    ...parseSummaryFields(object),
    body: read.string(object, 'body'),
    cut: read.boolean(object, 'cut'),
    attachments: read.integer(object, 'attachments'),
    ...(images !== undefined && { images }),
    ...(moreImages !== undefined && { moreImages }),
    ...(context !== undefined && { context }),
    ...(moreContext !== undefined && { moreContext }),
    form: parsePhoneForm(object.form),
  }
}

export function parsePhoneRequestsBody(value: Untyped): PhoneRequestsBody {
  const object = read.object(value, 'body')
  return {
    ...(optionalTrue(object, 'canSnooze') && { canSnooze: true as const }),
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
