import type {
  AgentSummary,
  Coordinator,
  Factory,
  PhoneChatAgent,
  PhoneChatChangeRoute,
  PhoneChatKind,
  Plan,
  RunMessage,
  StartPlanRequest,
} from '@ted/protocol'
import {
  phoneChatAgentDescriptionMax,
  phoneLabelMax,
  phoneReplyBodyMax,
  RequestValidationError,
} from '@ted/protocol'
import { agentDescription, coordinatorStoppable, pickerOrder } from '@ted/protocol/agent-chat-view'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import type { MessageWithFiles } from '../runs/message-files.ts'
import type { PhoneChatSent } from '../store/phones.ts'
import type { Caller } from '../tasks/tasks.ts'
import { planSend } from './chats.ts'
import { cutChars, jsonBytes } from './fit.ts'
import type { PhoneOutcome } from './requests.ts'

type PhoneCaller = Extract<Caller, { kind: 'phone' }>

export interface PhoneChatChanges {
  factories(): readonly Pick<Factory, 'id' | 'key'>[]
  agents(factoryId: string): Promise<AgentSummary[]>
  coordinator(chatId: string): Promise<Coordinator>
  messageCoordinator(chatId: string, message: MessageWithFiles): Promise<Coordinator>
  stopCoordinator(chatId: string): Promise<Coordinator>
  retryCoordinator(chatId: string): Promise<Coordinator>
  archiveCoordinator(chatId: string): Promise<Coordinator>
  unarchiveCoordinator(chatId: string): Promise<Coordinator>
  renameCoordinator(chatId: string, title: string): Promise<Coordinator>
  deleteCoordinator(chatId: string): Promise<void>
  startCoordinator(
    factoryId: string,
    input: { text: string; agentId: string },
  ): Promise<Coordinator>
  plan(planId: string): Promise<Plan>
  sendToRun(runId: string, text: string): Promise<RunMessage>
  resumePlan(planId: string, caller: PhoneCaller, message?: MessageWithFiles): Promise<Plan>
  stopPlan(planId: string, caller: PhoneCaller): Promise<Plan>
  archivePlan(planId: string, caller: PhoneCaller): Promise<Plan>
  unarchivePlan(planId: string, caller: PhoneCaller): Promise<Plan>
  renamePlan(planId: string, title: string, caller: PhoneCaller): Promise<Plan>
  deletePlan(planId: string, caller: PhoneCaller): Promise<void>
  startPlan(input: StartPlanRequest, caller: PhoneCaller): Promise<Plan>
}

export interface PhoneChatSends {
  chatSent(phoneId: string, createId: string): PhoneChatSent | undefined
  markChatSent(sent: PhoneChatSent): void
  persisted(): Promise<void>
}

export interface PhoneChatMessageInput {
  chatKind: PhoneChatKind
  chatId: string
  text: string
  createId: string
}

export interface PhoneChatCreateInput {
  factory: string
  agentId: string
  text: string
  createId: string
}

export interface PhoneChatActions {
  message(caller: PhoneCaller, input: PhoneChatMessageInput): Promise<PhoneOutcome>
  stop(caller: PhoneCaller, kind: PhoneChatKind, chatId: string): Promise<PhoneOutcome>
  change(
    caller: PhoneCaller,
    kind: PhoneChatKind,
    chatId: string,
    route: PhoneChatChangeRoute,
    title: string | undefined,
  ): Promise<PhoneOutcome>
  agents(factory: string): Promise<PhoneOutcome>
  create(caller: PhoneCaller, input: PhoneChatCreateInput): Promise<PhoneOutcome>
}

type Sent = Pick<PhoneChatSent, 'chatKind' | 'chatId' | 'queued'>

const plannerId = 'planner'

async function guarded<T>(
  work: () => Promise<T>,
  gone: () => boolean,
  doing: string,
): Promise<T | PhoneOutcome> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof RequestError && error.status === 404 && gone()) return { code: 'gone' }
    if (error instanceof RequestError || error instanceof RequestValidationError) {
      return { code: 'refused', message: redactSecrets(error.message) }
    }
    console.error(redactSecrets(`a phone couldn’t ${doing}: ${String(error)}`))
    return { code: 'refused' }
  }
}

const always = () => true

function messageReply(sent: Sent): PhoneOutcome {
  return { body: { queued: sent.queued } }
}

function createReply(sent: Sent): PhoneOutcome {
  return { body: { chat: { kind: sent.chatKind, id: sent.chatId } } }
}

export function createPhoneChatActions(
  changes: PhoneChatChanges,
  sends: PhoneChatSends,
): PhoneChatActions {
  const running = new Map<string, Promise<PhoneOutcome>>()

  function once(
    caller: PhoneCaller,
    createId: string,
    action: PhoneChatSent['action'],
    work: () => Promise<Sent | PhoneOutcome>,
  ): Promise<PhoneOutcome> {
    const key = JSON.stringify([caller.phoneId, createId])
    const pending = running.get(key)
    if (pending) return pending
    const reply = action === 'message' ? messageReply : createReply
    const run = async (): Promise<PhoneOutcome> => {
      const earlier = sends.chatSent(caller.phoneId, createId)
      if (earlier) return earlier.action === action ? reply(earlier) : { code: 'bad-request' }
      const result = await work()
      if (!('chatId' in result)) return result
      sends.markChatSent({
        phoneId: caller.phoneId,
        createId,
        action,
        ...result,
        at: new Date().toISOString(),
      })
      await sends.persisted()
      return reply(result)
    }
    const promise = run().finally(() => running.delete(key))
    running.set(key, promise)
    return promise
  }

  const factoryByKey = (key: string) => changes.factories().find((each) => each.key === key)

  function sendToCoordinator(chatId: string, text: string): Promise<Sent | PhoneOutcome> {
    return guarded(
      async (): Promise<Sent> => {
        const before = await changes.coordinator(chatId)
        await changes.messageCoordinator(chatId, { text, files: [] })
        return { chatKind: 'coordinator', chatId, queued: coordinatorStoppable(before) }
      },
      always,
      `send a message to Coordinator chat ${chatId}`,
    )
  }

  function sendToPlan(
    caller: PhoneCaller,
    planId: string,
    text: string,
  ): Promise<Sent | PhoneOutcome> {
    return guarded(
      async (): Promise<Sent | PhoneOutcome> => {
        const plan = await changes.plan(planId)
        const state = planSend(plan)
        if (state.send === 'resume') {
          await changes.resumePlan(planId, caller, { text, files: [] })
          return { chatKind: 'plan', chatId: planId, queued: false }
        }
        if (state.send === 'off' || plan.runId === undefined) {
          return {
            code: 'refused',
            ...(state.offReason !== undefined && { message: state.offReason }),
          }
        }
        const message = await changes.sendToRun(plan.runId, text)
        return { chatKind: 'plan', chatId: planId, queued: message.queued === true }
      },
      always,
      `send a message to planning chat ${planId}`,
    )
  }

  async function stop(
    caller: PhoneCaller,
    kind: PhoneChatKind,
    chatId: string,
  ): Promise<PhoneOutcome> {
    return guarded(
      async (): Promise<PhoneOutcome> => {
        if (kind === 'coordinator') await changes.stopCoordinator(chatId)
        else await changes.stopPlan(chatId, caller)
        return { body: { stopped: true } }
      },
      always,
      `stop ${kind} chat ${chatId}`,
    )
  }

  async function change(
    caller: PhoneCaller,
    kind: PhoneChatKind,
    id: string,
    route: PhoneChatChangeRoute,
    title: string | undefined,
  ): Promise<PhoneOutcome> {
    const coordinator = kind === 'coordinator'
    return guarded(
      async (): Promise<PhoneOutcome> => {
        switch (route) {
          case 'chat-retry':
            await (coordinator ? changes.retryCoordinator(id) : changes.resumePlan(id, caller))
            break
          case 'chat-archive':
            await (coordinator ? changes.archiveCoordinator(id) : changes.archivePlan(id, caller))
            break
          case 'chat-unarchive':
            await (coordinator
              ? changes.unarchiveCoordinator(id)
              : changes.unarchivePlan(id, caller))
            break
          case 'chat-rename':
            if (title === undefined) return { code: 'bad-request' }
            await (coordinator
              ? changes.renameCoordinator(id, title)
              : changes.renamePlan(id, title, caller))
            break
          case 'chat-delete':
            await (coordinator ? changes.deleteCoordinator(id) : changes.deletePlan(id, caller))
            break
        }
        return { body: { changed: true } }
      },
      always,
      `apply ${route} to ${kind} chat ${id}`,
    )
  }

  async function agents(key: string): Promise<PhoneOutcome> {
    const factory = factoryByKey(key)
    if (!factory) return { code: 'gone' }
    const listed = await guarded(
      () => changes.agents(factory.id),
      () => !factoryByKey(key),
      `list the Agents of ${key}`,
    )
    if (!Array.isArray(listed)) return listed
    const shown: PhoneChatAgent[] = []
    for (const agent of pickerOrder(listed)) {
      const entry: PhoneChatAgent = {
        id: agent.id,
        name: cutChars(redactSecrets(agent.name), phoneLabelMax),
        description: cutChars(
          redactSecrets(agentDescription(agent) ?? ''),
          phoneChatAgentDescriptionMax,
        ),
        planner: agent.id === plannerId,
      }
      if (jsonBytes({ agents: [...shown, entry] }) > phoneReplyBodyMax) break
      shown.push(entry)
    }
    return { body: { agents: shown } }
  }

  function startChat(
    caller: PhoneCaller,
    input: PhoneChatCreateInput,
  ): Promise<Sent | PhoneOutcome> {
    const factory = factoryByKey(input.factory)
    if (!factory) return Promise.resolve({ code: 'gone' })
    return guarded(
      async (): Promise<Sent> => {
        if (input.agentId === plannerId) {
          const plan = await changes.startPlan(
            { factory: factory.key, message: input.text },
            caller,
          )
          return { chatKind: 'plan', chatId: plan.id, queued: false }
        }
        const chat = await changes.startCoordinator(factory.id, {
          text: input.text,
          agentId: input.agentId,
        })
        return { chatKind: 'coordinator', chatId: chat.id, queued: false }
      },
      () => !factoryByKey(input.factory),
      `start a chat in ${input.factory}`,
    )
  }

  return {
    message: (caller, input) =>
      once(caller, input.createId, 'message', () =>
        input.chatKind === 'coordinator'
          ? sendToCoordinator(input.chatId, input.text)
          : sendToPlan(caller, input.chatId, input.text),
      ),
    stop,
    change,
    agents,
    create: (caller, input) =>
      once(caller, input.createId, 'create', () => startChat(caller, input)),
  }
}
