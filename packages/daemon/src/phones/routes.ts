import type {
  Edition,
  PhonePlanUsageBody,
  PhoneProblemsBody,
  PhoneRequest,
  PhoneRouteName,
} from '@ted/protocol'
import { phoneChatChangeRoutes, phoneProtocolVersion } from '@ted/protocol'
import { RequestError } from '../errors.ts'
import type { Caller } from '../tasks/tasks.ts'
import type { PhoneActions } from './actions.ts'
import type { PhoneChatActions } from './chat-actions.ts'
import type { PhoneChats } from './chats.ts'
import type { PhoneImages } from './images.ts'
import type { PhoneNewTask } from './new-task.ts'
import type { PhoneOutcome, PhoneRequests } from './requests.ts'
import type { PhoneTasks } from './tasks.ts'
import type { PhoneUploads } from './uploads.ts'

export type PhoneCaller = Extract<Caller, { kind: 'phone' }>

export type PhoneRouteRequest = Extract<PhoneRequest, { type: 'request' }>

export interface PhoneRouteContext {
  macName(): Promise<string>
  edition: Edition
  version: string
  requests: PhoneRequests
  tasks: PhoneTasks
  actions: PhoneActions
  newTask: PhoneNewTask
  uploads: Pick<PhoneUploads, 'part' | 'done'>
  chats: PhoneChats
  chatActions: PhoneChatActions
  images: PhoneImages
  problems(): PhoneProblemsBody
  planUsage(): PhonePlanUsageBody
  dismissProblem(id: string, raisedAt: string): Promise<void>
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

const createTask: PhoneRoute['handle'] = async (
  caller,
  { route, createId, factory, title, description, priority, start, files, overrides },
  { newTask },
) => {
  if (
    createId === undefined ||
    factory === undefined ||
    priority === undefined ||
    start === undefined ||
    (route === 'task-create-with-options' && overrides === undefined)
  ) {
    return { code: 'bad-request' }
  }
  return newTask.create(caller, {
    createId,
    factory,
    ...(title !== undefined && { title }),
    ...(description !== undefined && { description }),
    priority,
    start,
    ...(files !== undefined && { files }),
    ...(overrides !== undefined && { overrides }),
  })
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
    name: 'snoozed-requests',
    async handle(_, __, { requests }) {
      return requests.listSnoozed()
    },
  },
  {
    name: 'request-snooze',
    async handle(_, request, { requests }) {
      if (request.requestId === undefined || request.snooze === undefined)
        return { code: 'bad-request' }
      return requests.snooze(request.requestId, request.snooze)
    },
  },
  {
    name: 'request',
    async handle(_, request, { requests }) {
      if (request.requestId === undefined) return { code: 'bad-request' }
      return requests.read(request.requestId, request.chatId, request.includeSnoozed)
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
    name: 'plan-usage',
    async handle(_, __, { planUsage }) {
      return { body: planUsage() }
    },
  },
  {
    name: 'problem-dismiss',
    async handle(_, { problemId, raisedAt }, { dismissProblem }) {
      if (!problemId || !raisedAt) return { code: 'bad-request' }
      try {
        await dismissProblem(problemId, raisedAt)
        return { body: {} }
      } catch (error) {
        if (error instanceof RequestError) {
          if (error.status === 404) return { code: 'gone' }
          return { code: 'refused', message: 'This problem has changed. Refresh and try again.' }
        }
        throw error
      }
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
    name: 'task-conversation',
    async handle(_, { taskId, cursor }, { tasks }) {
      if (taskId === undefined) return { code: 'bad-request' }
      return tasks.conversation(taskId, cursor)
    },
  },
  {
    name: 'task-conversation-item',
    async handle(_, { taskId, itemId, offset }, { tasks }) {
      if (taskId === undefined || itemId === undefined) return { code: 'bad-request' }
      return tasks.conversationItem(taskId, itemId, offset ?? 0)
    },
  },
  {
    name: 'image',
    async handle(_, request, { images }) {
      if (request.image === undefined || request.part === undefined) return { code: 'bad-request' }
      return images.read(request.image, request.part)
    },
  },
  {
    name: 'context-file',
    async handle(_, { requestId, attachment, part }, { requests, images }) {
      if (requestId === undefined || attachment === undefined || part === undefined) {
        return { code: 'bad-request' }
      }
      const file = requests.contextFile(requestId, attachment)
      return file === undefined ? { code: 'gone' } : images.readAttachment(file, part)
    },
  },
  {
    name: 'design-prototype',
    async handle(_, request, { images }) {
      if (request.prototype === undefined || request.part === undefined) {
        return { code: 'bad-request' }
      }
      return images.readPrototype(request.prototype, request.part)
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
      return actions.comment(caller, request.taskId, request.text, request.files)
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
  {
    name: 'factories',
    async handle(_, __, { newTask }) {
      return newTask.factories()
    },
  },
  { name: 'task-create', handle: createTask },
  { name: 'task-create-with-options', handle: createTask },
  {
    name: 'task-create-options',
    async handle(_, { factory, includePiModels }, { newTask }) {
      if (factory === undefined) return { code: 'bad-request' }
      return newTask.options(factory, includePiModels === true)
    },
  },
  {
    name: 'file-part',
    async handle({ phoneId }, { uploadId, index, data }, { uploads }) {
      if (uploadId === undefined || index === undefined || data === undefined)
        return { code: 'bad-request' }
      return uploads.part(phoneId, uploadId, index, data)
    },
  },
  {
    name: 'file-done',
    async handle({ phoneId }, { uploadId, name, mediaType, size, sha256 }, { uploads }) {
      if (
        uploadId === undefined ||
        name === undefined ||
        mediaType === undefined ||
        size === undefined ||
        sha256 === undefined
      )
        return { code: 'bad-request' }
      return uploads.done(phoneId, { uploadId, name, mediaType, size, sha256 })
    },
  },
  {
    name: 'chats',
    async handle(_, { factoryId, archived, cursor }, { chats }) {
      return chats.list(factoryId, archived ?? false, cursor)
    },
  },
  {
    name: 'chat',
    async handle(_, { chatKind, chatId }, { chats }) {
      if (chatKind === undefined || chatId === undefined) return { code: 'bad-request' }
      return chats.read(chatKind, chatId)
    },
  },
  {
    name: 'chat-items',
    async handle(_, { chatKind, chatId, before }, { chats }) {
      if (chatKind === undefined || chatId === undefined) return { code: 'bad-request' }
      return chats.items(chatKind, chatId, before)
    },
  },
  {
    name: 'chat-item',
    async handle(_, { chatKind, chatId, itemId, offset }, { chats }) {
      if (chatKind === undefined || chatId === undefined || itemId === undefined)
        return { code: 'bad-request' }
      return chats.item(chatKind, chatId, itemId, offset ?? 0)
    },
  },
  {
    name: 'chat-message',
    async handle(caller, { chatKind, chatId, text, createId }, { chatActions }) {
      if (
        chatKind === undefined ||
        chatId === undefined ||
        text === undefined ||
        createId === undefined
      )
        return { code: 'bad-request' }
      return chatActions.message(caller, { chatKind, chatId, text, createId })
    },
  },
  {
    name: 'chat-stop',
    async handle(caller, { chatKind, chatId }, { chatActions }) {
      if (chatKind === undefined || chatId === undefined) return { code: 'bad-request' }
      return chatActions.stop(caller, chatKind, chatId)
    },
  },
  ...phoneChatChangeRoutes.map(
    (name): PhoneRoute => ({
      name,
      async handle(caller, { chatKind, chatId, title }, { chatActions }) {
        if (chatKind === undefined || chatId === undefined) return { code: 'bad-request' }
        return chatActions.change(caller, chatKind, chatId, name, title)
      },
    }),
  ),
  {
    name: 'chat-agents',
    async handle(_, { factory }, { chatActions }) {
      if (factory === undefined) return { code: 'bad-request' }
      return chatActions.agents(factory)
    },
  },
  {
    name: 'chat-create',
    async handle(caller, { factory, agentId, text, createId }, { chatActions }) {
      if (
        factory === undefined ||
        agentId === undefined ||
        text === undefined ||
        createId === undefined
      )
        return { code: 'bad-request' }
      return chatActions.create(caller, { factory, agentId, text, createId })
    },
  },
  {
    name: 'factory-icon',
    async handle(_, { factoryId }, { newTask }) {
      if (factoryId === undefined) return { code: 'bad-request' }
      return newTask.factoryImage(factoryId)
    },
  },
]
