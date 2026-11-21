import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type AgentSummary,
  type ChatAgent,
  type Coordinator,
  type CoordinatorChatSummary,
  type PhoneChatKind,
  type PhoneRequest,
  type Plan,
  type PlanStatus,
  parsePhoneChatAgentsBody,
  parsePhoneChatCreatedBody,
  parsePhoneChatItemsBody,
  parsePhoneChatMessageBody,
  parsePhoneChatsBody,
  phoneChatChangeRoutes,
  type RunChat,
  type RunMessage,
  type StartPlanRequest,
  toBase64Url,
} from '@ted/protocol'
import { afterEach, beforeEach, expect, expectTypeOf, test } from 'vitest'
import { RequestError } from '../src/errors.ts'
import { createPhoneChatActions, type PhoneChatChanges } from '../src/phones/chat-actions.ts'
import { createPhoneChats, type PhoneChatSource } from '../src/phones/chats.ts'
import type { PhoneOutcome } from '../src/phones/requests.ts'
import { type PhoneCaller, type PhoneRouteContext, phoneRoutes } from '../src/phones/routes.ts'
import type { PhonesArea, TedStore } from '../src/store/index.ts'
import { openStore } from '../src/store/open.ts'

expectTypeOf<TedStore>().toExtend<PhonesArea>()

const secret = `ghp_${'a1B2c3D4e5'.repeat(3)}`
const caller: PhoneCaller = { kind: 'phone', phoneId: 'phone-1' }
const header = { protocol: 3, id: 'x', at: 1, type: 'request' } as const

const agent = (id: string, name: string, extra: Partial<ChatAgent> = {}): ChatAgent => ({
  id,
  name,
  source: 'ted',
  powers: [],
  removed: false,
  ...extra,
})

function coordinator(id: string, status: Coordinator['status']): Coordinator {
  return {
    id,
    factoryId: 'notebook',
    runId: `run-${id}`,
    runIds: [`run-${id}`],
    status,
    chatAgent: agent('coordinator', 'Coordinator'),
  } as Coordinator
}

function plan(id: string, status: PlanStatus, extra: Partial<Plan> = {}): Plan {
  return {
    id,
    factoryId: 'notebook',
    factoryKey: 'NB',
    title: `Plan ${id}`,
    message: 'Plan it',
    agent: 'claude',
    status,
    createdAt: '2026-11-01T00:00:00.000Z',
    lastAt: '2026-11-01T00:00:00.000Z',
    createdTasks: 0,
    runId: id,
    chatAgent: agent('planner', 'Planner'),
    ...extra,
  }
}

interface Posted {
  to: string
  text: string
}

interface World {
  coordinators: Map<string, Coordinator>
  plans: Map<string, Plan>
  posted: Posted[]
  stopped: string[]
  started: { factoryId: string; input: { text: string; agentId: string } }[]
  plansStarted: { input: StartPlanRequest; caller: PhoneCaller }[]
  agents: AgentSummary[]
  refuse?: RequestError | undefined
}

function world(): World {
  return {
    coordinators: new Map([
      ['c-idle', coordinator('c-idle', 'ready')],
      ['c-busy', coordinator('c-busy', 'working')],
    ]),
    plans: new Map([
      ['p-live', plan('p-live', 'working')],
      ['p-resumable', plan('p-resumable', 'stopped', { canResume: true })],
      ['p-final', plan('p-final', 'finished', { canResume: false })],
      ['p-archived', plan('p-archived', 'finished', { archivedAt: '2026-11-02T00:00:00.000Z' })],
    ]),
    posted: [],
    stopped: [],
    started: [],
    plansStarted: [],
    agents: [
      agent('reviewer', 'Reviewer', { source: 'factory', description: `Reviews ${secret}` }),
      agent('planner', 'Planner'),
      agent('auditor', 'Auditor', { source: 'library' }),
      agent('coordinator', 'Coordinator'),
    ],
  }
}

const missing = (what: string) => new RequestError(404, `no such ${what}`)

function changes(w: World): PhoneChatChanges {
  const chat = (id: string) => {
    const found = w.coordinators.get(id)
    if (!found) throw missing('Coordinator chat')
    return found
  }
  const planOf = (id: string) => {
    const found = w.plans.get(id)
    if (!found) throw missing('planning chat')
    return found
  }
  const refuse = () => {
    if (w.refuse) throw w.refuse
  }
  return {
    factories: () => [{ id: 'notebook', key: 'NB' }],
    agents: async (factoryId) => {
      if (factoryId !== 'notebook') throw missing('Factory')
      return w.agents
    },
    coordinator: async (id) => chat(id),
    async messageCoordinator(id, message) {
      const found = chat(id)
      refuse()
      w.posted.push({ to: id, text: message.text })
      return found
    },
    async stopCoordinator(id) {
      const found = chat(id)
      w.stopped.push(id)
      return found
    },
    async retryCoordinator(id) {
      refuse()
      const found = chat(id)
      if (found.status !== 'failed') throw new RequestError(409, 'The Coordinator has not failed')
      found.status = 'working'
      return found
    },
    async archiveCoordinator(id) {
      const found = chat(id)
      found.endedAt = '2026-11-03T00:00:00.000Z'
      return found
    },
    async unarchiveCoordinator(id) {
      const found = chat(id)
      delete found.endedAt
      return found
    },
    async renameCoordinator(id, title) {
      const found = chat(id)
      found.title = title
      return found
    },
    async deleteCoordinator(id) {
      w.coordinators.delete(chat(id).id)
    },
    async startCoordinator(factoryId, input) {
      refuse()
      if (input.agentId === 'nobody') throw new RequestError(404, 'This Factory has no Agent')
      w.started.push({ factoryId, input })
      const made = coordinator(`c-new-${w.started.length}`, 'queued')
      w.coordinators.set(made.id, made)
      return made
    },
    plan: async (id) => planOf(id),
    async sendToRun(runId, text) {
      refuse()
      const found = [...w.plans.values()].find((each) => each.runId === runId)
      if (!found) throw missing('Run')
      w.posted.push({ to: found.id, text })
      const queued = found.status === 'working'
      return {
        id: `m${w.posted.length}`,
        runId,
        text,
        at: 'now',
        ...(queued && { queued: true }),
      } satisfies RunMessage
    },
    async resumePlan(id, phone, message) {
      expect(phone).toEqual(caller)
      const found = planOf(id)
      refuse()
      if (message !== undefined) {
        w.posted.push({ to: id, text: message.text })
      } else if (found.canResume === true) {
        found.status = 'working'
        delete found.canResume
      } else {
        throw new RequestError(409, 'only a planning chat whose Run ended can be resumed')
      }
      return found
    },
    async archivePlan(id, phone) {
      expect(phone).toEqual(caller)
      const found = planOf(id)
      found.archivedAt = '2026-11-03T00:00:00.000Z'
      return found
    },
    async unarchivePlan(id, phone) {
      expect(phone).toEqual(caller)
      const found = planOf(id)
      delete found.archivedAt
      return found
    },
    async renamePlan(id, title, phone) {
      expect(phone).toEqual(caller)
      const found = planOf(id)
      found.title = title
      return found
    },
    async deletePlan(id, phone) {
      expect(phone).toEqual(caller)
      w.plans.delete(planOf(id).id)
    },
    async stopPlan(id, phone) {
      expect(phone).toEqual(caller)
      w.stopped.push(planOf(id).id)
      return planOf(id)
    },
    async startPlan(input, phone) {
      refuse()
      w.plansStarted.push({ input, caller: phone })
      const made = plan(`p-new-${w.plansStarted.length}`, 'queued')
      w.plans.set(made.id, made)
      return made
    },
  }
}

let dir: string
let store: TedStore

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-phone-chat-actions-'))
  store = await openStore({ directory: dir })
})

afterEach(async () => {
  await store.close()
  await rm(dir, { recursive: true, force: true })
})

function context(w: World, sends = store.phones): PhoneRouteContext {
  return { chatActions: createPhoneChatActions(changes(w), sends) } as PhoneRouteContext
}

function call(
  ctx: PhoneRouteContext,
  request: Omit<Extract<PhoneRequest, { type: 'request' }>, keyof typeof header>,
): Promise<PhoneOutcome> {
  const route = phoneRoutes.find((each) => each.name === request.route)
  if (!route) throw new Error(`no route ${request.route}`)
  return route.handle(caller, { ...header, ...request }, ctx)
}

function body(outcome: PhoneOutcome) {
  if (!('body' in outcome)) throw new Error(`refused: ${outcome.code} ${outcome.message ?? ''}`)
  return outcome.body
}

const createId = () => toBase64Url(randomBytes(16))

const message = (chatKind: PhoneChatKind, chatId: string, text = 'From the phone') => ({
  route: 'chat-message',
  chatKind,
  chatId,
  text,
  createId: createId(),
})

test('chat-message posts to a Coordinator chat and says whether it waits for the current reply', async () => {
  const w = world()
  const ctx = context(w)
  expect(
    parsePhoneChatMessageBody(body(await call(ctx, message('coordinator', 'c-idle')))),
  ).toEqual({ queued: false })
  expect(
    parsePhoneChatMessageBody(body(await call(ctx, message('coordinator', 'c-busy', 'Also')))),
  ).toEqual({ queued: true })
  expect(w.posted).toEqual([
    { to: 'c-idle', text: 'From the phone' },
    { to: 'c-busy', text: 'Also' },
  ])
})

test('chat-message sends to a live planning chat, resumes an ended one and refuses one that can’t take it', async () => {
  const w = world()
  const ctx = context(w)
  expect(parsePhoneChatMessageBody(body(await call(ctx, message('plan', 'p-live'))))).toEqual({
    queued: true,
  })
  expect(
    parsePhoneChatMessageBody(body(await call(ctx, message('plan', 'p-resumable', 'Go on')))),
  ).toEqual({ queued: false })
  expect(await call(ctx, message('plan', 'p-final'))).toEqual({
    code: 'refused',
    message: 'This planning chat has ended.',
  })
  expect(await call(ctx, message('plan', 'p-archived'))).toEqual({
    code: 'refused',
    message: 'This chat is archived.',
  })
  expect(w.posted).toEqual([
    { to: 'p-live', text: 'From the phone' },
    { to: 'p-resumable', text: 'Go on' },
  ])
})

test('a refusal comes back as refused with a redacted sentence, and an unknown chat as gone', async () => {
  const w = world()
  w.refuse = new RequestError(409, `The Coordinator is stopping ${secret}`)
  const ctx = context(w)
  const refused = await call(ctx, message('coordinator', 'c-idle'))
  expect(refused).toMatchObject({ code: 'refused' })
  expect('message' in refused && refused.message).toContain('The Coordinator is stopping')
  expect(JSON.stringify(refused)).not.toContain(secret)
  expect(await call(ctx, message('coordinator', 'c-missing'))).toEqual({ code: 'gone' })
  expect(await call(ctx, message('plan', 'p-missing'))).toEqual({ code: 'gone' })
  expect(
    await call(ctx, { route: 'chat-stop', chatKind: 'coordinator', chatId: 'c-missing' }),
  ).toEqual({ code: 'gone' })
  expect(await call(ctx, { route: 'chat-stop', chatKind: 'plan', chatId: 'p-missing' })).toEqual({
    code: 'gone',
  })
  expect(w.posted).toEqual([])

  w.refuse = undefined
  const retried = await call(ctx, { ...message('coordinator', 'c-idle'), text: 'Again' })
  expect(body(retried)).toEqual({ queued: false })
})

test('a repeated chat-message createId posts once and returns the first result, even after a restart', async () => {
  const w = world()
  const ctx = context(w)
  const request = message('coordinator', 'c-busy', 'Only once')
  const [first, second] = await Promise.all([call(ctx, request), call(ctx, request)])
  expect(body(first)).toEqual({ queued: true })
  expect(body(second)).toEqual({ queued: true })
  w.coordinators.set('c-busy', coordinator('c-busy', 'ready'))
  expect(body(await call(ctx, { ...request, text: 'Changed on the resend' }))).toEqual({
    queued: true,
  })
  expect(w.posted).toEqual([{ to: 'c-busy', text: 'Only once' }])

  await store.close()
  store = await openStore({ directory: dir })
  const restarted = context(w)
  expect(body(await call(restarted, request))).toEqual({ queued: true })
  expect(w.posted).toEqual([{ to: 'c-busy', text: 'Only once' }])
  expect(store.phones.chatSent(caller.phoneId, request.createId)).toMatchObject({
    action: 'message',
    chatKind: 'coordinator',
    chatId: 'c-busy',
    queued: true,
  })
  expect(
    await call(restarted, {
      route: 'chat-create',
      factory: 'NB',
      agentId: 'coordinator',
      text: 'Same ID, other route',
      createId: request.createId,
    }),
  ).toEqual({ code: 'bad-request' })
})

test('chat-stop stops a Coordinator chat or a planning chat as the phone', async () => {
  const w = world()
  const ctx = context(w)
  expect(
    body(await call(ctx, { route: 'chat-stop', chatKind: 'coordinator', chatId: 'c-busy' })),
  ).toEqual({ stopped: true })
  expect(body(await call(ctx, { route: 'chat-stop', chatKind: 'plan', chatId: 'p-live' }))).toEqual(
    { stopped: true },
  )
  expect(w.stopped).toEqual(['c-busy', 'p-live'])
})

test.each(['coordinator', 'plan'] as const)(
  'the chat management routes change a %s chat as the user',
  async (chatKind) => {
    const w = world()
    const chatId = 'retry-chat'
    const chat = coordinator(chatId, 'failed')
    const planning = plan(chatId, 'failed', { canResume: true })
    w.coordinators.set(chatId, chat)
    w.plans.set(chatId, planning)
    const ctx = context(w)
    const ref = { chatKind, chatId }
    const target = chatKind === 'coordinator' ? chat : planning

    expect(body(await call(ctx, { ...ref, route: 'chat-retry' }))).toEqual({ changed: true })
    expect(target.status).toBe('working')
    expect(w.posted).toEqual([])
    expect(body(await call(ctx, { ...ref, route: 'chat-rename', title: 'New title' }))).toEqual({
      changed: true,
    })
    expect(target.title).toBe('New title')
    expect(await call(ctx, { ...ref, route: 'chat-rename' })).toEqual({ code: 'bad-request' })
    expect(body(await call(ctx, { ...ref, route: 'chat-archive' }))).toEqual({ changed: true })
    const archive = () => (chatKind === 'coordinator' ? chat.endedAt : planning.archivedAt)
    expect(archive()).toBeDefined()
    expect(body(await call(ctx, { ...ref, route: 'chat-unarchive' }))).toEqual({ changed: true })
    expect(archive()).toBeUndefined()
    expect(body(await call(ctx, { ...ref, route: 'chat-delete' }))).toEqual({ changed: true })
    expect(await call(ctx, { ...ref, route: 'chat-delete' })).toEqual({ code: 'gone' })
    expect((chatKind === 'coordinator' ? w.plans : w.coordinators).has(chatId)).toBe(true)
  },
)

test('restarting a working chat returns the Mac’s refusal', async () => {
  expect(
    await call(context(world()), {
      route: 'chat-retry',
      chatKind: 'coordinator',
      chatId: 'c-busy',
    }),
  ).toEqual({ code: 'refused', message: 'The Coordinator has not failed' })
  expect(
    await call(context(world()), { route: 'chat-retry', chatKind: 'plan', chatId: 'p-live' }),
  ).toEqual({ code: 'refused', message: 'only a planning chat whose Run ended can be resumed' })
})

test('chat-agents lists the picker’s Agents in its order, with the Planner marked', async () => {
  const w = world()
  const ctx = context(w)
  const { agents } = parsePhoneChatAgentsBody(
    body(await call(ctx, { route: 'chat-agents', factory: 'NB' })),
  )
  expect(agents.map((each) => [each.id, each.planner])).toEqual([
    ['coordinator', false],
    ['planner', true],
    ['auditor', false],
    ['reviewer', false],
  ])
  expect(agents[0]?.description).toBe('Recommends what to do next and acts on Tasks when you ask.')
  expect(agents[2]?.description).toBe('')
  expect(agents[3]?.description).toContain('Reviews')
  expect(JSON.stringify(agents)).not.toContain(secret)
  expect(await call(ctx, { route: 'chat-agents', factory: 'ZZ' })).toEqual({ code: 'gone' })
})

test('chat-create starts a planning chat for the Planner and a Coordinator chat for any other Agent', async () => {
  const w = world()
  const ctx = context(w)
  const planned = parsePhoneChatCreatedBody(
    body(
      await call(ctx, {
        route: 'chat-create',
        factory: 'NB',
        agentId: 'planner',
        text: 'Plan the phone field',
        createId: createId(),
      }),
    ),
  )
  expect(planned).toEqual({ chat: { kind: 'plan', id: 'p-new-1' } })
  expect(w.plansStarted).toEqual([
    { input: { factory: 'NB', message: 'Plan the phone field' }, caller },
  ])
  const chat = parsePhoneChatCreatedBody(
    body(
      await call(ctx, {
        route: 'chat-create',
        factory: 'NB',
        agentId: 'reviewer',
        text: 'Review the branch',
        createId: createId(),
      }),
    ),
  )
  expect(chat).toEqual({ chat: { kind: 'coordinator', id: 'c-new-1' } })
  expect(w.started).toEqual([
    { factoryId: 'notebook', input: { text: 'Review the branch', agentId: 'reviewer' } },
  ])
  const base = { route: 'chat-create', text: 'Hi' } as const
  expect(
    await call(ctx, { ...base, factory: 'ZZ', agentId: 'coordinator', createId: createId() }),
  ).toEqual({ code: 'gone' })
  expect(
    await call(ctx, { ...base, factory: 'NB', agentId: 'nobody', createId: createId() }),
  ).toEqual({ code: 'refused', message: 'This Factory has no Agent' })
})

test('a repeated chat-create createId starts one chat and returns it, even after a restart', async () => {
  const w = world()
  const ctx = context(w)
  const request = {
    route: 'chat-create',
    factory: 'NB',
    agentId: 'coordinator',
    text: 'Start once',
    createId: createId(),
  } as const
  const [first, second] = await Promise.all([call(ctx, request), call(ctx, request)])
  expect(body(first)).toEqual({ chat: { kind: 'coordinator', id: 'c-new-1' } })
  expect(body(second)).toEqual(body(first))
  expect(body(await call(ctx, request))).toEqual(body(first))
  await store.close()
  store = await openStore({ directory: dir })
  expect(body(await call(context(w), request))).toEqual(body(first))
  expect(w.started).toHaveLength(1)
})

test('the write routes refuse a request missing a field', async () => {
  const ctx = context(world())
  for (const route of [
    'chat-message',
    'chat-stop',
    'chat-agents',
    'chat-create',
    ...phoneChatChangeRoutes,
  ]) {
    expect(await call(ctx, { route })).toEqual({ code: 'bad-request' })
  }
})

function summary(id: string, extra: Partial<CoordinatorChatSummary>): CoordinatorChatSummary {
  return {
    id,
    factoryId: 'notebook',
    title: id,
    status: 'ready',
    startedAt: '2026-11-01T00:00:00.000Z',
    lastAt: '2026-11-01T00:00:00.000Z',
    taskCount: 0,
    waiting: false,
    chatAgent: agent('coordinator', 'Coordinator'),
    ...extra,
  }
}

function runChat(state: RunChat['run']['state']): RunChat {
  return {
    run: {
      id: 'p-live',
      name: 'Planner',
      role: 'run',
      agent: 'claude',
      state,
      startedAt: '2026-11-10T09:00:00.000Z',
      current: true,
    },
    items: [
      { kind: 'human', id: 'sent', text: 'First', at: '2026-11-10T09:01:00.000Z', sent: true },
      {
        kind: 'human',
        id: 'waiting',
        text: 'Second',
        at: '2026-11-10T09:02:00.000Z',
        sent: false,
        queued: true,
      },
    ],
  }
}

test('the chat row says whether the phone can write or stop, and a waiting message is queued', async () => {
  const plans = [
    plan('p-live', 'working'),
    (({ runId: _, ...rest }) => rest)(plan('p-queued', 'queued')),
    plan('p-resumable', 'stopped', { canResume: true }),
    plan('p-final', 'failed', { canResume: false }),
    plan('p-archived', 'finished', { archivedAt: '2026-11-02T00:00:00.000Z', canResume: true }),
  ]
  let run = runChat('working')
  const source: PhoneChatSource = {
    factories: () => [
      { id: 'notebook', name: 'Notebook', position: 0, createdAt: '2026-01-01T00:00:00.000Z' },
    ],
    coordinatorChats: async () => [
      summary('c-working', { status: 'working' }),
      summary('c-ready', { status: 'ready' }),
      summary('c-failed', { status: 'failed' }),
      summary('c-removed', { chatAgent: agent('gone', 'Gone', { removed: true }) }),
      summary('c-archived', { status: 'working', endedAt: '2026-11-02T00:00:00.000Z' }),
    ],
    plans: async () => plans,
    coordinatorChat: async () => undefined,
    plan: async (id) => {
      const found = plans.find((each) => each.id === id)
      return found && { detail: { plan: found, requests: [], tasks: [] }, chat: run }
    },
  }
  const chats = createPhoneChats(source)
  const rows = [
    ...parsePhoneChatsBody(body(await chats.list(undefined, false, undefined))).rows,
    ...parsePhoneChatsBody(body(await chats.list(undefined, true, undefined))).rows,
  ]
  const actions = (id: string) => rows.find((row) => row.id === id)?.actions
  expect(actions('c-working')).toEqual(['stop', 'rename', 'archive', 'delete'])
  expect(actions('c-ready')).toEqual(['rename', 'archive', 'delete'])
  expect(actions('c-failed')).toEqual(['retry', 'rename', 'archive', 'delete'])
  expect(actions('c-archived')).toEqual(['unarchive', 'delete'])
  expect(actions('p-resumable')).toEqual(['resume', 'rename', 'archive', 'delete'])
  expect(actions('p-archived')).toEqual(['unarchive', 'delete'])
  const state = (id: string) => {
    const row = rows.find((each) => each.id === id)
    return row && { send: row.send, offReason: row.offReason, canStop: row.canStop }
  }
  expect(state('c-working')).toEqual({ send: 'live', canStop: true })
  expect(state('c-ready')).toEqual({ send: 'live', canStop: false })
  expect(state('c-failed')).toEqual({
    send: 'off',
    offReason: 'This chat failed. Retry it to send a message.',
    canStop: false,
  })
  expect(state('c-removed')).toMatchObject({ send: 'off', canStop: false })
  expect(state('c-archived')).toEqual({
    send: 'off',
    offReason: 'This chat is archived.',
    canStop: false,
  })
  expect(state('p-live')).toEqual({ send: 'live', canStop: true })
  expect(state('p-queued')).toMatchObject({ send: 'off', canStop: true })
  expect(state('p-resumable')).toEqual({ send: 'resume', canStop: false })
  expect(state('p-final')).toEqual({
    send: 'off',
    offReason: 'This planning chat has ended.',
    canStop: false,
  })
  expect(state('p-archived')).toEqual({
    send: 'off',
    offReason: 'This chat is archived.',
    canStop: false,
  })

  const items = async () =>
    parsePhoneChatItemsBody(body(await chats.items('plan', 'p-live', undefined))).items
  const human = async (id: string) => (await items()).find((each) => each.id === id)
  expect(await human('waiting')).toMatchObject({ kind: 'human', queued: true })
  expect(await human('sent')).not.toHaveProperty('queued')
  run = runChat('finished')
  const ended = await human('waiting')
  expect(ended).toMatchObject({ kind: 'human', unsent: true })
  expect(ended).not.toHaveProperty('queued')
})
