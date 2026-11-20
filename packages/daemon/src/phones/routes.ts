import type { Edition, PhoneProblemsBody, PhoneRequest, PhoneRouteName } from '@ted/protocol'
import { phoneProtocolVersion } from '@ted/protocol'
import type { Caller } from '../tasks/tasks.ts'
import type { PhoneActions } from './actions.ts'
import type { PhoneOutcome, PhoneRequests } from './requests.ts'
import type { PhoneTasks } from './tasks.ts'

export type PhoneCaller = Extract<Caller, { kind: 'phone' }>

export type PhoneRouteRequest = Extract<PhoneRequest, { type: 'request' }>

export interface PhoneRouteContext {
  macName(): Promise<string>
  edition: Edition
  version: string
  requests: PhoneRequests
  tasks: PhoneTasks
  actions: PhoneActions
  problems(): PhoneProblemsBody
  setPushToken(phoneId: string, token: string): boolean
}

export interface PhoneRoute {
  name: PhoneRouteName
  handle(
    caller: PhoneCaller,
    request: PhoneRouteRequest,
    context: PhoneRouteContext,
  ): Promise<PhoneOutcome>
}

export const phoneRoutes: readonly PhoneRoute[] = [
  {
    name: 'status',
    async handle(_, __, { macName, edition, version }) {
      return { body: { mac: await macName(), edition, version, protocol: phoneProtocolVersion } }
    },
  },
  {
    name: 'requests',
    async handle(_, __, { requests }) {
      return requests.list()
    },
  },
  {
    name: 'request',
    async handle(_, request, { requests }) {
      if (request.requestId === undefined) return { code: 'bad-request' }
      return requests.read(request.requestId)
    },
  },
  {
    name: 'answer',
    async handle(_, request, { requests }) {
      if (request.requestId === undefined || request.answer === undefined)
        return { code: 'bad-request' }
      return requests.answer(request.requestId, request.answer)
    },
  },
  {
    name: 'push-token',
    async handle({ phoneId }, request, { setPushToken }) {
      if (request.token === undefined) return { code: 'bad-request' }
      if (!setPushToken(phoneId, request.token)) return { code: 'not-paired' }
      return { body: {} }
    },
  },
  {
    name: 'problems',
    async handle(_, __, { problems }) {
      return { body: problems() }
    },
  },
  {
    name: 'tasks',
    async handle(_, request, { tasks }) {
      return tasks.list(request.group ?? 'status', request.cursor)
    },
  },
  {
    name: 'task',
    async handle(_, request, { tasks }) {
      if (request.taskId === undefined) return { code: 'bad-request' }
      return tasks.read(request.taskId)
    },
  },
  {
    name: 'task-comments',
    async handle(_, request, { tasks }) {
      if (request.taskId === undefined) return { code: 'bad-request' }
      return tasks.comments(request.taskId, request.cursor)
    },
  },
  {
    name: 'task-start',
    async handle(_, request, { actions }) {
      if (request.taskId === undefined) return { code: 'bad-request' }
      return actions.start(request.taskId)
    },
  },
  {
    name: 'task-stop',
    async handle(_, request, { actions }) {
      if (request.taskId === undefined) return { code: 'bad-request' }
      return actions.stop(request.taskId)
    },
  },
  {
    name: 'task-resume',
    async handle(_, request, { actions }) {
      if (request.taskId === undefined) return { code: 'bad-request' }
      return actions.resume(request.taskId, request.text)
    },
  },
  {
    name: 'task-priority',
    async handle(_, request, { actions }) {
      if (request.taskId === undefined || request.priority === undefined)
        return { code: 'bad-request' }
      return actions.setPriority(request.taskId, request.priority)
    },
  },
  {
    name: 'task-comment',
    async handle(caller, request, { actions }) {
      if (request.taskId === undefined || request.text === undefined) return { code: 'bad-request' }
      return actions.comment(caller, request.taskId, request.text)
    },
  },
  {
    name: 'task-archive',
    async handle(_, { taskId, hierarchyRevision, closePullRequests, children }, { actions }) {
      if (
        taskId === undefined ||
        hierarchyRevision === undefined ||
        closePullRequests === undefined ||
        children === 'delete' ||
        children === 'unparent'
      )
        return { code: 'bad-request' }
      return actions.archive(taskId, hierarchyRevision, {
        closePullRequests,
        ...(children !== undefined && { children }),
      })
    },
  },
  {
    name: 'task-delete',
    async handle(_, { taskId, hierarchyRevision, children }, { actions }) {
      if (
        taskId === undefined ||
        hierarchyRevision === undefined ||
        children === 'archive' ||
        children === 'detach'
      )
        return { code: 'bad-request' }
      return actions.delete(taskId, hierarchyRevision, {
        ...(children !== undefined && { children }),
      })
    },
  },
]
