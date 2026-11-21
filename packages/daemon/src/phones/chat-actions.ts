import type {
  AgentSummary,
  Coordinator,
  Factory,
  PhoneChatAgent,
  PhoneChatKind,
  Plan,
  StartPlanRequest,
} from '@ted/protocol'
import {
  phoneChatAgentDescriptionMax,
  phoneLabelMax,
  phoneReplyBodyMax,
  RequestValidationError,
} from '@ted/protocol'
import { agentDescription, pickerOrder } from '@ted/protocol/agent-chat-view'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import type { MessageWithFiles } from '../runs/message-files.ts'
import type { PhoneChatRetry, PhoneChatSent } from '../store/phones.ts'
import type { Caller } from '../tasks/tasks.ts'
import { planSend } from './chats.ts'
import { cutChars, jsonBytes } from './fit.ts'
import type { PhoneOutcome } from './requests.ts'

type PhoneCaller = Extract<Caller, { kind: 'phone' }>

export interface PhoneChatChanges {
  factories(): readonly Pick<Factory, 'id' | 'key'>[]
  agents(factoryId: string): Promise<AgentSummary[]>
  messageCoordinator(
    chatId: string,
    message: MessageWithFiles,
    retry: PhoneChatRetry,
  ): Promise<Coordinator>
  stopCoordinator(chatId: string): Promise<Coordinator>
  startCoordinator(
    factoryId: string,
    input: { text: string; agentId: string },
    retry: PhoneChatRetry,
  ): Promise<Coordinator>
  plan(planId: string): Promise<Plan>
  sendToRun(planId: string, runId: string, text: string, retry: PhoneChatRetry): Promise<void>
  resumePlan(
    planId: string,
    caller: PhoneCaller,
    message: MessageWithFiles,
    retry: PhoneChatRetry,
  ): Promise<Plan>
  stopPlan(planId: string, caller: PhoneCaller): Promise<Plan>
  startPlan(input: StartPlanRequest, caller: PhoneCaller, retry: PhoneChatRetry): Promise<Plan>
}

export interface PhoneChatSends {
  chatSent(phoneId: string, createId: string): PhoneChatSent | undefined
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
  const running = new Map<
    string,
    { action: PhoneChatSent['action']; promise: Promise<PhoneOutcome> }
  >()

  function once(
    caller: PhoneCaller,
    createId: string,
    action: PhoneChatSent['action'],
    work: (retry: PhoneChatRetry) => Promise<undefined | PhoneOutcome>,
  ): Promise<PhoneOutcome> {
    const key = JSON.stringify([caller.phoneId, createId])
    const pending = running.get(key)
    if (pending)
      return pending.action === action ? pending.promise : Promise.resolve({ code: 'bad-request' })
    const reply = action === 'message' ? messageReply : createReply
    const run = async (): Promise<PhoneOutcome> => {
      const earlier = sends.chatSent(caller.phoneId, createId)
      if (earlier) {
        if (earlier.action !== action) return { code: 'bad-request' }
        await sends.persisted()
        return reply(earlier)
      }
      const result = await work({ phoneId: caller.phoneId, createId, action })
      const sent = sends.chatSent(caller.phoneId, createId)
      if (!sent) {
        if (result) return result
        throw new Error('Phone chat action completed without a retry record')
      }
      await sends.persisted()
      return reply(sent)
    }
    const promise = run().finally(() => running.delete(key))
    running.set(key, { action, promise })
    return promise
  }

  const factoryByKey = (key: string) => changes.factories().find((each) => each.key === key)

  function sendToCoordinator(chatId: string, text: string, retry: PhoneChatRetry) {
    return guarded(
      async () => {
        await changes.messageCoordinator(chatId, { text, files: [] }, retry)
        return undefined
      },
      always,
      `send a message to Coordinator chat ${chatId}`,
    )
  }

  function sendToPlan(caller: PhoneCaller, planId: string, text: string, retry: PhoneChatRetry) {
    return guarded(
      async (): Promise<undefined | PhoneOutcome> => {
        const plan = await changes.plan(planId)
        const state = planSend(plan)
        if (state.send === 'resume') {
          await changes.resumePlan(planId, caller, { text, files: [] }, retry)
          return undefined
        }
        if (state.send === 'off' || plan.runId === undefined) {
          return {
            code: 'refused',
            ...(state.offReason !== undefined && { message: state.offReason }),
          }
        }
        await changes.sendToRun(plan.id, plan.runId, text, retry)
        return undefined
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
    retry: PhoneChatRetry,
  ): Promise<undefined | PhoneOutcome> {
    const factory = factoryByKey(input.factory)
    if (!factory) return Promise.resolve({ code: 'gone' })
    return guarded(
      async () => {
        if (input.agentId === plannerId) {
          await changes.startPlan({ factory: factory.key, message: input.text }, caller, retry)
          return undefined
        }
        await changes.startCoordinator(
          factory.id,
          { text: input.text, agentId: input.agentId },
          retry,
        )
        return undefined
      },
      () => !factoryByKey(input.factory),
      `start a chat in ${input.factory}`,
    )
  }

  return {
    message: (caller, input) =>
      once(caller, input.createId, 'message', (retry) =>
        input.chatKind === 'coordinator'
          ? sendToCoordinator(input.chatId, input.text, retry)
          : sendToPlan(caller, input.chatId, input.text, retry),
      ),
    stop,
    agents,
    create: (caller, input) =>
      once(caller, input.createId, 'create', (retry) => startChat(caller, input, retry)),
  }
}
