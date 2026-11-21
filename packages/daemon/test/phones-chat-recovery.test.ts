import { randomBytes } from 'node:crypto'
import path from 'node:path'
import {
  type Factory,
  type MacReply,
  parsePhoneChatCreatedBody,
  readDaemonInfo,
  toBase64Url,
} from '@ted/protocol'
import { expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/daemon.ts'
import type { TedStore } from '../src/store/index.ts'
import {
  api,
  appClient,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
} from './helpers.ts'
import { memoryKeyrings, type PhoneBody, startRelayStub, TestPhone } from './support/phone-relay.ts'

const createId = () => toBase64Url(randomBytes(16))

function body(reply: MacReply) {
  if (!reply.ok)
    throw new Error(`Phone action refused: ${reply.error.code} ${reply.error.message ?? ''}`)
  return reply.body
}

test('phone chat actions survive a daemon restart before the action returns to the relay', async () => {
  const { home, cleanup } = await makeTempHome()
  const relay = await startRelayStub()
  const keys = memoryKeyrings()
  let daemon: RunningDaemon | undefined
  let store: TedStore | undefined
  let phone: TestPhone | undefined
  let pauseReplies = false
  const committed: string[] = []
  const lostReply = new Promise<never>(() => {})
  const opened = () => {
    if (!store) throw new Error('No open store')
    return store
  }

  async function afterCommit<T extends { id: string }>(outcome: T): Promise<T> {
    if (!pauseReplies) return outcome
    await opened().persisted()
    committed.push(outcome.id)
    return lostReply
  }

  async function start() {
    const running = await startDaemon({
      home,
      version: '9.9.9',
      phones: {
        keyrings: keys.keyrings,
        relayUrl: relay.url,
        macName: async () => 'Chat recovery Mac',
        relayDelaysMs: [50],
      },
      wrap: {
        store(value) {
          store = value
          return value
        },
        coordinators: (chats) => ({
          ...chats,
          start: async (...args) => afterCommit(await chats.start(...args)),
          message: async (...args) => afterCommit(await chats.message(...args)),
        }),
        plans: (plans) => ({
          ...plans,
          start: async (...args) => afterCommit(await plans.start(...args)),
          resume: async (...args) => afterCommit(await plans.resume(...args)),
        }),
      },
    })
    daemon = running
    const info = await readDaemonInfo(home)
    if (!info) throw new Error('No daemon.json')
    return appClient(info, running.appToken)
  }

  try {
    const scratch = path.join(home, 'fixture')
    const repo = await makeOriginRepo(scratch)
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': 'version: 1\nlead: { agent: claude }\nplanner: { agent: claude }\n',
    })
    const client = await start()
    if (!daemon) throw new Error('No running daemon')
    const http = api(daemon.port, { appKey: daemon.appToken })
    const response = await http.call('POST', '/dev/factories', { repo, key: 'NB' })
    expect(response.status).toBeLessThan(300)
    const factory = response.body as Factory
    opened().pauseAgent('claude', 'Keep chat Runs queued for the restart trial')
    opened().pauseAgent('codex', 'Keep chat Runs queued for the restart trial')

    const offer = await client.createPhonePairing()
    const paired = new TestPhone(offer.link)
    phone = paired
    await paired.pair('Restart trial')
    await client.approvePhonePairing({ pairing: paired.link.pairing })
    await paired.approved()

    const create = (agentId: string, text: string) =>
      ({
        type: 'request',
        route: 'chat-create',
        factory: factory.key,
        agentId,
        text,
        createId: createId(),
      }) as const
    const send = (chatKind: 'coordinator' | 'plan', chatId: string, text: string) =>
      ({
        type: 'request',
        route: 'chat-message',
        chatKind,
        chatId,
        text,
        createId: createId(),
      }) as const
    const coordinator = parsePhoneChatCreatedBody(
      body(await paired.send(create('coordinator', 'Existing chat'))),
    ).chat
    const plan = parsePhoneChatCreatedBody(
      body(await paired.send(create('planner', 'Existing plan'))),
    ).chat
    expect(await client.stopPlan(plan.id)).toMatchObject({ canResume: true })

    pauseReplies = true
    async function commitWithoutReply(request: PhoneBody) {
      const count = committed.length
      await paired.sendRaw(paired.message(request).envelope)
      await expect.poll(() => committed.length).toBe(count + 1)
      return committed[count]
    }

    const message = send('coordinator', coordinator.id, 'Send once')
    const coordinatorCreate = create('coordinator', 'Start once')
    const planCreate = create('planner', 'Plan once')
    const resume = send('plan', plan.id, 'Resume once')
    expect(await commitWithoutReply(message)).toBe(coordinator.id)
    const newChatId = await commitWithoutReply(coordinatorCreate)
    const newPlanId = await commitWithoutReply(planCreate)
    expect(await commitWithoutReply(resume)).toBe(plan.id)

    const readyCount = () =>
      relay.frames.filter((frame) => frame.from === 'relay' && frame.text === '{"t":"ready"}')
        .length
    const beforeRestart = readyCount()
    await daemon.stop()
    daemon = undefined
    pauseReplies = false
    const restarted = await start()
    await expect.poll(readyCount).toBeGreaterThan(beforeRestart)

    expect(body(await paired.send(message))).toEqual({ queued: true })
    expect(body(await paired.send(coordinatorCreate))).toEqual({
      chat: { kind: 'coordinator', id: newChatId },
    })
    expect(body(await paired.send(planCreate))).toEqual({ chat: { kind: 'plan', id: newPlanId } })
    expect(body(await paired.send(resume))).toEqual({ queued: false })

    const chats = await restarted.coordinatorChats(factory.id)
    expect(chats.map((chat) => chat.id).sort()).toEqual([coordinator.id, newChatId].sort())
    const existing = opened().coordinators.get(coordinator.id)
    if (!existing) throw new Error('Original Coordinator chat is missing')
    expect(
      opened()
        .runMessages(existing.runId)
        .map((message) => message.text),
    ).toEqual(['Existing chat', 'Send once'])
    const plans = await restarted.listPlans(factory.id)
    expect(plans.map((plan) => plan.id).sort()).toEqual([plan.id, newPlanId].sort())
    expect(
      opened()
        .runMessages(plan.id)
        .map((message) => message.text),
    ).toEqual(['Resume once'])
  } finally {
    phone?.close()
    await daemon?.stop()
    await relay.close()
    await killRunHosts(home)
    await cleanup()
  }
}, 90_000)
