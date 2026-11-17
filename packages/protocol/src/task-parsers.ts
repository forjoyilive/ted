import { stripVTControlCharacters } from 'node:util'
import {
  type DeclaredSendBackCause,
  declaredSendBackCauses,
  type FindingSeverity,
  findingSeverities,
  type RunChecksRequest,
} from './checks.ts'
import { maxCommitBody } from './commit-title.ts'
import { proposalCycle } from './proposal.ts'
import { agentKindList } from './run.ts'
import { parseRemovedAgents, parseSetupAgents } from './setup-agents.ts'
import { isHoldingStage, isStageId } from './stage.ts'
import type {
  ArchiveTaskRequest,
  AttachmentRef,
  DeleteTaskRequest,
  DesignFileInput,
  DesignFileSpec,
  DesignReviewInput,
  LocalDesignReviewInput,
  MoveTaskRequest,
  PullRequestAdvice,
  ReportCleanupStepRequest,
  ReportOutcomeRequest,
  RequestArchiveRequest,
  SaveTaskDraftRequest,
  SetPriorityRequest,
  SetPullRequestTitleRequest,
  SetTaskParentRequest,
  UnarchiveTaskRequest,
} from './task.ts'
import {
  type AgentStageId,
  type AnswerRequest,
  type AnswerTedStopsRequest,
  agentStageIds,
  type BlockedChoice,
  type BlockTaskRequest,
  blockedChoices,
  type CancelMergeRequest,
  type CloseRoundRequest,
  type CreateTaskRequest,
  clarifyDepths,
  cleanupStepResults,
  type EditTaskRequest,
  type FollowUpRequest,
  joinChoices,
  type MarkDoneRequest,
  maxTedStopAnswers,
  type NewTaskDraft,
  type PostCommentRequest,
  type ProposalChoice,
  type ProposalInput,
  type ProposalRowInput,
  priorities,
  type ResumeTaskRequest,
  type RoundInput,
  type RoundQuestion,
  type SetActivityRequest,
  type SetClarifyDepthRequest,
  type SetTaskReposRequest,
  type SetupProposal,
  type SizeCheckInput,
  type StageId,
  type StartTaskRequest,
  type TalkThroughRequest,
  type TaskLead,
  type ValidateJudgments,
  type WriteBriefRequest,
} from './task.ts'
import type { SetTaskGatesRequest, TaskGateOverrides } from './task-gates.ts'
import { agentChoice, bodyObject, RequestValidationError as HttpError } from './validation.ts'

export function parseStartTaskRequest(value: unknown): StartTaskRequest {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new HttpError(400, 'a start request must be an object')
  const { prepare } = value as Record<string, unknown>
  if (prepare !== undefined && typeof prepare !== 'boolean')
    throw new HttpError(400, 'prepare must be true or false')
  return prepare === undefined ? {} : { prepare }
}

const maxRepoRefs = 20

export function parseSetTaskReposRequest(body: unknown): SetTaskReposRequest {
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

export function parseTaskLead(body: unknown, name?: string): TaskLead {
  const { agent, ...rest } = agentChoice(body, name)
  if (agent === undefined) {
    throw new HttpError(
      400,
      `${name === undefined ? '' : `${name}.`}agent must be ${agentKindList}`,
    )
  }
  const mode = (body as Record<string, unknown>).effortMode
  if (mode !== undefined && mode !== 'stage') throw new HttpError(400, 'effortMode must be stage')
  return { agent, ...rest, ...(mode === 'stage' && { effortMode: mode }) }
}

export function parseCreateTaskRequest(body: unknown): CreateTaskRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'a Task must be an object')
  }
  const request = body as Record<keyof CreateTaskRequest, unknown>
  const text = (
    name: 'title' | 'description' | 'factory' | 'source' | 'followUp' | 'draftRevision' | 'parent',
  ) => {
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

  const draftRevision = text('draftRevision')
  const title = text('title')
  const description = text('description')
  const factory = text('factory')
  const source = sourceUrl(text('source'))
  const followUp = text('followUp')?.trim() || undefined
  const parent = text('parent')?.trim() || undefined
  const sentryId = sentryShortId(request.sentryId, source)
  const priority = oneOf('priority', request.priority, priorities)
  const clarifyDepth = oneOf('clarifyDepth', request.clarifyDepth, clarifyDepths)
  const lead = request.lead === undefined ? undefined : parseTaskLead(request.lead, 'lead')
  const blockedBy = list('blockedBy', request.blockedBy)?.map((ref) => {
    if (typeof ref !== 'string') throw new HttpError(400, 'blockedBy must list Task IDs')
    return ref
  })
  const attached = parseAttachmentRefs(request.attachments)
  if (request.start !== undefined && typeof request.start !== 'boolean') {
    throw new HttpError(400, 'start must be true or false')
  }
  if (request.startInBackground !== undefined && typeof request.startInBackground !== 'boolean') {
    throw new HttpError(400, 'startInBackground must be true or false')
  }
  if (request.child !== undefined && typeof request.child !== 'boolean') {
    throw new HttpError(400, 'child must be true or false')
  }
  return {
    ...(draftRevision !== undefined && { draftRevision }),
    ...(title !== undefined && { title }),
    ...(description !== undefined && { description }),
    ...(factory !== undefined && { factory }),
    ...(priority !== undefined && { priority }),
    ...(clarifyDepth !== undefined && { clarifyDepth }),
    ...(lead !== undefined && { lead }),
    ...(blockedBy !== undefined && { blockedBy }),
    ...(parent !== undefined && { parent }),
    ...(request.child !== undefined && { child: request.child }),
    ...(attached.length > 0 && { attachments: attached }),
    ...(source !== undefined && { source }),
    ...(followUp !== undefined && { followUp }),
    ...(sentryId !== undefined && { sentryId }),
    ...(request.start !== undefined && { start: request.start }),
    ...(request.startInBackground !== undefined && {
      startInBackground: request.startInBackground,
    }),
  }
}

function sentryShortId(value: unknown, source: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^[A-Z0-9][A-Z0-9_-]{0,62}-[A-Z0-9]{1,12}$/i.test(value)) {
    throw new HttpError(400, 'sentryId must be a Sentry short ID, such as NOTEBOOK-1A')
  }
  if (source === undefined) throw new HttpError(400, 'sentryId needs a source')
  return value.toUpperCase()
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

const maxChoiceLength = 1000

const maxTitleLength = 200

function choiceList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((c) => typeof c !== 'string')) {
    throw new HttpError(400, 'choices must be a list of strings')
  }
  const choices = (value as string[]).map(choiceText).filter((c) => c !== '')
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

const maxRoundQuestionLength = 4000

const maxRecommendedLength = 2000

export function parseRoundInput(value: unknown): RoundInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'a round must be an object')
  }
  const { title, summary, questions } = value as Record<string, unknown>
  const heading = typeof title === 'string' ? oneLine(title) : ''
  if (heading === '') throw new HttpError(400, 'a round needs a title')
  if ([...heading].length > maxTitleLength) {
    throw new HttpError(400, `a round’s title is limited to ${maxTitleLength} characters`)
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
  const { question, choices, recommended, recommendedChoices, multiple } = (item ?? {}) as Record<
    string,
    unknown
  >
  const text = typeof question === 'string' ? question.trim() : ''
  if (text === '') throw new HttpError(400, `question ${number} needs its question`)
  if ([...text].length > maxRoundQuestionLength) {
    throw new HttpError(
      400,
      `question ${number} is limited to ${maxRoundQuestionLength} characters`,
    )
  }
  const options = choiceList(choices)
  const several = multipleFlag(multiple, `question ${number}’s multiple`)
  if (several) {
    if (!options) throw new HttpError(400, `question ${number} needs choices to allow several`)
    const picks = recommendedList(recommendedChoices ?? recommended, number)
    if (picks.some((p) => !options.includes(p))) {
      throw new HttpError(
        400,
        `question ${number}’s recommended answers must each be one of its choices`,
      )
    }
    return {
      question: text,
      choices: options,
      recommended: joinChoices(picks),
      multiple: true,
      recommendedChoices: picks,
    }
  }
  const given = typeof recommended === 'string' ? recommended : ''
  const pick = options ? choiceText(given) : given.trim()
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

function recommendedList(value: unknown, number: number): string[] {
  const given = typeof value === 'string' ? [value] : value
  if (!Array.isArray(given) || given.some((c) => typeof c !== 'string')) {
    throw new HttpError(400, `question ${number}’s recommended answers must be a list of choices`)
  }
  const picks = [...new Set((given as string[]).map(choiceText).filter((c) => c !== ''))]
  if (picks.length === 0) {
    throw new HttpError(400, `question ${number} needs at least one recommended answer`)
  }
  return picks
}

function multipleFlag(value: unknown, name: string): boolean {
  if (value === undefined || value === false) return false
  if (value === true) return true
  throw new HttpError(400, `${name} must be true or false`)
}

function choicePicks(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((c) => typeof c !== 'string')) {
    throw new HttpError(400, 'choices must be a list of strings')
  }
  if (value.length > maxChoices) {
    throw new HttpError(400, `a question has at most ${maxChoices} choices`)
  }
  return [...new Set(value as string[])]
}

const maxProposalRows = 20

const maxScopeLength = 300

const maxPieceDescriptionLength = 20_000

export function parseProposalInput(value: unknown): ProposalInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'a proposal must be an object')
  }
  const { title, summary, tasks } = value as Record<string, unknown>
  const heading = typeof title === 'string' ? oneLine(title) : ''
  if (heading === '') throw new HttpError(400, 'a proposal needs a title')
  if ([...heading].length > maxTitleLength) {
    throw new HttpError(400, `a proposal’s title is limited to ${maxTitleLength} characters`)
  }
  if (summary !== undefined && typeof summary !== 'string') {
    throw new HttpError(400, 'a proposal’s summary must be text')
  }
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new HttpError(400, 'a proposal needs at least one row in tasks')
  }
  if (tasks.length > maxProposalRows) {
    throw new HttpError(400, `a proposal has at most ${maxProposalRows} rows`)
  }
  const rows = tasks.map((item: unknown, i) => proposalRow(item, i + 1, tasks.length))
  const cycle = proposalCycle(rows.map((r) => r.blockedBy ?? []))
  if (cycle) throw new HttpError(400, `rows ${cycle.join(' → ')} block each other`)
  return {
    title: heading,
    ...(typeof summary === 'string' && summary.trim() !== '' && { summary: summary.trim() }),
    tasks: rows,
  }
}

function proposalRow(item: unknown, row: number, count: number): ProposalRowInput {
  const { title, scope, description, priority, blockedBy } = (item ?? {}) as Record<string, unknown>
  const name = typeof title === 'string' ? oneLine(title) : ''
  if (name === '') throw new HttpError(400, `row ${row} needs a title`)
  if ([...name].length > maxTitleLength) {
    throw new HttpError(400, `row ${row}’s title is limited to ${maxTitleLength} characters`)
  }
  const line = typeof scope === 'string' ? oneLine(scope) : ''
  if (line === '') throw new HttpError(400, `row ${row} needs a one-line scope`)
  if ([...line].length > maxScopeLength) {
    throw new HttpError(400, `row ${row}’s scope is limited to ${maxScopeLength} characters`)
  }
  if (description !== undefined && typeof description !== 'string') {
    throw new HttpError(400, `row ${row}’s description must be text`)
  }
  const details = typeof description === 'string' ? description.trim() : ''
  if (details.length > maxPieceDescriptionLength) {
    throw new HttpError(
      400,
      `row ${row}’s description is limited to ${maxPieceDescriptionLength} characters`,
    )
  }
  const level = priority === undefined ? undefined : priorities.find((p) => p === priority)
  if (priority !== undefined && !level) {
    throw new HttpError(400, `row ${row}’s priority must be ${priorities.join(', ')}`)
  }
  if (
    blockedBy !== undefined &&
    (!Array.isArray(blockedBy) || !blockedBy.every((b) => Number.isInteger(b)))
  ) {
    throw new HttpError(400, `row ${row}’s blockedBy must list row numbers`)
  }
  const blockers = [...new Set((blockedBy ?? []) as number[])]
  for (const blocker of blockers) {
    if (blocker === row) throw new HttpError(400, `row ${row} can’t block itself`)
    if (blocker < 1 || blocker > count) {
      throw new HttpError(
        400,
        `row ${row} is blocked by row ${blocker}, which isn’t in the proposal`,
      )
    }
  }
  return {
    title: name,
    scope: line,
    ...(details !== '' && { description: details }),
    ...(level !== undefined && { priority: level }),
    ...(blockers.length > 0 && { blockedBy: blockers }),
  }
}

const maxSettle = 12

export function parseSizeCheckInput(value: unknown): SizeCheckInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'sizeCheck must be an object')
  }
  const { why, settle } = value as Record<string, unknown>
  const reason = typeof why === 'string' ? why.trim() : ''
  if (reason === '') throw new HttpError(400, 'say why the Task is too big')
  if (reason.length > maxQuestionLength * 4) {
    throw new HttpError(400, `the reason is limited to ${maxQuestionLength * 4} characters`)
  }
  if (!Array.isArray(settle) || !settle.every((s) => typeof s === 'string')) {
    throw new HttpError(400, 'settle must list what a plan needs to settle')
  }
  const points = (settle as string[]).map(oneLine).filter((s) => s !== '')
  if (points.length === 0) throw new HttpError(400, 'say what a plan needs to settle')
  if (points.length > maxSettle) {
    throw new HttpError(400, `list at most ${maxSettle} things a plan needs to settle`)
  }
  if (points.some((p) => [...p].length > maxQuestionLength)) {
    throw new HttpError(400, `each point is limited to ${maxQuestionLength} characters`)
  }
  return { why: reason, settle: points }
}

function proposalChoice(value: unknown): ProposalChoice {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'proposal must be an object')
  }
  const { skip, startUnblocked } = value as Record<string, unknown>
  if (skip !== undefined && (!Array.isArray(skip) || !skip.every((r) => Number.isInteger(r)))) {
    throw new HttpError(400, 'skip must list row numbers')
  }
  if (startUnblocked !== undefined && typeof startUnblocked !== 'boolean') {
    throw new HttpError(400, 'startUnblocked must be true or false')
  }
  return {
    ...(skip !== undefined && { skip: [...new Set(skip as number[])] }),
    ...(startUnblocked !== undefined && { startUnblocked }),
  }
}

export function parseReportOutcomeRequest(body: unknown): ReportOutcomeRequest {
  const request = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const judged = judgments(request.judged)
  if (request.outcome === 'advance') {
    const changes = typeof request.changes === 'string' ? oneLine(request.changes) : ''
    if ([...changes].length > 300) {
      throw new HttpError(400, 'the changes summary is limited to 300 characters')
    }
    const design = request.design === undefined ? undefined : parseDesignReviewInput(request.design)
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
    if (!isStageId(to) || isHoldingStage(to)) {
      throw new HttpError(400, `to must be a Stage id, such as ${agentStageIds.join(', ')}`)
    }
    const findings = typeof request.findings === 'string' ? request.findings.trim() : ''
    if (findings === '') throw new HttpError(400, '`back` needs Findings')
    const cause = request.cause
    if (cause !== undefined && !declaredSendBackCauses.includes(cause as DeclaredSendBackCause)) {
      throw new HttpError(400, `cause must be one of ${declaredSendBackCauses.join(', ')}`)
    }
    const severity = request.severity
    if (severity !== undefined && !findingSeverities.includes(severity as FindingSeverity)) {
      throw new HttpError(400, `severity must be one of ${findingSeverities.join(', ')}`)
    }
    return {
      outcome: 'back',
      to: to as AgentStageId,
      findings,
      ...(judged && { judged }),
      ...(cause !== undefined && { cause: cause as DeclaredSendBackCause }),
      ...(severity !== undefined && { severity: severity as FindingSeverity }),
    }
  }
  if (request.outcome === 'ask') {
    const question = typeof request.question === 'string' ? request.question.trim() : ''
    if (question === '') throw new HttpError(400, 'question is required')
    const choices = choiceList(request.choices)
    const multiple = multipleFlag(request.multiple, 'multiple')
    if (multiple && !choices) throw new HttpError(400, 'a question needs choices to allow several')
    return {
      outcome: 'ask',
      question,
      ...(choices && { choices }),
      ...(multiple && { multiple: true as const }),
    }
  }
  throw new HttpError(400, 'outcome must be advance, back or ask')
}

const maxScreenshots = 12
const maxWorthYourEye = 10

function shortText(value: unknown, what: string, limit: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new HttpError(400, `${what} must be text`)
  const text = oneLine(value)
  if ([...text].length > limit) {
    throw new HttpError(400, `${what} is limited to ${limit} characters`)
  }
  return text === '' ? undefined : text
}

function designFile(value: unknown, role: string): DesignFileInput {
  if (typeof value !== 'object' || value === null) {
    throw new HttpError(400, `the ${role} needs a hash and a name`)
  }
  const { hash, name, mediaType, caption } = value as Record<string, unknown>
  if (typeof hash !== 'string' || typeof name !== 'string') {
    throw new HttpError(400, `the ${role} needs a hash and a name`)
  }
  const text = shortText(caption, `the ${role}’s caption`, 80)
  return {
    hash,
    name,
    mediaType: typeof mediaType === 'string' ? mediaType : '',
    ...(text !== undefined && { caption: text }),
  }
}

function figmaLink(value: unknown): DesignReviewInput['figma'] {
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

export function parseDesignReviewInput(value: unknown): DesignReviewInput {
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
  const screenshots = shots.map((shot) => designFile(shot, 'screenshot'))
  const video = input.video === undefined ? undefined : designFile(input.video, 'video')
  const prototype =
    input.prototype === undefined ? undefined : designFile(input.prototype, 'prototype')
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
  const setup = input.setup === undefined ? undefined : setupProposal(input.setup)
  return {
    ...(setup && { setup }),
    ...(title !== undefined && { title }),
    ...(summary !== undefined && summary !== '' && { summary }),
    ...(screenshots.length > 0 && { screenshots }),
    ...(video && { video }),
    ...(prototype && { prototype }),
    ...(figma && { figma }),
    ...(points.length > 0 && { worthYourEye: points }),
  }
}

const maxSetupItems = 40
const setupStages: readonly StageId[] = ['backlog', ...agentStageIds, 'done']

function setupList(value: unknown, what: string): Record<string, unknown>[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new HttpError(400, `the setup proposal’s ${what} must be a list`)
  if (value.length > maxSetupItems) {
    throw new HttpError(400, `the setup proposal lists at most ${maxSetupItems} ${what}`)
  }
  return value.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new HttpError(400, `each of the setup proposal’s ${what} must be an object`)
    }
    return item as Record<string, unknown>
  })
}

function needed(value: unknown, what: string, limit: number): string {
  const text = shortText(value, what, limit)
  if (text === undefined) throw new HttpError(400, `${what} is required`)
  return text
}

function passedFlag(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new HttpError(400, `${what} needs passed: true or false`)
  return value
}

function setupProposal(value: unknown): SetupProposal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'setup must be an object')
  }
  const input = value as Record<string, unknown>
  const workflow = setupList(input.workflow, 'Stages').map((line) => {
    const stage = setupStages.find((id) => id === line.stage)
    if (!stage) throw new HttpError(400, `${String(line.stage)} isn’t a Stage`)
    const setting = shortText(line.setting, `${stage}’s setting`, 200)
    return { stage, ...(setting !== undefined && { setting }) }
  })
  const checks = setupList(input.checks, 'Checks').map((check) => {
    const name = needed(check.name, 'each Check’s name', 80)
    const passed = passedFlag(check.passed, `the Check ${name}`)
    const reason = shortText(check.reason, `${name}’s reason`, 200)
    if (!passed && reason === undefined) {
      throw new HttpError(400, `${name} failed on the default branch; say why in its reason`)
    }
    const durationMs = check.durationMs
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
      throw new HttpError(400, `${name} needs durationMs, the time it took in milliseconds`)
    }
    const repo = shortText(check.repo, `${name}’s repo`, 100)
    return {
      name,
      command: needed(check.command, `${name}’s command`, 300),
      ...(repo !== undefined && { repo }),
      passed,
      durationMs: Math.round(durationMs),
      ...(reason !== undefined && { reason }),
    }
  })
  const apps = setupList(input.apps, 'Apps').map((app) => {
    const name = needed(app.name, 'each App’s name', 80)
    const passed = passedFlag(app.passed, `the App ${name}`)
    const reason = shortText(app.reason, `${name}’s reason`, 200)
    if (!passed && reason === undefined) {
      throw new HttpError(400, `${name} didn’t start on the default branch; say why in its reason`)
    }
    const repo = shortText(app.repo, `${name}’s repo`, 100)
    return {
      name,
      ...(repo !== undefined && { repo }),
      kind: needed(app.kind, `${name}’s kind`, 40),
      run: needed(app.run, `${name}’s run command`, 300),
      ready: needed(app.ready, `how ${name} became ready`, 200),
      passed,
      ...(reason !== undefined && { reason }),
    }
  })
  const agents = input.agents === undefined ? undefined : parseSetupAgents(input.agents, badRequest)
  const files = setupList(input.files, 'files').map((file) => {
    const where = needed(file.path, 'each file’s path', 200)
    if (!/^\.ted\/[A-Za-z0-9._/-]+$/.test(where) || where.includes('..')) {
      throw new HttpError(400, `${where} isn’t a file in .ted/`)
    }
    return { path: where, about: needed(file.about, `what ${where} holds`, 300) }
  })
  if (files.length === 0) {
    throw new HttpError(400, 'the setup proposal names the files it will write')
  }
  const defaults = shortText(input.defaults, 'the line on what stays at TED’s defaults', 300)
  return {
    workflow,
    checks,
    apps,
    ...(agents !== undefined && agents.length > 0 && { agents }),
    files,
    ...(defaults !== undefined && { defaults }),
  }
}

function badRequest(message: string): never {
  throw new HttpError(400, message)
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

export function parseAnswerRequest(body: unknown): AnswerRequest {
  const request = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const text = typeof request.text === 'string' ? request.text : undefined
  if (request.text !== undefined && text === undefined) {
    throw new HttpError(400, 'text must be a string')
  }
  if (request.action === 'approve') {
    if (request.simulator !== undefined && typeof request.simulator !== 'string') {
      throw new HttpError(400, 'simulator must name a simulator')
    }
    return {
      action: 'approve',
      ...(text !== undefined && { text }),
      ...(request.proposal !== undefined && { proposal: proposalChoice(request.proposal) }),
      ...(typeof request.simulator === 'string' && { simulator: request.simulator }),
      ...(request.removeAgents !== undefined && {
        removeAgents: parseRemovedAgents(request.removeAgents, badRequest),
      }),
    }
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
    const picks = choicePicks(request.choices)
    return {
      action: 'answer',
      ...(typeof request.choice === 'string' && { choice: request.choice }),
      ...(picks && { choices: picks }),
      ...(text !== undefined && { text }),
      ...(request.archive !== undefined && {
        archive: parseArchiveTaskRequest(objectOrNull(request.archive, 'archive')),
      }),
    }
  }
  if (request.action === 'accept-recommended') return { action: 'accept-recommended' }
  if (request.action === 'answer-round') {
    if (!Array.isArray(request.answers)) throw new HttpError(400, 'answers must be a list')
    return {
      action: 'answer-round',
      answers: request.answers.map((item: unknown) => {
        const { answer, choices, note } = (item ?? {}) as Record<string, unknown>
        if (typeof answer !== 'string') throw new HttpError(400, 'each answer must be text')
        if (note !== undefined && typeof note !== 'string') {
          throw new HttpError(400, 'a note must be text')
        }
        const picks = choicePicks(choices)
        return {
          answer,
          ...(picks && { choices: picks }),
          ...(typeof note === 'string' && { note }),
        }
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

function choiceText(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      [...line]
        .map((c) => (isControl(c) || /\s/.test(c) ? ' ' : c))
        .join('')
        .replace(/ +/g, ' ')
        .trim(),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
}

const maxAttachmentsPerRequest = 50

export function parseAttachmentRefs(value: unknown): AttachmentRef[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new HttpError(400, 'attachments must be a list')
  if (value.length > maxAttachmentsPerRequest) {
    throw new HttpError(400, `attach at most ${maxAttachmentsPerRequest} files at once`)
  }
  return value.map((item: unknown) => {
    const { hash, name, mediaType } = (item ?? {}) as Record<string, unknown>
    if (typeof hash !== 'string' || typeof name !== 'string') {
      throw new HttpError(400, 'an attachment needs a hash and a name')
    }
    return {
      hash,
      name,
      mediaType: typeof mediaType === 'string' ? mediaType : '',
    }
  })
}

export function parseSaveTaskDraftRequest(body: unknown): SaveTaskDraftRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new HttpError(400, 'a draft must be an object')
  const value = body as Record<string, unknown>
  const text = (key: string): string => {
    if (typeof value[key] !== 'string') throw new HttpError(400, `${key} must be text`)
    return value[key]
  }
  const boolean = (key: string): boolean => {
    if (typeof value[key] !== 'boolean') throw new HttpError(400, `${key} must be true or false`)
    return value[key]
  }
  const list = (key: string): string[] => {
    const given = value[key]
    if (!Array.isArray(given) || given.some((v) => typeof v !== 'string'))
      throw new HttpError(400, `${key} must list text`)
    return given
  }
  const priority = priorities.find((p) => p === value.priority)
  if (!priority) throw new HttpError(400, 'invalid draft priority')
  const clarifyDepth = clarifyDepths.find((d) => d === value.clarifyDepth)
  if (value.clarifyDepth !== undefined && !clarifyDepth)
    throw new HttpError(400, 'invalid draft Clarify depth')
  const filled = value.filled as Record<string, unknown> | undefined
  if (
    !filled ||
    typeof filled !== 'object' ||
    Array.isArray(filled) ||
    (filled.title !== undefined && typeof filled.title !== 'string') ||
    (filled.priority !== undefined && !priorities.some((p) => p === filled.priority))
  ) {
    throw new HttpError(400, 'invalid draft source fields')
  }
  const revision = text('revision')
  if (!revision || revision.length > 100) throw new HttpError(400, 'invalid draft revision')
  return {
    revision,
    title: text('title'),
    description: text('description'),
    priority,
    blockedBy: list('blockedBy'),
    attachments: parseAttachmentRefs(value.attachments),
    start: boolean('start'),
    moreOpen: boolean('moreOpen'),
    dismissed: list('dismissed'),
    filled: {
      ...(typeof filled.title === 'string' && { title: filled.title }),
      ...(filled.priority !== undefined && {
        priority: filled.priority as NewTaskDraft['priority'],
      }),
    },
    ...(value.startChosen !== undefined && { startChosen: boolean('startChosen') }),
    ...(clarifyDepth && { clarifyDepth }),
    ...(value.lead !== undefined && { lead: parseTaskLead(value.lead, 'lead') }),
    ...(value.source !== undefined && { source: sourceUrl(text('source')) }),
    ...(value.parent !== undefined && { parent: text('parent') }),
  }
}

export function parsePostCommentRequest(value: unknown): PostCommentRequest {
  const body = value as Partial<PostCommentRequest> | null
  const text = typeof body?.body === 'string' ? body.body.trim() : ''
  const round = body?.round === undefined ? undefined : parseRoundInput(body.round)
  const proposal = body?.proposal === undefined ? undefined : parseProposalInput(body.proposal)
  const sizeCheck = body?.sizeCheck === undefined ? undefined : parseSizeCheckInput(body.sizeCheck)
  const files = parseAttachmentRefs(body?.attachments)
  if ([round, proposal, sizeCheck].filter((x) => x !== undefined).length > 1) {
    throw new HttpError(400, 'send one of round, proposal or sizeCheck')
  }
  if (text === '' && !round && !proposal && !sizeCheck && files.length === 0) {
    throw new HttpError(400, 'body is required')
  }
  if (
    files.length > 0 &&
    (round ||
      proposal ||
      sizeCheck ||
      body?.choices !== undefined ||
      body?.supersedes !== undefined)
  ) {
    throw new HttpError(400, 'only a note can carry attachments')
  }
  if ((round || proposal || sizeCheck) && body?.choices !== undefined) {
    throw new HttpError(
      400,
      round ? 'a round has its choices on each question' : 'this request has fixed choices',
    )
  }
  const choices = choiceList(body?.choices)
  const multiple = multipleFlag(body?.multiple, 'multiple')
  if (multiple && !choices) throw new HttpError(400, 'a question needs choices to allow several')
  const supersedes = body?.supersedes
  if (supersedes !== undefined && (typeof supersedes !== 'string' || supersedes === '')) {
    throw new HttpError(400, 'supersedes must be a request’s ID')
  }
  return {
    body: text,
    ...(choices && { choices }),
    ...(multiple && { multiple: true as const }),
    ...(round && { round }),
    ...(proposal && { proposal }),
    ...(sizeCheck && { sizeCheck }),
    ...(supersedes !== undefined && { supersedes }),
    ...(files.length > 0 && { attachments: files }),
  }
}

export function parseSetPriorityRequest(value: unknown): SetPriorityRequest {
  const body = value as Record<string, unknown> | null
  const priority = priorities.find((p) => p === body?.priority)
  if (!priority) throw new HttpError(400, `priority must be ${priorities.join(', ')}`)
  return { priority }
}

export function parseMoveTaskRequest(value: unknown): MoveTaskRequest {
  const body = value as Record<string, unknown> | null
  const side = (name: 'after' | 'before') => {
    const value = body?.[name]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') throw new HttpError(400, `${name} must be a Task ID`)
    return value
  }
  const after = side('after')
  const before = side('before')
  return { ...(after !== undefined && { after }), ...(before !== undefined && { before }) }
}

export function parseWriteBriefRequest(value: unknown): WriteBriefRequest {
  const body = value as Partial<WriteBriefRequest> | null
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (text === '') throw new HttpError(400, 'text is required')
  return { text: `${text}\n` }
}

export function parseCloseRoundRequest(value: unknown): CloseRoundRequest {
  const body = value as Partial<CloseRoundRequest> | null
  const summary = typeof body?.summary === 'string' ? body.summary.trim() : ''
  if (summary === '') throw new HttpError(400, 'summary is required')
  return { summary }
}

export function parseSetActivityRequest(value: unknown): SetActivityRequest {
  const body = value as Partial<SetActivityRequest> | null
  const text = typeof body?.text === 'string' ? oneLine(body.text) : ''
  if (text === '') throw new HttpError(400, 'text is required')
  if ([...text].length > maxActivityLength) {
    throw new HttpError(400, `the activity line is limited to ${maxActivityLength} characters`)
  }
  return { text }
}

export function parseRunChecksRequest(value: unknown): RunChecksRequest {
  const body = value as Partial<RunChecksRequest> | null
  const name = typeof body?.name === 'string' ? body.name.trim() : undefined
  return { ...(name !== undefined && name !== '' && { name }) }
}

export function parseBlockTaskRequest(value: unknown): BlockTaskRequest {
  const body = value as Partial<BlockTaskRequest> | null
  const by = typeof body?.by === 'string' ? body.by.trim() : ''
  if (by === '') throw new HttpError(400, 'by is required')
  return { by }
}

function hierarchyRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new HttpError(400, 'hierarchyRevision must come from a current hierarchy read')
  return value
}

export function parseSetTaskParentRequest(value: unknown): SetTaskParentRequest {
  const body = bodyObject(value)
  if (body.parentId !== null && (typeof body.parentId !== 'string' || !body.parentId.trim()))
    throw new HttpError(400, 'parentId must be a Task ID or null')
  const revision = hierarchyRevision(body.revision)
  if (!revision) throw new HttpError(400, 'revision must come from a current hierarchy read')
  return { parentId: body.parentId === null ? null : body.parentId.trim(), revision }
}

export function parseUnarchiveTaskRequest(value: unknown): UnarchiveTaskRequest {
  const body = bodyObject(value ?? {})
  if (body.unlinkParent !== undefined && typeof body.unlinkParent !== 'boolean')
    throw new HttpError(400, 'unlinkParent must be true or false')
  if (body.children !== undefined && body.children !== 'restore')
    throw new HttpError(400, 'children must be restore')
  return {
    ...(body.unlinkParent !== undefined && { unlinkParent: body.unlinkParent }),
    ...(body.children === 'restore' && { children: body.children }),
    ...(body.hierarchyRevision !== undefined && {
      hierarchyRevision: hierarchyRevision(body.hierarchyRevision),
    }),
  }
}

export function parseDeleteTaskRequest(value: unknown): DeleteTaskRequest {
  const body = value as Record<string, unknown> | null
  if (body?.children !== undefined && body.children !== 'delete' && body.children !== 'unparent')
    throw new HttpError(400, 'children must be delete or unparent')
  return {
    blocked: blockedChoice(body),
    ...(body?.children !== undefined && { children: body.children }),
    ...(body?.hierarchyRevision !== undefined && {
      hierarchyRevision: hierarchyRevision(body.hierarchyRevision),
    }),
  }
}

function objectOrNull(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new HttpError(400, `${name} must be an object`)
  return value as Record<string, unknown>
}

const maxArchiveReason = 300

function archiveLine(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be text`)
  const line = oneLine(value)
  if (line === '') throw new HttpError(400, `give ${name}`)
  if (line.length > maxArchiveReason)
    throw new HttpError(400, `${name} must be at most ${maxArchiveReason} characters`)
  return line
}

export function parsePullRequestAdvice(value: unknown): PullRequestAdvice {
  const { recommend, why } = objectOrNull(value, 'pullRequests')
  if (recommend !== 'close' && recommend !== 'keep')
    throw new HttpError(400, 'pullRequests.recommend must be close or keep')
  return { recommend, why: archiveLine(why, 'a reason for the pull request choice') }
}

export function parseRequestArchiveRequest(value: unknown): RequestArchiveRequest {
  const body = objectOrNull(value, 'the request')
  return {
    reason: archiveLine(body.reason, 'a reason'),
    ...(body.pullRequests !== undefined && {
      pullRequests: parsePullRequestAdvice(body.pullRequests),
    }),
  }
}

export const maxCleanupReport = 4000

export function parseReportCleanupStepRequest(value: unknown): ReportCleanupStepRequest {
  const body = objectOrNull(value, 'the request')
  if (typeof body.step !== 'string' || oneLine(body.step) === '')
    throw new HttpError(400, 'give the Cleanup step’s name')
  const result = body.result
  if (typeof result !== 'string' || !(cleanupStepResults as readonly string[]).includes(result))
    throw new HttpError(400, `result must be one of ${cleanupStepResults.join(', ')}`)
  if (typeof body.text !== 'string' || body.text.trim() === '')
    throw new HttpError(400, 'say what happened in the step')
  const text = body.text.trim()
  if (text.length > maxCleanupReport)
    throw new HttpError(400, `the report must be at most ${maxCleanupReport} characters`)
  return {
    step: oneLine(body.step),
    result: result as ReportCleanupStepRequest['result'],
    text,
  }
}

export function parseSetPullRequestTitleRequest(value: unknown): SetPullRequestTitleRequest {
  const body = objectOrNull(value, 'the request')
  if (typeof body.title !== 'string' || oneLine(body.title) === '')
    throw new HttpError(400, 'give the pull request’s title')
  if (body.body !== undefined && typeof body.body !== 'string')
    throw new HttpError(400, 'body must be text')
  const text = body.body === undefined ? '' : stripVTControlCharacters(body.body).trim()
  if (text.length > maxCommitBody)
    throw new HttpError(400, `the description must be at most ${maxCommitBody} characters`)
  return { title: oneLine(body.title), ...(text !== '' && { body: text }) }
}

export function parseArchiveTaskRequest(value: unknown): ArchiveTaskRequest {
  const body = value as Record<string, unknown> | null
  const close = body?.closePullRequests
  if (close !== undefined && typeof close !== 'boolean') {
    throw new HttpError(400, 'closePullRequests must be true or false')
  }
  const children = body?.children
  if (children !== undefined && children !== 'archive' && children !== 'detach')
    throw new HttpError(400, 'children must be archive or detach')
  return {
    closePullRequests: close === true,
    ...(children !== undefined && { children }),
    blocked: blockedChoice(body),
    ...(body?.hierarchyRevision !== undefined && {
      hierarchyRevision: hierarchyRevision(body.hierarchyRevision),
    }),
  }
}

export function parseSetTaskGatesRequest(input: unknown): SetTaskGatesRequest {
  const body = input as Record<string, unknown> | null
  const value = body?.overrides
  if (
    typeof body?.revision !== 'string' ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new HttpError(400, 'give a revision and Sign-off overrides')
  }
  const overrides: TaskGateOverrides = {}
  for (const [key, gate] of Object.entries(value)) {
    const stage = isStageId(key) && !isHoldingStage(key) ? key : undefined
    if (!stage || typeof gate !== 'boolean')
      throw new HttpError(400, 'Sign-off overrides must name Stages with boolean values')
    overrides[stage] = gate
  }
  return { overrides, revision: body.revision }
}

export function parseEditTaskRequest(value: unknown): EditTaskRequest {
  const body = value as Partial<EditTaskRequest> | null
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
  return {
    ...(name !== undefined && { title: name }),
    ...(description !== undefined && { description: description.trim() }),
  }
}

export function parseResumeTaskRequest(value: unknown): ResumeTaskRequest {
  const body = value as Partial<ResumeTaskRequest> | null
  const comment = body?.comment
  if (comment !== undefined && typeof comment !== 'string') {
    throw new HttpError(400, 'comment must be text')
  }
  const files = parseAttachmentRefs(body?.attachments)
  return {
    ...(comment !== undefined && { comment }),
    ...(files.length > 0 && { attachments: files }),
  }
}

export function parseAnswerTedStopsRequest(value: unknown): AnswerTedStopsRequest {
  const body = value as Partial<AnswerTedStopsRequest> | null
  const ids = (name: 'restart' | 'leave'): string[] => {
    const list = body?.[name] ?? []
    if (!Array.isArray(list) || list.some((id) => typeof id !== 'string' || id === '')) {
      throw new HttpError(400, `${name} must be a list of Task IDs`)
    }
    return [...new Set(list as string[])]
  }
  const restart = ids('restart')
  const leave = ids('leave')
  if (restart.length + leave.length === 0) {
    throw new HttpError(400, 'name at least one Task to restart or leave stopped')
  }
  if (restart.length + leave.length > maxTedStopAnswers) {
    throw new HttpError(400, `name at most ${maxTedStopAnswers} Tasks`)
  }
  if (leave.some((id) => restart.includes(id))) {
    throw new HttpError(400, 'a Task can’t be both restarted and left stopped')
  }
  return { restart, leave }
}

export function parseFollowUpRequest(value: unknown): FollowUpRequest {
  const body = value as Partial<FollowUpRequest> | null
  const comment = body?.comment
  if (comment !== undefined && typeof comment !== 'string') {
    throw new HttpError(400, 'comment must be text')
  }
  const files = parseAttachmentRefs(body?.attachments)
  return {
    ...(comment !== undefined && { comment }),
    ...(files.length > 0 && { attachments: files }),
  }
}

export function parseCancelMergeRequest(value: unknown): CancelMergeRequest {
  const body = value as Partial<CancelMergeRequest> | null
  const text = typeof body?.comment === 'string' ? body.comment.trim() : ''
  if (text === '') throw new HttpError(400, 'comment is required')
  const files = parseAttachmentRefs(body?.attachments)
  return { comment: text, ...(files.length > 0 && { attachments: files }) }
}

export function parseMarkDoneRequest(value: unknown): MarkDoneRequest {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 0) {
    throw new HttpError(400, 'marking a Task done takes no fields')
  }
  return {}
}

export function parseSetClarifyDepthRequest(value: unknown): SetClarifyDepthRequest {
  const body = value as Partial<SetClarifyDepthRequest> | null
  const depth = clarifyDepths.find((d) => d === body?.depth)
  if (!depth) throw new HttpError(400, `depth must be ${clarifyDepths.join(', ')}`)
  if (body?.why !== undefined && typeof body.why !== 'string') {
    throw new HttpError(400, 'why must be text')
  }
  const why = typeof body?.why === 'string' ? oneLine(body.why) : ''
  if ([...why].length > maxActivityLength) {
    throw new HttpError(400, `the reason is limited to ${maxActivityLength} characters`)
  }
  return { depth, ...(why !== '' && { why }) }
}

const maxActivityLength = 200
function blockedChoice(body: Record<string, unknown> | null): BlockedChoice {
  const value = body?.blocked
  if (value === undefined) return 'unblock'
  const choice = blockedChoices.find((c) => c === value)
  if (!choice) throw new HttpError(400, `blocked must be ${blockedChoices.join(' or ')}`)
  return choice
}

export function parseDesignFileSpec(value: unknown, what: string): DesignFileSpec {
  if (typeof value === 'string') return { path: value }
  const { path: file, caption } = (value ?? {}) as Record<string, unknown>
  if (typeof file !== 'string' || (caption !== undefined && typeof caption !== 'string')) {
    throw new HttpError(400, `the design file’s ${what} needs a path, as text or as { "path": … }`)
  }
  const text = shortText(caption, `the ${what}’s caption`, 80)
  return { path: file, ...(text !== undefined && { caption: text }) }
}

export function parseLocalDesignReviewInput(value: unknown): LocalDesignReviewInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'the design file must hold a JSON object')
  }
  const { screenshots, video, prototype, ...rest } = value as Record<string, unknown>
  if (screenshots !== undefined && !Array.isArray(screenshots)) {
    throw new HttpError(400, 'the design file’s screenshots must be a list')
  }
  const shots = (screenshots as unknown[] | undefined) ?? []
  if (shots.length > maxScreenshots) {
    throw new HttpError(400, `a design review shows at most ${maxScreenshots} screenshots`)
  }
  const common: Omit<DesignReviewInput, 'screenshots' | 'video' | 'prototype'> =
    parseDesignReviewInput(rest)
  return {
    ...common,
    ...(screenshots !== undefined && {
      screenshots: shots.map((s) => parseDesignFileSpec(s, 'screenshot')),
    }),
    ...(video !== undefined && { video: parseDesignFileSpec(video, 'video') }),
    ...(prototype !== undefined && { prototype: parseDesignFileSpec(prototype, 'prototype') }),
  }
}

export function parseTalkThroughRequest(value: unknown): TalkThroughRequest {
  const body = value as Partial<TalkThroughRequest> | null
  if (body?.confirmResume !== undefined && typeof body.confirmResume !== 'boolean') {
    throw new HttpError(400, 'confirmResume must be a boolean')
  }
  return body?.confirmResume === undefined ? {} : { confirmResume: body.confirmResume }
}
