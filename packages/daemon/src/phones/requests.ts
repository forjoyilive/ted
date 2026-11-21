import {
  type AnswerAutomationRequest,
  type AnswerRequest,
  archiveChoice,
  type Comment,
  type Factory,
  type PhoneAnswer,
  type PhoneAnswerability,
  type PhoneErrorCode,
  type PhoneFactoryIcon,
  type PhoneForm,
  type PhoneReplyBody,
  type PhoneRequestDetail,
  type PhoneRequestKind,
  type PhoneRequestSummary,
  type PlanRequest,
  type Proposal,
  phoneAnswerability,
  phoneHeadlineMax,
  phoneReplyBodyMax,
  RequestValidationError,
  type Round,
  type Task,
  type TaskBrief,
  validateFailureChoices,
  type WaitingRequest,
} from '@ted/protocol'
import { answerKind } from '@ted/protocol/task'
import { AnswerSavedError, RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import type { TedStore } from '../store/index.ts'
import { stageTitle } from '../workflow/workflow.ts'
import { cutChars, fitText, jsonBytes, textBytes } from './fit.ts'
import { type PhoneIconFactory, phoneFactoryIcons } from './icons.ts'

export interface PhoneAutomationQuestion {
  body: string
  choices?: string[]
}

export interface PhoneInbox {
  waiting(): WaitingRequest[]
  read: {
    factories(): PhoneInboxFactory[]
    comment(id: string): Comment | undefined
    task(id: string): Task | undefined
    tasksUnder(taskId: string): number
    brief(taskId: string): TaskBrief | undefined
    planRequest(id: string): PlanRequest | undefined
    automationQuestion(id: string): PhoneAutomationQuestion | undefined
  }
  answer: {
    task(id: string, answer: AnswerRequest): Promise<void>
    plan(id: string, answer: AnswerRequest): Promise<void>
    automation(id: string, answer: AnswerAutomationRequest): Promise<void>
  }
}

export type PhoneInboxFactory = PhoneIconFactory & Pick<Factory, 'name'>

interface FactoryShown {
  name: string
  icon: PhoneFactoryIcon | undefined
}

export function storeInbox(store: TedStore, answer: PhoneInbox['answer']): PhoneInbox {
  const tasksUnder = (rootId: string): number => {
    const seen = new Set<string>([rootId])
    const next = [...store.childrenOf(rootId)]
    let count = 0
    while (next.length > 0) {
      const id = next.pop() ?? ''
      if (seen.has(id)) continue
      seen.add(id)
      if (store.getTask(id)?.archived === undefined) count += 1
      next.push(...store.childrenOf(id))
    }
    return count
  }
  return {
    waiting: () => store.waiting(),
    read: {
      factories: () => store.listFactories(),
      comment: (id) => store.getComment(id),
      task: (id) => store.getTask(id),
      tasksUnder,
      brief: (taskId) => store.latestBrief(taskId),
      planRequest: (id) => store.plans.request(id),
      automationQuestion: (id) => {
        const comment = store.automations.comment(id)
        return comment?.kind === 'question' ? comment : undefined
      },
    },
    answer,
  }
}

export type PhoneOutcome = { body: PhoneReplyBody } | { code: PhoneErrorCode; message?: string }

const unproposed = { skip: [], startUnblocked: false }

function share(room: number, first: number, second: number): [number, number] {
  if (first + second <= room) return [first, second]
  const half = Math.floor(room / 2)
  if (first <= half) return [first, room - first]
  if (second <= half) return [room - second, second]
  return [half, room - half]
}

function wireKind(kind: string): PhoneRequestKind {
  switch (kind) {
    case 'question':
    case 'round':
    case 'permission':
    case 'signoff':
    case 'proposal':
    case 'review':
      return kind
    default:
      return 'request'
  }
}

export function commentRequestKind(comment: Pick<Comment, 'kind' | 'gate'>): PhoneRequestKind {
  return comment.gate !== undefined && comment.kind !== 'review'
    ? 'signoff'
    : wireKind(comment.kind)
}

function openPullRequests(task: Task | undefined): number {
  return (task?.repos ?? []).filter(
    (repo) =>
      repo.pullRequest !== undefined &&
      repo.pullRequest.state !== 'closed' &&
      repo.pullRequest.state !== 'merged',
  ).length
}

function roundForm(round: Round | undefined): PhoneForm {
  return {
    type: 'round',
    questions: (round?.questions ?? []).map((question) => ({
      question: question.question,
      ...(question.choices !== undefined && { choices: question.choices }),
      ...(question.multiple === true && { multiple: true as const }),
      recommended: question.recommended,
      ...(question.recommendedChoices !== undefined && {
        recommendedChoices: question.recommendedChoices,
      }),
    })),
  }
}

function proposalForm(title: string, summary: string, proposal: Proposal | undefined): PhoneForm {
  return {
    type: 'proposal',
    title,
    summary,
    rows: (proposal?.rows ?? []).map((row) => ({
      title: row.title,
      scope: row.scope,
      priority: row.priority,
      blockedBy: row.blockedBy,
    })),
  }
}

function onMacOr(answerability: PhoneAnswerability, form: () => PhoneForm): PhoneForm {
  return answerability.onPhone ? form() : { type: 'mac', reason: answerability.reason }
}

function choicesForm(choices: readonly string[], multiple: boolean, text: boolean): PhoneForm {
  const offered = choices.filter((choice) => choice !== validateFailureChoices.repair)
  return offered.length === 0
    ? { type: 'text' }
    : { type: 'choices', choices: offered, multiple, text }
}

interface Found {
  summary: PhoneRequestSummary
  answerability: PhoneAnswerability
  body: string
  attachments: number
  form(): PhoneForm
}

export interface PhoneRequests {
  list(): PhoneOutcome
  read(id: string): PhoneOutcome
  answer(id: string, answer: PhoneAnswer): Promise<PhoneOutcome>
}

export function createPhoneRequests(inbox: PhoneInbox): PhoneRequests {
  const { read } = inbox

  function taskAnswerability(comment: Comment): PhoneAnswerability {
    return phoneAnswerability({
      source: 'task',
      request: comment,
      tasksUnder: read.tasksUnder(comment.taskId),
      openPullRequests: openPullRequests(read.task(comment.taskId)),
    })
  }

  function factoryLookup(): (factoryId: string) => FactoryShown {
    const factories = read.factories()
    const icons = phoneFactoryIcons(factories)
    return (factoryId) => ({
      name: factories.find((f) => f.id === factoryId)?.name ?? '',
      icon: icons.get(factoryId),
    })
  }

  function describe(
    waiting: WaitingRequest,
    factoryOf: (factoryId: string) => FactoryShown,
  ): Found | undefined {
    const factory = factoryOf(waiting.factoryId)
    const common = {
      id: waiting.id,
      factory: factory.name,
      factoryId: waiting.factoryId,
      ...(factory.icon !== undefined && { factoryIcon: factory.icon }),
      headline: cutChars(waiting.headline, phoneHeadlineMax),
      createdAt: waiting.createdAt,
    }
    if (waiting.source === 'task') {
      const comment = read.comment(waiting.id)
      if (!comment) return undefined
      const answerability = taskAnswerability(comment)
      const signoff = comment.gate !== undefined && comment.kind !== 'review'
      return {
        summary: {
          ...common,
          source: 'task',
          kind: commentRequestKind(comment),
          title: waiting.taskTitle,
          ref: waiting.displayId,
          ...(waiting.failed && { failed: true as const }),
          onPhone: answerability.onPhone,
        },
        answerability,
        body: comment.body,
        attachments: comment.attachments?.length ?? 0,
        form: () =>
          onMacOr(answerability, () => {
            if (signoff || comment.kind === 'signoff') {
              return {
                type: 'signoff',
                stage: stageTitle(comment.stage ?? read.task(comment.taskId)?.stage ?? ''),
                brief: read.brief(comment.taskId)?.text ?? '',
                cut: false,
              }
            }
            if (comment.kind === 'permission') {
              return { type: 'permission', command: comment.permission?.command ?? '', cut: false }
            }
            if (comment.kind === 'round') return roundForm(comment.round)
            if (comment.kind === 'proposal')
              return proposalForm(comment.title ?? '', comment.body, comment.proposal)
            return choicesForm(
              comment.choices ?? [],
              comment.multiple === true,
              answerKind(comment) !== 'choice-only',
            )
          }),
      }
    }
    if (waiting.source === 'plan') {
      const request = read.planRequest(waiting.id)
      if (!request) return undefined
      const answerability = phoneAnswerability({ source: 'plan', kind: request.kind })
      return {
        summary: {
          ...common,
          source: 'plan',
          kind: wireKind(request.kind),
          title: waiting.planTitle,
          onPhone: answerability.onPhone,
        },
        answerability,
        body: request.body,
        attachments: 0,
        form: () =>
          onMacOr(answerability, () =>
            request.kind === 'round'
              ? roundForm(request.round)
              : proposalForm(request.title ?? '', request.body, request.proposal),
          ),
      }
    }
    if (waiting.source === 'automation') {
      const question = read.automationQuestion(waiting.id)
      if (!question) return undefined
      const answerability = phoneAnswerability({ source: 'automation' })
      return {
        summary: {
          ...common,
          source: 'automation',
          kind: 'question',
          title: waiting.automationName,
          onPhone: answerability.onPhone,
        },
        answerability,
        body: question.body,
        attachments: 0,
        form: () => onMacOr(answerability, () => choicesForm(question.choices ?? [], false, true)),
      }
    }
    const answerability = phoneAnswerability({ source: 'chat' })
    return {
      summary: {
        ...common,
        source: 'chat',
        kind: wireKind(waiting.requestKind ?? 'request'),
        title: waiting.chatTitle,
        onPhone: answerability.onPhone,
      },
      answerability,
      body: waiting.headline,
      attachments: 0,
      form: () => onMacOr(answerability, () => ({ type: 'text' })),
    }
  }

  function newestFirst(): WaitingRequest[] {
    return [...inbox.waiting()].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    )
  }

  function find(id: string): { waiting: WaitingRequest; found: Found } | undefined {
    const waiting = inbox.waiting().find((request) => request.id === id)
    const found = waiting && describe(waiting, factoryLookup())
    return waiting && found && { waiting, found }
  }

  function detail(found: Found): PhoneRequestDetail {
    const form = found.form()
    const whole: PhoneRequestDetail = {
      ...found.summary,
      body: found.body,
      cut: false,
      attachments: found.attachments,
      form,
    }
    if (jsonBytes({ request: whole }) <= phoneReplyBodyMax) return whole
    const extra =
      form.type === 'signoff' ? form.brief : form.type === 'permission' ? form.command : ''
    const bare: PhoneRequestDetail = {
      ...whole,
      body: '',
      cut: false,
      form:
        form.type === 'signoff'
          ? { ...form, brief: '', cut: false }
          : form.type === 'permission'
            ? { ...form, command: '', cut: false }
            : form,
    }
    const room = Math.max(0, phoneReplyBodyMax - jsonBytes({ request: bare }))
    const [bodyRoom, extraRoom] =
      form.type === 'permission'
        ? [Math.max(0, room - Math.min(textBytes(extra), room)), Math.min(textBytes(extra), room)]
        : share(room, textBytes(found.body), textBytes(extra))
    const body = fitText(found.body, bodyRoom)
    const rest = fitText(extra, extraRoom)
    const fitted: PhoneRequestDetail = {
      ...whole,
      body: body.text,
      cut: body.cut,
      form:
        form.type === 'signoff'
          ? { ...form, brief: rest.text, cut: rest.cut }
          : form.type === 'permission'
            ? { ...form, command: rest.text, cut: rest.cut }
            : form,
    }
    if (jsonBytes({ request: fitted }) <= phoneReplyBodyMax) return fitted
    const onMac: PhoneRequestDetail = {
      ...whole,
      body: '',
      cut: false,
      form: {
        type: 'mac',
        reason: 'This request is too long to answer on your phone. Answer it on your Mac.',
      },
    }
    const left = fitText(found.body, Math.max(0, phoneReplyBodyMax - jsonBytes({ request: onMac })))
    return { ...onMac, body: left.text, cut: left.cut }
  }

  function taskAnswer(comment: Comment, answer: PhoneAnswer): AnswerRequest {
    switch (answer.action) {
      case 'answer':
        return {
          ...answer,
          ...(comment.archive !== undefined &&
            answer.choice === archiveChoice && { archive: { closePullRequests: false } }),
        }
      case 'approve':
        return comment.kind === 'proposal' ? { action: 'approve', proposal: unproposed } : answer
      default:
        return answer
    }
  }

  function planAnswer(request: PlanRequest, answer: PhoneAnswer): AnswerRequest {
    return answer.action === 'approve' && request.kind === 'proposal'
      ? { action: 'approve', proposal: unproposed }
      : answer
  }

  function automationAnswer(answer: PhoneAnswer): AnswerAutomationRequest {
    if (answer.action !== 'answer' || answer.choices !== undefined) {
      throw new RequestError(400, 'Answer this question with one choice or your own words.')
    }
    return {
      ...(answer.choice !== undefined && { choice: answer.choice }),
      ...(answer.text !== undefined && { text: answer.text }),
    }
  }

  async function send(waiting: WaitingRequest, answer: PhoneAnswer): Promise<void> {
    if (waiting.source === 'task') {
      const comment = read.comment(waiting.id)
      if (!comment) throw new RequestError(404, 'This request is gone.')
      return inbox.answer.task(waiting.id, taskAnswer(comment, answer))
    }
    if (waiting.source === 'plan') {
      const request = read.planRequest(waiting.id)
      if (!request) throw new RequestError(404, 'This request is gone.')
      return inbox.answer.plan(waiting.id, planAnswer(request, answer))
    }
    if (waiting.source === 'automation') {
      return inbox.answer.automation(waiting.id, automationAnswer(answer))
    }
    throw new RequestError(403, 'Requests from Coordinator chats are answered on your Mac.')
  }

  return {
    list(): PhoneOutcome {
      const factoryOf = factoryLookup()
      const all = newestFirst().flatMap((waiting) => {
        const found = describe(waiting, factoryOf)
        return found ? [found.summary] : []
      })
      const requests: PhoneRequestSummary[] = []
      let size = jsonBytes({ requests: [], more: all.length })
      for (const summary of all) {
        const next = jsonBytes(summary) + (requests.length > 0 ? 1 : 0)
        if (size + next > phoneReplyBodyMax) break
        requests.push(summary)
        size += next
      }
      return { body: { requests, more: all.length - requests.length } }
    },
    read(id: string): PhoneOutcome {
      const match = find(id)
      if (!match) return { code: 'gone' }
      return { body: { request: detail(match.found) } }
    },
    async answer(id: string, answer: PhoneAnswer): Promise<PhoneOutcome> {
      const match = find(id)
      if (!match) return { code: 'gone' }
      if (!match.found.answerability.onPhone) return { code: 'answer-on-mac' }
      try {
        await send(match.waiting, answer)
      } catch (error) {
        if (error instanceof AnswerSavedError) {
          return { code: 'refused', message: redactSecrets(error.message) }
        }
        if (!find(id)) return { code: 'gone' }
        if (error instanceof RequestError || error instanceof RequestValidationError) {
          return { code: 'refused', message: redactSecrets(error.message) }
        }
        console.error(redactSecrets(`a phone answer failed: ${String(error)}`))
        return { code: 'refused' }
      }
      return { body: { answered: true } }
    },
  }
}
