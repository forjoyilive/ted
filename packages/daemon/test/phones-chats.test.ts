import {
  type ChatAgent,
  type ChatItem,
  type Coordinator,
  type CoordinatorChatSummary,
  encodeChatItemsCursor,
  encodeTasksCursor,
  type PhoneChatDetailLine,
  type PhoneChatItem,
  type PhoneChatKind,
  type PhoneChatRow,
  type Plan,
  type PlanDetail,
  type PlanRequest,
  parsePhoneChatBody,
  parsePhoneChatItemBody,
  parsePhoneChatItemsBody,
  parsePhoneChatsBody,
  phoneChatLineMax,
  phoneChatTextMax,
  phoneReplyBodyMax,
  type RunChat,
} from '@ted/protocol'
import { expect, test } from 'vitest'
import { createPhoneChats, type PhoneChatSource } from '../src/phones/chats.ts'
import type { PhoneOutcome } from '../src/phones/requests.ts'
import { type PhoneRouteContext, phoneRoutes } from '../src/phones/routes.ts'
import type { PhoneTaskFactory } from '../src/phones/tasks.ts'

const secret = `ghp_${'a1B2c3D4e5'.repeat(3)}`

const factories: PhoneTaskFactory[] = [
  {
    id: 'shop',
    name: 'Shop',
    icon: { kind: 'emoji', emoji: '🛒' },
    position: 1,
    createdAt: '2026-01-02T00:00:00.000Z',
  },
  {
    id: 'notebook',
    name: 'Notebook',
    icon: { kind: 'letter', color: 'teal' },
    position: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  { id: 'empty', name: 'Empty', position: 2, createdAt: '2026-01-03T00:00:00.000Z' },
]

const agent = (name: string): ChatAgent => ({
  id: name.toLowerCase(),
  name,
  source: 'ted',
  powers: [],
  removed: false,
})

function summary(id: string, extra: Partial<CoordinatorChatSummary> = {}): CoordinatorChatSummary {
  return {
    id,
    factoryId: 'notebook',
    title: `Chat ${id}`,
    status: 'ready',
    startedAt: '2026-11-01T00:00:00.000Z',
    lastAt: '2026-11-01T00:00:00.000Z',
    taskCount: 0,
    waiting: false,
    chatAgent: agent('Coordinator'),
    ...extra,
  }
}

function plan(id: string, extra: Partial<Plan> = {}): Plan {
  return {
    id,
    factoryId: 'shop',
    factoryKey: 'SH',
    title: `Plan ${id}`,
    message: 'Plan it',
    agent: 'claude',
    status: 'idle',
    createdAt: '2026-11-01T00:00:00.000Z',
    lastAt: '2026-11-01T00:00:00.000Z',
    createdTasks: 0,
    chatAgent: agent('Planner'),
    ...extra,
  }
}

function runChat(items: ChatItem[], state: RunChat['run']['state'] = 'idle'): RunChat {
  return {
    run: {
      id: 'run-1',
      name: 'Coordinator',
      role: 'run',
      agent: 'claude',
      state,
      startedAt: '2026-11-10T09:00:00.000Z',
      current: true,
    },
    items,
  }
}

function coordinatorState(id: string, extra: Partial<Coordinator> = {}): Coordinator {
  return {
    id,
    factoryId: 'notebook',
    runId: 'run-1',
    runIds: ['run-1'],
    started: true,
    opening: 'Hello',
    title: `Chat ${id}`,
    startedAt: '2026-11-10T09:00:00.000Z',
    lead: { agent: 'claude' },
    status: 'ready',
    unsentMessages: [],
    receipts: [],
    confirmations: [],
    automationCards: [],
    requests: [],
    tasks: [],
    chatAgent: agent('Coordinator'),
    ...extra,
  } as Coordinator
}

interface World {
  chats: CoordinatorChatSummary[]
  plans: Plan[]
  coordinators: Map<string, { coordinator: Coordinator; chat: RunChat }>
  details: Map<string, { detail: PlanDetail; chat: RunChat | undefined }>
}

function source(world: World): PhoneChatSource {
  return {
    factories: () => factories,
    coordinatorChats: async () => world.chats,
    plans: async () => world.plans,
    coordinatorChat: async (id) => world.coordinators.get(id),
    plan: async (id) => world.details.get(id),
  }
}

function emptyWorld(): World {
  return { chats: [], plans: [], coordinators: new Map(), details: new Map() }
}

function body(outcome: PhoneOutcome) {
  if (!('body' in outcome)) throw new Error(`refused: ${outcome.code}`)
  expect(Buffer.byteLength(JSON.stringify(outcome.body))).toBeLessThanOrEqual(phoneReplyBodyMax)
  return outcome.body
}

function code(outcome: PhoneOutcome): string | undefined {
  return 'code' in outcome ? outcome.code : undefined
}

const minute = (n: number) => new Date(Date.UTC(2026, 10, 20, 9, n)).toISOString()

test('the list holds every Factory’s chats newest first, with archived chats apart', async () => {
  const world = emptyWorld()
  world.chats = [
    summary('c-working', { status: 'working', lastAt: minute(5) }),
    summary('c-waiting', { status: 'working', waiting: true, lastAt: minute(9) }),
    summary('c-paused', { factoryId: 'shop', status: 'paused', lastAt: minute(3) }),
    summary('c-gone', { endedAt: minute(1), waiting: true, lastAt: minute(8) }),
    summary('c-untitled', { title: '', chatAgent: agent('Reviewer'), lastAt: minute(2) }),
  ]
  world.plans = [
    plan('p-queued', { status: 'queued', queuePlace: 3, lastAt: minute(7) }),
    plan('p-open', { status: 'working', openRequest: true, lastAt: minute(6) }),
    plan('p-paused', { status: 'paused', lastAt: minute(4) }),
    plan('p-done', { status: 'finished', archivedAt: minute(2), lastAt: minute(10) }),
    plan('p-finished', { status: 'finished', lastAt: minute(5) }),
  ]
  const chats = createPhoneChats(source(world))

  const open = parsePhoneChatsBody(body(await chats.list(undefined, false, undefined)))
  expect(open.rows.map((row) => row.id)).toEqual([
    'c-waiting',
    'p-queued',
    'p-open',
    'c-working',
    'p-finished',
    'p-paused',
    'c-paused',
    'c-untitled',
  ])
  expect(open.archivedCount).toBe(2)
  expect(open.cursor).toBeUndefined()
  expect(open.factories).toEqual([
    { id: 'notebook', name: 'Notebook', icon: { kind: 'letter', color: 'teal' } },
    { id: 'shop', name: 'Shop', icon: { kind: 'emoji', emoji: '🛒' } },
  ])
  const by = (id: string) => open.rows.find((row) => row.id === id)
  expect(by('c-waiting')).toMatchObject({
    kind: 'coordinator',
    status: 'Waiting on you',
    tone: 'waiting',
    waiting: true,
    agent: 'Coordinator',
    factory: { id: 'notebook', name: 'Notebook' },
  })
  expect(by('c-working')).toMatchObject({ status: 'Working', tone: 'working', waiting: false })
  expect(by('c-paused')).toMatchObject({ status: 'Paused', tone: 'waiting' })
  expect(by('c-untitled')).toMatchObject({
    title: 'Reviewer chat',
    agent: 'Reviewer',
    status: 'Ready',
    tone: 'none',
  })
  expect(by('p-queued')).toMatchObject({
    kind: 'plan',
    status: 'Queued · 3rd',
    tone: 'working',
    agent: 'Planner',
  })
  expect(by('p-open')).toMatchObject({ status: 'Working', waiting: true })
  expect(by('p-paused')).toMatchObject({ status: 'Paused · usage limit', tone: 'waiting' })
  expect(by('p-finished')).toMatchObject({ status: 'Finished', tone: 'done', waiting: false })

  const archived = parsePhoneChatsBody(body(await chats.list(undefined, true, undefined)))
  expect(archived.rows.map((row) => row.id)).toEqual(['p-done', 'c-gone'])
  expect(archived.rows.every((row) => row.archived && row.status === 'Archived')).toBe(true)
  expect(archived.rows.every((row) => !row.waiting && row.tone === 'stopped')).toBe(true)
  expect(archived.archivedCount).toBe(2)

  const shop = parsePhoneChatsBody(body(await chats.list('shop', false, undefined)))
  expect(shop.rows.map((row) => row.id)).toEqual([
    'p-queued',
    'p-open',
    'p-finished',
    'p-paused',
    'c-paused',
  ])
  expect(shop.archivedCount).toBe(1)
  expect(shop.factories.map((factory) => factory.id)).toEqual(['notebook', 'shop'])
  const unknown = parsePhoneChatsBody(body(await chats.list('nowhere', false, undefined)))
  expect(unknown).toMatchObject({ rows: [], archivedCount: 0 })

  const one = parsePhoneChatBody(body(await chats.read('plan', 'p-open')))
  expect(one.chat).toEqual(by('p-open'))
  expect(code(await chats.read('coordinator', 'p-open'))).toBe('gone')
  expect(code(await chats.read('plan', 'missing'))).toBe('gone')
})

test('the list pages by cursor, redacts secrets and refuses a bad cursor', async () => {
  const world = emptyWorld()
  world.chats = Array.from({ length: 300 }, (_, n) =>
    summary(`c-${String(n).padStart(3, '0')}`, {
      title: `${'Long title '.repeat(40)} ${secret}`,
      lastAt: minute(n % 60),
    }),
  )
  const chats = createPhoneChats(source(world))
  const seen: PhoneChatRow[] = []
  let cursor: string | undefined
  let pages = 0
  do {
    const page = parsePhoneChatsBody(body(await chats.list(undefined, false, cursor)))
    seen.push(...page.rows)
    cursor = page.cursor
    pages++
  } while (cursor !== undefined)
  expect(pages).toBeGreaterThan(1)
  expect(seen.map((row) => row.id).toSorted()).toEqual(
    world.chats.map((chat) => chat.id).toSorted(),
  )
  expect(new Set(seen.map((row) => row.id)).size).toBe(300)
  expect(seen.every((row) => row.title.length <= 500)).toBe(true)
  expect(JSON.stringify(seen)).not.toContain(secret)
  expect(code(await chats.list(undefined, false, 'not-a-cursor'))).toBe('bad-request')
  const taskCursor = encodeTasksCursor({
    section: 0,
    priority: 0,
    rank: 0,
    createdAt: 'a',
    taskId: 'b',
  })
  expect(code(await chats.list(undefined, false, taskCursor))).toBe('bad-request')
  const itemsCursor = encodeChatItemsCursor({ chatKind: 'plan', itemId: 'x' })
  expect(code(await chats.list(undefined, false, itemsCursor))).toBe('bad-request')
})

async function everyItem(
  chats: ReturnType<typeof createPhoneChats>,
  kind: PhoneChatKind,
  id: string,
): Promise<PhoneChatItem[][]> {
  const pages: PhoneChatItem[][] = []
  let before: string | undefined
  do {
    const page = parsePhoneChatItemsBody(body(await chats.items(kind, id, before)))
    pages.push(page.items)
    before = page.cursor
  } while (before !== undefined)
  return pages
}

test('chat-items pages a Coordinator chat back from the newest item, merged with its cards', async () => {
  const world = emptyWorld()
  const items: ChatItem[] = [
    { kind: 'instructions', id: 'instructions', text: 'Ted’s rules', lines: 1, at: minute(0) },
    {
      kind: 'human',
      id: 'h0',
      text: `Please look ${secret}`,
      at: minute(1),
      sent: true,
      attachments: [
        { hash: 'a', name: 'shot.png', size: 1, mediaType: 'image/png' },
        { hash: 'b', name: 'notes.txt', size: 1, mediaType: 'text/plain' },
      ],
    },
    ...Array.from(
      { length: 60 },
      (_, n): ChatItem => ({
        kind: 'agent',
        id: `a${n}`,
        text: `${n} ${'word '.repeat(1_000)}`,
        at: minute(2 + Math.floor(n / 2)),
      }),
    ),
    { kind: 'interrupted', id: 'stop', at: minute(40) },
    {
      kind: 'command',
      id: 'cmd',
      name: 'test',
      status: 'failed',
      exitCode: 1,
      output: 'one\ntwo\n',
      at: minute(41),
    },
    { kind: 'ted', id: 'new-run', title: 'New Run', text: 'The earlier Run ended', at: minute(42) },
  ]
  world.coordinators.set('c1', {
    coordinator: coordinatorState('c1', {
      receipts: [
        {
          id: 'receipt',
          operation: 'start',
          taskId: 'task-1',
          text: 'Started TED-788',
          at: minute(3),
          fingerprint: 'f',
        },
      ],
      confirmations: [
        {
          id: 'confirm',
          kind: 'archive',
          operation: 'o',
          fingerprint: 'f',
          askedAt: minute(10),
          tasks: [{ displayId: 'TED-1' }, { displayId: 'TED-2' }],
        },
      ],
      requests: [
        {
          id: 'question',
          chatId: 'c1',
          runId: 'run-1',
          kind: 'question',
          body: 'Which one?',
          createdAt: minute(41),
        },
      ],
      tasks: [{ id: 'task-1', displayId: 'TED-788' }],
    } as Partial<Coordinator>),
    chat: runChat(items),
  })
  world.chats = [summary('c1')]
  const chats = createPhoneChats(source(world))
  const pages = await everyItem(chats, 'coordinator', 'c1')
  expect(pages.length).toBeGreaterThan(1)
  expect(pages[0]?.at(-1)?.id).toBe('new-run')
  const all = pages.toReversed().flat()
  expect(all.map((item) => item.id)).toEqual([
    'h0',
    'a0',
    'a1',
    'a2',
    'a3',
    'receipt',
    ...Array.from({ length: 56 }, (_, n) => `a${n + 4}`).flatMap((id) =>
      id === 'a18' ? ['confirm', id] : [id],
    ),
    'stop',
    'cmd',
    'question',
    'new-run',
  ])
  expect(all.find((item) => item.id === 'h0')).toMatchObject({
    kind: 'human',
    images: ['shot.png'],
    files: 1,
    cut: false,
  })
  expect(JSON.stringify(all)).not.toContain(secret)
  expect(all.find((item) => item.id === 'receipt')).toEqual({
    id: 'receipt',
    at: minute(3),
    kind: 'action',
    text: 'Started TED-788',
    taskRef: 'TED-788',
  })
  expect(all.find((item) => item.id === 'confirm')).toMatchObject({
    kind: 'card',
    text: 'Archive 2 Tasks?',
    open: true,
  })
  expect(all.find((item) => item.id === 'question')).toMatchObject({
    kind: 'request',
    requestKind: 'Question',
    title: 'Question',
    text: 'Which one?',
    open: true,
  })
  expect(all.find((item) => item.id === 'cmd')).toMatchObject({
    kind: 'command',
    status: 'failed',
    exitCode: 1,
    lines: 2,
    detail: true,
  })
  const agentItem = all.find((item) => item.id === 'a0')
  expect(agentItem).toMatchObject({ kind: 'agent', agent: 'Coordinator', cut: true })
  if (agentItem?.kind !== 'agent') throw new Error('not an agent item')
  expect(agentItem.text.length).toBe(phoneChatTextMax)

  const whole = parsePhoneChatItemBody(body(await chats.item('coordinator', 'c1', 'a0', 0)))
  expect(whole.next).toBeUndefined()
  expect(whole.lines.map((line) => line.text).join('')).toBe(`0 ${'word '.repeat(1_000)}`)
  expect(whole.lines.every((line) => line.text.length <= phoneChatLineMax)).toBe(true)

  const stale = encodeChatItemsCursor({ chatKind: 'coordinator', itemId: 'deleted' })
  expect(code(await chats.items('coordinator', 'c1', stale))).toBe('gone')
  const otherKind = encodeChatItemsCursor({ chatKind: 'plan', itemId: 'a3' })
  expect(code(await chats.items('coordinator', 'c1', otherKind))).toBe('bad-request')
  expect(code(await chats.items('coordinator', 'c1', 'garbage!'))).toBe('bad-request')
  expect(code(await chats.items('coordinator', 'missing', undefined))).toBe('gone')
  expect(code(await chats.items('plan', 'c1', undefined))).toBe('gone')
  expect(code(await chats.item('coordinator', 'c1', 'no-such-item', 0))).toBe('gone')
  expect(code(await chats.item('coordinator', 'missing', 'a0', 0))).toBe('gone')
})

test('a tool call bigger than one reply reads to its end through chat-item offsets', async () => {
  const world = emptyWorld()
  const longLine = 'z'.repeat(phoneChatLineMax * 2 + 7)
  const outputLines = [
    ...Array.from({ length: 3_000 }, (_, n) => `line ${n} ${'x'.repeat(20)}`),
    longLine,
    `token ${secret}`,
  ]
  const output = outputLines.join('\n')
  const diffs = ['src/a.ts', 'src/b.ts'].map((path) => ({
    path,
    additions: 200,
    deletions: 200,
    lines: Array.from({ length: 400 }, (_, n) => ({
      kind: n % 2 === 0 ? ('added' as const) : ('removed' as const),
      text: `${path} change ${n}`,
    })),
    truncated: true,
  }))
  world.details.set('p1', {
    detail: {
      plan: plan('p1', { status: 'finished', finishedAt: minute(50), runId: 'run-1' }),
      requests: [
        {
          id: 'round',
          planId: 'p1',
          runId: 'run-1',
          kind: 'round',
          author: 'run',
          body: 'Answer these',
          round: { number: 2 },
          createdAt: minute(2),
        } as PlanRequest,
        {
          id: 'note',
          planId: 'p1',
          runId: 'run-1',
          kind: 'note',
          author: 'ted',
          body: 'Created 2 Tasks',
          createdAt: minute(3),
        },
      ],
      tasks: [],
    },
    chat: runChat([
      { kind: 'human', id: 'prompt', text: 'Plan it', at: minute(0), sent: true },
      {
        kind: 'tool',
        id: 'tool',
        tool: 'Edit',
        title: `Edit ${'t'.repeat(300)}`,
        status: 'done',
        detail: 'Changed two files',
        output,
        diffs,
        at: minute(1),
      },
    ]),
  })
  world.plans = [world.details.get('p1')?.detail.plan ?? plan('p1')]
  const chats = createPhoneChats(source(world))
  const items = (await everyItem(chats, 'plan', 'p1')).toReversed().flat()
  expect(items.map((item) => item.id)).toEqual(['prompt', 'tool', 'round', 'note', 'ended'])
  const tool = items.find((item) => item.id === 'tool')
  expect(tool).toMatchObject({
    kind: 'tool',
    tool: 'Edit',
    status: 'done',
    additions: 400,
    deletions: 400,
    lines: outputLines.length,
    detail: true,
  })
  if (tool?.kind !== 'tool') throw new Error('not a tool item')
  expect(tool.title.length).toBe(200)
  expect(items.find((item) => item.id === 'round')).toMatchObject({
    kind: 'request',
    requestKind: 'Round',
    title: 'Round 2',
    open: true,
  })
  expect(items.find((item) => item.id === 'note')).toMatchObject({
    requestKind: 'Note',
    open: false,
  })
  expect(items.find((item) => item.id === 'ended')).toMatchObject({
    kind: 'ted',
    title: 'Planning Run finished',
  })

  const lines: PhoneChatDetailLine[] = []
  let offset: number | undefined = 0
  let replies = 0
  while (offset !== undefined) {
    const page = parsePhoneChatItemBody(body(await chats.item('plan', 'p1', 'tool', offset)))
    expect(page.lines.length).toBeGreaterThan(0)
    lines.push(...page.lines)
    offset = page.next
    replies++
  }
  expect(replies).toBeGreaterThan(1)
  expect(lines.every((line) => line.text.length <= phoneChatLineMax)).toBe(true)
  const headings = lines.flatMap((line) => (line.kind === 'heading' ? [line.text] : []))
  expect(headings).toEqual(['Detail', 'src/a.ts +200 −200', 'src/b.ts +200 −200', 'Output'])
  const outputAt = lines.findIndex((line) => line.kind === 'heading' && line.text === 'Output')
  const shownOutput = lines.slice(outputAt + 1)
  expect(shownOutput.length).toBe(outputLines.length + 2)
  expect(shownOutput.slice(0, 3_000).map((line) => line.text)).toEqual(outputLines.slice(0, 3_000))
  expect(
    shownOutput
      .slice(3_000, 3_003)
      .map((line) => line.text)
      .join(''),
  ).toBe(longLine)
  expect(shownOutput.at(-1)?.text).toBe('token [redacted]')
  const diffA = lines.slice(3, 3 + 400)
  expect(diffA[0]).toEqual({ kind: 'added', text: '+src/a.ts change 0' })
  expect(diffA[1]).toEqual({ kind: 'removed', text: '-src/a.ts change 1' })
  expect(lines.filter((line) => line.text === 'Longer than shown')).toHaveLength(2)

  const past = parsePhoneChatItemBody(body(await chats.item('plan', 'p1', 'tool', 1_000_000)))
  expect(past).toEqual({ lines: [] })
  const nothing = parsePhoneChatItemBody(body(await chats.item('plan', 'p1', 'ended', 0)))
  expect(nothing.lines.map((line) => line.text)).toEqual(['Planning Run finished'])
})

test('the Chats routes refuse a request missing its chat', async () => {
  const chats = createPhoneChats(source(emptyWorld()))
  const context = { chats } as PhoneRouteContext
  const route = (name: string) => {
    const found = phoneRoutes.find((each) => each.name === name)
    if (!found) throw new Error(`no route ${name}`)
    return found
  }
  const caller = { kind: 'phone', phoneId: 'p' } as const
  const request = { protocol: 3, id: 'x', at: 1, type: 'request' } as const
  for (const name of ['chat', 'chat-items', 'chat-item']) {
    const outcome = await route(name).handle(caller, { ...request, route: name }, context)
    expect(code(outcome)).toBe('bad-request')
  }
  const listed = await route('chats').handle(caller, { ...request, route: 'chats' }, context)
  expect(parsePhoneChatsBody(body(listed))).toEqual({ factories: [], rows: [], archivedCount: 0 })
})
